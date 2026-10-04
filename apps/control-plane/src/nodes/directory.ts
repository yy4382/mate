import { NodeRequestIdSchema, NodeRequestSchema, type NodeRequest } from "@mate/protocol";
import type { NodeSummary } from "@mate/protocol/owner";
import type Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { recordAgentActivity } from "../runtime/activity.js";
import { isEd25519PublicKey, NodeIdentity, verifySignature } from "./identity.js";
import { NodeOperations } from "./operations.js";
import { NodeReconciliation } from "./reconciliation.js";
import { reject, send, type NodeSocket, type SocketSession } from "./transport.js";
export { NodeAccountConflict, nodeAccountOf, type NodeAccount } from "./identity.js";
export type { NodeWorkspaceOperationStart } from "./operations.js";
export type { NodeSocket } from "./transport.js";

export const DEFAULT_NODE_PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_NODE_MAX_CONNECTIONS = 128;
export const DEFAULT_NODE_MAX_UNAUTHENTICATED_CONNECTIONS = 32;
export const DEFAULT_NODE_HANDSHAKE_TIMEOUT_MS = 10_000;
export const DEFAULT_NODE_HEARTBEAT_TIMEOUT_MS = 35_000;
export const DEFAULT_NODE_OPERATION_TIMEOUT_MS = 60_000;
export const DEFAULT_NODE_PROCESS_OPERATION_TIMEOUT_MS = 75_000;

// Scan roughly four times per timeout, bounded to avoid busy timers or slow expiry checks.
const minHeartbeatSweepIntervalMs = 10;
const maxHeartbeatSweepIntervalMs = 1_000;
const sweepsPerHeartbeatWindow = 4;

export interface NodeDirectoryOptions {
  now?: () => number;
  pairingTokenTtlMs?: number;
  maxConnections?: number;
  maxUnauthenticatedConnections?: number;
  handshakeTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  operationTimeoutMs?: number;
  processOperationTimeoutMs?: number;
}

/** Owns socket lifecycle, the current connection and heartbeat; assembles node capabilities. */
export class NodeDirectory {
  private readonly identity: NodeIdentity;
  private readonly operations: NodeOperations;
  private readonly reconciliation: NodeReconciliation;
  private readonly now: () => number;
  private readonly pairingTokenTtlMs: number;
  private readonly maxConnections: number;
  private readonly maxUnauthenticatedConnections: number;
  private readonly handshakeTimeoutMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly operationTimeoutMs: number;
  private readonly processOperationTimeoutMs: number;
  private readonly heartbeatSweepTimer: ReturnType<typeof setInterval>;
  private readonly sessions = new WeakMap<NodeSocket, SocketSession>();
  private readonly connected = new Map<string, NodeSocket>();
  private readonly sockets = new Set<NodeSocket>();
  private readonly unauthenticated = new Set<NodeSocket>();
  private onOffline?: (nodeId: string) => void;

  constructor(
    private readonly database: Database.Database,
    options: NodeDirectoryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.pairingTokenTtlMs = options.pairingTokenTtlMs ?? DEFAULT_NODE_PAIRING_TOKEN_TTL_MS;
    if (!Number.isSafeInteger(this.pairingTokenTtlMs) || this.pairingTokenTtlMs < 1)
      throw new Error("Node pairing token lifetime must be a positive integer");
    this.maxConnections = positiveInteger(options.maxConnections, DEFAULT_NODE_MAX_CONNECTIONS);
    this.maxUnauthenticatedConnections = positiveInteger(
      options.maxUnauthenticatedConnections,
      DEFAULT_NODE_MAX_UNAUTHENTICATED_CONNECTIONS,
    );
    this.handshakeTimeoutMs = positiveInteger(
      options.handshakeTimeoutMs,
      DEFAULT_NODE_HANDSHAKE_TIMEOUT_MS,
    );
    this.heartbeatTimeoutMs = positiveInteger(
      options.heartbeatTimeoutMs,
      DEFAULT_NODE_HEARTBEAT_TIMEOUT_MS,
    );
    this.operationTimeoutMs = positiveInteger(
      options.operationTimeoutMs,
      DEFAULT_NODE_OPERATION_TIMEOUT_MS,
    );
    this.processOperationTimeoutMs = positiveInteger(
      options.processOperationTimeoutMs,
      DEFAULT_NODE_PROCESS_OPERATION_TIMEOUT_MS,
    );
    if (this.maxUnauthenticatedConnections > this.maxConnections)
      throw new Error("Unauthenticated node connection limit cannot exceed the total limit");
    this.identity = new NodeIdentity(database, this.now, this.pairingTokenTtlMs);
    const isCurrent = (nodeId: string, socket: NodeSocket) => this.connected.get(nodeId) === socket;
    this.operations = new NodeOperations(
      (nodeId, requireReady) => {
        const socket = this.connected.get(nodeId);
        const session = socket ? this.sessions.get(socket) : undefined;
        return socket &&
          session?.nodeId === nodeId &&
          (!requireReady || session.ready) &&
          !(this.now() - session.lastHeartbeatAt >= this.heartbeatTimeoutMs)
          ? socket
          : undefined;
      },
      isCurrent,
      this.operationTimeoutMs,
      this.processOperationTimeoutMs,
    );
    this.reconciliation = new NodeReconciliation(database, this.operations, isCurrent);
    const sweepIntervalMs = Math.max(
      minHeartbeatSweepIntervalMs,
      Math.min(
        maxHeartbeatSweepIntervalMs,
        Math.floor(this.heartbeatTimeoutMs / sweepsPerHeartbeatWindow),
      ),
    );
    this.heartbeatSweepTimer = setInterval(() => this.expireInactiveConnections(), sweepIntervalMs);
    this.heartbeatSweepTimer.unref?.();
  }

  createPairingToken(): ReturnType<NodeIdentity["createPairingToken"]> {
    return this.identity.createPairingToken();
  }
  /**
   * The one ordinary Linux account every Agent on this node runs under, or undefined before the
   * node's first successful workspace preparation recorded it.
   */
  account(nodeId: string): ReturnType<NodeIdentity["account"]> {
    return this.identity.account(nodeId);
  }
  /**
   * Record this node's account on its first successful workspace preparation, and require every
   * later Agent on the same node to report the same account. Meant to run inside the caller's
   * transaction: a mismatch throws so the Agent's workspace, stage and channel invitation roll back
   * together instead of leaving a partially prepared Agent behind.
   */
  recordAccount(nodeId: string, account: Parameters<NodeIdentity["recordAccount"]>[1]): void {
    this.identity.recordAccount(nodeId, account);
  }
  provisionAgent(
    ...args: Parameters<NodeOperations["provisionAgent"]>
  ): ReturnType<NodeOperations["provisionAgent"]> {
    return this.operations.provisionAgent(...args);
  }
  /** Send one owner read, Agent file action, or Agent publication read to its paired node. */
  workspaceOperation(
    ...args: Parameters<NodeOperations["workspaceOperation"]>
  ): ReturnType<NodeOperations["workspaceOperation"]> {
    return this.operations.workspaceOperation(...args);
  }
  executeAgentProcessOperation(
    ...args: Parameters<NodeOperations["executeAgentProcessOperation"]>
  ): ReturnType<NodeOperations["executeAgentProcessOperation"]> {
    return this.operations.executeAgentProcessOperation(...args);
  }
  setWorkspaceOperationResultHandler(
    handler: Parameters<NodeOperations["setWorkspaceOperationResultHandler"]>[0],
  ): void {
    this.operations.setWorkspaceOperationResultHandler(handler);
  }

  list(): NodeSummary[] {
    const rows = z
      .looseObject({ id: z.string(), last_connected_at: z.number().nullable() })
      .array()
      .parse(
        this.database
          .prepare("SELECT id, last_connected_at FROM nodes ORDER BY paired_at, id")
          .all(),
      );
    const now = this.now();
    return rows.map((row) => {
      const socket = this.connected.get(row.id);
      const session = socket ? this.sessions.get(socket) : undefined;
      return {
        id: row.id,
        online:
          session?.nodeId === row.id &&
          session.ready === true &&
          now - session.lastHeartbeatAt < this.heartbeatTimeoutMs,
        lastConnectedAt:
          row.last_connected_at === null ? null : new Date(row.last_connected_at).toISOString(),
      };
    });
  }

  open(socket: NodeSocket): void {
    if (
      this.sockets.size >= this.maxConnections ||
      this.unauthenticated.size >= this.maxUnauthenticatedConnections
    ) {
      socket.close(1013, "节点连接数已达上限");
      return;
    }
    const nonce = randomBytes(32).toString("base64url");
    const session: SocketSession = { nonce, lastHeartbeatAt: this.now() };
    session.handshakeTimeout = setTimeout(() => {
      if (this.sessions.get(socket) === session && !session.nodeId)
        reject(socket, undefined, "malformed_request", "节点身份验证超时。");
    }, this.handshakeTimeoutMs);
    this.sessions.set(socket, session);
    this.sockets.add(socket);
    this.unauthenticated.add(socket);
    send(socket, { type: "control.challenge", nonce });
  }

  async receive(socket: NodeSocket, messageData: unknown): Promise<void> {
    const session = this.sessions.get(socket);
    if (!session) return reject(socket, undefined, "malformed_request", "连接尚未初始化。");

    let parsedMessage: unknown;
    try {
      parsedMessage = JSON.parse(await messageText(messageData));
    } catch {
      return reject(socket, undefined, "malformed_request", "请求格式无效。");
    }
    const parsed = NodeRequestSchema.safeParse(parsedMessage);
    if (!parsed.success) {
      const requestId =
        typeof parsedMessage === "object" && parsedMessage !== null && "requestId" in parsedMessage
          ? parsedMessage.requestId
          : undefined;
      return reject(
        socket,
        NodeRequestIdSchema.safeParse(requestId).success && typeof requestId === "string"
          ? requestId
          : undefined,
        "malformed_request",
        "请求格式无效。",
      );
    }

    const request = parsed.data;
    if (request.type === "node.authenticate") return this.authenticate(socket, session, request);
    if (request.type === "node.pair") return this.pair(socket, session, request);
    if (request.type === "node.ping") return this.ping(socket, session, request);
    if (request.type === "node.process.reconcile.result")
      return this.reconciliation.receiveProcess(socket, session, request);
    if (request.type === "node.workspace.reconcile.result")
      return this.reconciliation.receiveWorkspace(socket, session, request);
    if (request.type === "node.process.operation.result")
      return this.operations.receiveAgentProcessOperationResult(socket, session.nodeId, request);
    if (request.type === "node.workspace.operation.result")
      return this.operations.receiveWorkspaceOperationResult(socket, session.nodeId, request);
    return this.operations.receiveAgentProvisionMessage(socket, session.nodeId, request);
  }

  close(socket: NodeSocket): void {
    this.sockets.delete(socket);
    this.unauthenticated.delete(socket);
    const session = this.sessions.get(socket);
    if (session?.handshakeTimeout) clearTimeout(session.handshakeTimeout);
    const nodeId = session?.nodeId;
    if (nodeId && this.connected.get(nodeId) === socket) {
      recordAgentActivity(this.database, {
        nodeId,
        kind: "node.disconnected",
        summary: "节点已断开；显示最后确认的运行事实。",
        at: this.now(),
      });
      this.connected.delete(nodeId);
      this.onOffline?.(nodeId);
      this.operations.rejectForNode(nodeId);
    }
    this.sessions.delete(socket);
  }

  setOfflineHandler(handler: (nodeId: string) => void): void {
    this.onOffline = handler;
  }

  setProcessReceiptHandler(
    handler: Parameters<NodeOperations["setProcessReceiptHandler"]>[0],
    onReady: () => void,
  ): void {
    this.operations.setProcessReceiptHandler(handler);
    this.reconciliation.setReadyHandler(onReady);
  }

  activateAgent(nodeId: string, agentId: string): boolean {
    const socket = this.connected.get(nodeId),
      session = socket ? this.sessions.get(socket) : undefined;
    if (!socket || !session?.ready || session.nodeId !== nodeId) return false;
    try {
      send(socket, {
        type: "control.agent.activate",
        requestId: randomUUID(),
        agentId,
      });
      return true;
    } catch {
      return false;
    }
  }

  closeAll(): void {
    clearInterval(this.heartbeatSweepTimer);
    for (const socket of [...this.sockets]) {
      const session = this.sessions.get(socket);
      if (session?.handshakeTimeout) clearTimeout(session.handshakeTimeout);
      this.close(socket);
      socket.terminate();
    }
  }

  private authenticate(
    socket: NodeSocket,
    session: SocketSession,
    request: Extract<NodeRequest, { type: "node.authenticate" }>,
  ): void {
    if (session.nodeId)
      return reject(socket, request.requestId, "invalid_identity", "连接已完成身份验证。");
    const publicKey = this.identity.publicKey(request.nodeId);
    if (publicKey === undefined) {
      send(socket, {
        type: "control.error",
        requestId: request.requestId,
        code: "unknown_identity",
        message: "此节点身份尚未配对。",
      });
      return;
    }
    if (!verifySignature(publicKey, session.nonce, request.signature))
      return reject(socket, request.requestId, "invalid_identity", "节点身份验证失败。");

    this.markConnected(socket, session, request.nodeId);
    send(socket, {
      type: "control.authenticated",
      requestId: request.requestId,
      nodeId: request.nodeId,
    });
    this.reconciliation.startProcess(socket, session, "", true);
  }

  private pair(
    socket: NodeSocket,
    session: SocketSession,
    request: Extract<NodeRequest, { type: "node.pair" }>,
  ): void {
    if (session.nodeId)
      return reject(socket, request.requestId, "pairing_rejected", "配对令牌无效或已使用。");
    if (
      !isEd25519PublicKey(request.publicKey) ||
      !verifySignature(request.publicKey, session.nonce, request.signature)
    )
      return reject(socket, request.requestId, "invalid_identity", "节点身份验证失败。");

    if (!this.identity.pair(request))
      return reject(socket, request.requestId, "pairing_rejected", "配对令牌无效或已使用。");

    this.markConnected(socket, session, request.nodeId);
    send(socket, {
      type: "control.paired",
      requestId: request.requestId,
      nodeId: request.nodeId,
    });
    this.reconciliation.startProcess(socket, session, "", true);
  }

  private ping(
    socket: NodeSocket,
    session: SocketSession,
    request: Extract<NodeRequest, { type: "node.ping" }>,
  ): void {
    if (!session.nodeId || this.connected.get(session.nodeId) !== socket)
      return reject(socket, request.requestId, "not_authenticated", "节点尚未完成身份验证。");
    session.lastHeartbeatAt = this.now();
    send(socket, {
      type: "control.pong",
      requestId: request.requestId,
      acceptedAt: this.now(),
    });
    if (session.ready && !session.reconcile && !session.workspaceReconcile)
      this.reconciliation.startProcess(socket, session, "", false);
  }

  private markConnected(socket: NodeSocket, session: SocketSession, nodeId: string): void {
    if (session.handshakeTimeout) clearTimeout(session.handshakeTimeout);
    delete session.handshakeTimeout;
    this.unauthenticated.delete(socket);
    const previous = this.connected.get(nodeId);
    if (previous && previous !== socket) {
      this.close(previous);
      previous.terminate();
    }
    session.nodeId = nodeId;
    session.ready = false;
    session.lastHeartbeatAt = this.now();
    this.connected.set(nodeId, socket);
    this.database
      .prepare("UPDATE nodes SET last_connected_at=? WHERE id=?")
      .run(this.now(), nodeId);
    recordAgentActivity(this.database, {
      nodeId,
      kind: "node.connected",
      summary: "节点已连接，正在核对操作收据。",
      at: this.now(),
    });
  }

  private expireInactiveConnections(): void {
    const now = this.now();
    for (const [nodeId, socket] of this.connected) {
      const session = this.sessions.get(socket);
      if (
        !session ||
        session.nodeId !== nodeId ||
        now - session.lastHeartbeatAt < this.heartbeatTimeoutMs
      )
        continue;
      this.close(socket);
      socket.terminate();
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1)
    throw new Error("Node connection limits and timeouts must be positive integers");
  return result;
}

async function messageText(messageData: unknown): Promise<string> {
  if (typeof messageData === "string") return messageData;
  if (messageData instanceof ArrayBuffer) return Buffer.from(messageData).toString("utf8");
  if (ArrayBuffer.isView(messageData))
    return Buffer.from(messageData.buffer, messageData.byteOffset, messageData.byteLength).toString(
      "utf8",
    );
  if (typeof Blob !== "undefined" && messageData instanceof Blob) return messageData.text();
  throw new Error("Only text node requests are supported");
}
