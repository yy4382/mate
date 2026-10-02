import type { NodeSummary } from "@mate/protocol/owner";
import { z } from "zod";
import { processOperationRequestHash } from "@mate/protocol/node";
import {
  agentProcessOperationSchema,
  NodeControlMessageSchema,
  NodeRequestIdSchema,
  NodeRequestSchema,
  type NodeControlMessage,
  type NodeAgentProvisionResult,
  type NodeWorkspaceOperationResult,
  type ControlWorkspaceOperation,
  type AgentProvisionStage,
  type NodeRequest,
  type AgentProcessOperation,
  type AgentProcessOperationState,
} from "@mate/protocol";

import type Database from "better-sqlite3";
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";

import { recordAgentActivity } from "../runtime/activity.js";

export const DEFAULT_NODE_PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_NODE_MAX_CONNECTIONS = 128;
export const DEFAULT_NODE_MAX_UNAUTHENTICATED_CONNECTIONS = 32;
export const DEFAULT_NODE_HANDSHAKE_TIMEOUT_MS = 10_000;
export const DEFAULT_NODE_HEARTBEAT_TIMEOUT_MS = 35_000;
export const DEFAULT_NODE_OPERATION_TIMEOUT_MS = 60_000;
export const DEFAULT_NODE_PROCESS_OPERATION_TIMEOUT_MS = 75_000;

export interface NodeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

interface SocketSession {
  nonce: string;
  lastHeartbeatAt: number;
  nodeId?: string;
  ready?: boolean;
  reconcile?: {
    requestId: string;
    operations: Map<string, string>;
    cursor: string;
    blocking: boolean;
  };
  workspaceReconcile?: {
    requestId: string;
    operations: Map<string, string>;
    cursor: string;
    blocking: boolean;
  };
  handshakeTimeout?: ReturnType<typeof setTimeout>;
}

/** The one ordinary Linux account a paired node runs every one of its Agents under. */
export interface NodeAccount {
  username: string;
  uid: number;
  gid: number;
}

/** A node reported an account that is not the one its Agents already run under. */
export class NodeAccountConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeAccountConflict";
  }
}

/**
 * A complete account read from node columns, or undefined while the node has not completed a
 * preparation yet. Rows read through a LEFT JOIN carry all three columns as nullable, so this is
 * the one place that decides whether a partial row counts as an account at all.
 */
export function nodeAccountOf(row: {
  linux_username: string | null;
  uid: number | null;
  gid: number | null;
}): NodeAccount | undefined {
  if (row.linux_username === null || row.uid === null || row.gid === null) return undefined;
  return { username: row.linux_username, uid: row.uid, gid: row.gid };
}

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

interface PendingAgentProvision {
  nodeId: string;
  agentId: string;
  onProgress: (stage: AgentProvisionStage) => void;
  promise: Promise<NodeAgentProvisionResult>;
  resolve: (result: NodeAgentProvisionResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingAgentProcessOperation {
  nodeId: string;
  agentId: string;
  operationId: string;
  promise: Promise<{
    operationId: string;
    agentId: string;
    state: Exclude<AgentProcessOperationState, "started">;
    receipt: unknown | null;
    revision?: number;
  }>;
  resolve: (result: {
    operationId: string;
    agentId: string;
    state: Exclude<AgentProcessOperationState, "started">;
    receipt: unknown | null;
    revision?: number;
  }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export type NodeWorkspaceOperationStart = ControlWorkspaceOperation;

interface PendingWorkspaceOperation {
  nodeId: string;
  operationId: string;
  agentId: string;
  promise: Promise<NodeWorkspaceOperationResult>;
  resolve: (result: NodeWorkspaceOperationResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/** Pairing credentials and durable node identities for this control plane. */
export class NodeDirectory {
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
  private readonly pendingAgentProvisions = new Map<string, PendingAgentProvision>();
  private readonly pendingAgentProcessOperations = new Map<string, PendingAgentProcessOperation>();
  private readonly pendingWorkspaceOperations = new Map<string, PendingWorkspaceOperation>();
  private workspaceOperationResultHandler?: (
    nodeId: string,
    result: NodeWorkspaceOperationResult,
  ) => void;
  private processReceiptHandler?: (
    nodeId: string,
    receipt: {
      operationId: string;
      agentId: string;
      state: "succeeded" | "failed" | "unknown";
      receipt: unknown | null;
      revision?: number;
    },
  ) => void;
  private onReady?: () => void;
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
    const sweepIntervalMs = Math.max(10, Math.min(1000, Math.floor(this.heartbeatTimeoutMs / 4)));
    this.heartbeatSweepTimer = setInterval(() => this.expireInactiveConnections(), sweepIntervalMs);
    this.heartbeatSweepTimer.unref?.();
  }

  createPairingToken(): { pairingToken: string; expiresAt: string } {
    const createdAt = this.now();
    const expiresAt = createdAt + this.pairingTokenTtlMs;
    const pairingToken = randomBytes(32).toString("base64url");
    this.database
      .prepare("INSERT INTO node_pairing_tokens(token_hash, created_at, expires_at) VALUES(?,?,?)")
      .run(hashToken(pairingToken), createdAt, expiresAt);
    return { pairingToken, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * The one ordinary Linux account every Agent on this node runs under, or undefined before the
   * node's first successful workspace preparation recorded it.
   */
  account(nodeId: string): NodeAccount | undefined {
    const row = z
      .looseObject({ linux_username: z.string(), uid: z.number(), gid: z.number() })
      .optional()
      .parse(
        this.database
          .prepare(
            "SELECT linux_username,uid,gid FROM nodes WHERE id=? AND linux_username IS NOT NULL AND uid IS NOT NULL AND gid IS NOT NULL",
          )
          .get(nodeId),
      );
    return row ? { username: row.linux_username, uid: row.uid, gid: row.gid } : undefined;
  }

  /**
   * Record this node's account on its first successful workspace preparation, and require every
   * later Agent on the same node to report the same account. Meant to run inside the caller's
   * transaction: a mismatch throws so the Agent's workspace, stage and channel invitation roll back
   * together instead of leaving a partially prepared Agent behind.
   */
  recordAccount(nodeId: string, account: NodeAccount): void {
    const recorded = this.database
      .prepare(
        `UPDATE nodes SET linux_username=?,uid=?,gid=?
         WHERE id=? AND (linux_username IS NULL OR (linux_username=? AND uid=? AND gid=?))`,
      )
      .run(
        account.username,
        account.uid,
        account.gid,
        nodeId,
        account.username,
        account.uid,
        account.gid,
      );
    if (recorded.changes === 1) return;
    if (!this.database.prepare("SELECT 1 FROM nodes WHERE id=?").get(nodeId))
      throw new NodeAccountConflict("节点尚未配对，无法记录它运行 Agent 的账号。");
    throw new NodeAccountConflict(
      "同一节点上的 Agent 必须共用该节点运行账号；节点返回了不同账号，请检查节点部署。",
    );
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
        this.reject(socket, undefined, "malformed_request", "节点身份验证超时。");
    }, this.handshakeTimeoutMs);
    this.sessions.set(socket, session);
    this.sockets.add(socket);
    this.unauthenticated.add(socket);
    this.send(socket, { type: "control.challenge", nonce });
  }

  async receive(socket: NodeSocket, messageData: unknown): Promise<void> {
    const session = this.sessions.get(socket);
    if (!session) return this.reject(socket, undefined, "malformed_request", "连接尚未初始化。");

    let parsedMessage: unknown;
    try {
      parsedMessage = JSON.parse(await messageText(messageData));
    } catch {
      return this.reject(socket, undefined, "malformed_request", "请求格式无效。");
    }
    const parsed = NodeRequestSchema.safeParse(parsedMessage);
    if (!parsed.success) {
      const requestId =
        typeof parsedMessage === "object" && parsedMessage !== null && "requestId" in parsedMessage
          ? parsedMessage.requestId
          : undefined;
      return this.reject(
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
      return this.receiveReconciliation(socket, session, request);
    if (request.type === "node.workspace.reconcile.result")
      return this.receiveWorkspaceReconciliation(socket, session, request);
    if (request.type === "node.process.operation.result")
      return this.receiveAgentProcessOperationResult(socket, session, request);
    if (request.type === "node.workspace.operation.result")
      return this.receiveWorkspaceOperationResult(socket, session, request);
    return this.receiveAgentProvisionMessage(socket, session, request);
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
      this.rejectAgentProvisions(nodeId, new Error("节点连接已断开，Agent 创建结果尚未确认。"));
      this.rejectAgentProcessOperations(
        nodeId,
        new Error("节点连接已断开，普通操作结果尚未确认。"),
      );
      this.rejectWorkspaceOperations(nodeId, new Error("节点连接已断开，文件操作结果尚未确认。"));
    }
    this.sessions.delete(socket);
  }

  provisionAgent(
    nodeId: string,
    requestId: string,
    agentId: string,
    onProgress: (stage: AgentProvisionStage) => void,
    verifyOnly = false,
  ): Promise<NodeAgentProvisionResult> {
    const controlMessage = NodeControlMessageSchema.parse({
      type: "control.agent.provision",
      requestId,
      agentId,
      ...(verifyOnly ? { verifyOnly: true } : {}),
    });
    const existing = this.pendingAgentProvisions.get(requestId);
    if (existing) {
      if (existing.nodeId !== nodeId || existing.agentId !== agentId)
        return Promise.reject(new Error("Agent 创建请求标识已被另一请求使用。"));
      return existing.promise;
    }
    const socket = this.connected.get(nodeId),
      session = socket ? this.sessions.get(socket) : undefined;
    if (
      !socket ||
      !session ||
      session.nodeId !== nodeId ||
      this.now() - session.lastHeartbeatAt >= this.heartbeatTimeoutMs
    )
      return Promise.reject(new Error("所选节点当前离线，Agent 创建尚未开始。"));

    let resolveResult!: (result: NodeAgentProvisionResult) => void,
      rejectResult!: (error: Error) => void;
    const promise = new Promise<NodeAgentProvisionResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const timeout = setTimeout(() => {
      this.finishAgentProvision(
        requestId,
        undefined,
        new Error("节点执行 Agent 创建超时，结果尚未确认。"),
      );
    }, this.operationTimeoutMs);
    this.pendingAgentProvisions.set(requestId, {
      nodeId,
      agentId,
      onProgress,
      promise,
      resolve: resolveResult,
      reject: rejectResult,
      timeout,
    });
    try {
      this.send(socket, controlMessage);
    } catch (error) {
      this.finishAgentProvision(
        requestId,
        undefined,
        error instanceof Error ? error : new Error("无法向节点发送 Agent 创建请求。"),
      );
    }
    return promise;
  }

  setOfflineHandler(handler: (nodeId: string) => void): void {
    this.onOffline = handler;
  }

  setWorkspaceOperationResultHandler(
    handler: (nodeId: string, result: NodeWorkspaceOperationResult) => void,
  ): void {
    this.workspaceOperationResultHandler = handler;
  }

  /** Send one owner read, Agent file action, or Agent publication read to its paired node. */
  workspaceOperation(
    nodeId: string,
    request: NodeWorkspaceOperationStart,
  ): Promise<NodeWorkspaceOperationResult> {
    const controlMessage = NodeControlMessageSchema.parse(request);
    if (controlMessage.type !== "control.workspace.operation")
      throw new Error("Invalid workspace operation");
    const existing = this.pendingWorkspaceOperations.get(request.requestId);
    if (existing) {
      if (
        existing.nodeId !== nodeId ||
        existing.operationId !== request.operationId ||
        existing.agentId !== request.agentId
      )
        return Promise.reject(new Error("Workspace operation request identity conflict"));
      return existing.promise;
    }
    const socket = this.connected.get(nodeId),
      session = socket ? this.sessions.get(socket) : undefined;
    if (
      !socket ||
      !session ||
      session.nodeId !== nodeId ||
      this.now() - session.lastHeartbeatAt >= this.heartbeatTimeoutMs
    )
      return Promise.reject(new Error("Selected node is offline"));

    let resolveResult!: (result: NodeWorkspaceOperationResult) => void,
      rejectResult!: (error: Error) => void;
    const promise = new Promise<NodeWorkspaceOperationResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const timeout = setTimeout(() => {
      this.finishWorkspaceOperation(
        request.requestId,
        undefined,
        new Error("Node file operation timed out; result is unknown"),
      );
    }, this.operationTimeoutMs);
    this.pendingWorkspaceOperations.set(request.requestId, {
      nodeId,
      operationId: request.operationId,
      agentId: request.agentId,
      promise,
      resolve: resolveResult,
      reject: rejectResult,
      timeout,
    });
    try {
      this.send(socket, controlMessage);
    } catch {
      this.finishWorkspaceOperation(
        request.requestId,
        undefined,
        new Error("Could not send workspace operation to node"),
      );
    }
    return promise;
  }

  setProcessReceiptHandler(
    handler: NonNullable<NodeDirectory["processReceiptHandler"]>,
    onReady: () => void,
  ): void {
    this.processReceiptHandler = handler;
    this.onReady = onReady;
  }

  executeAgentProcessOperation(
    nodeId: string,
    request: { operationId: string; agentId: string; operation: AgentProcessOperation },
  ): Promise<{
    operationId: string;
    agentId: string;
    state: Exclude<AgentProcessOperationState, "started">;
    receipt: unknown | null;
    revision?: number;
  }> {
    const operationId = NodeRequestIdSchema.parse(request.operationId),
      agentId = NodeRequestIdSchema.parse(request.agentId),
      requestId = randomUUID(),
      controlMessage = NodeControlMessageSchema.parse({
        type: "control.process.operation",
        requestId,
        operationId,
        agentId,
        operation: request.operation,
      });
    const existing = this.pendingAgentProcessOperations.get(requestId);
    if (existing) {
      if (
        existing.nodeId !== nodeId ||
        existing.agentId !== agentId ||
        existing.operationId !== operationId
      )
        return Promise.reject(new Error("Agent process operation request identity conflict"));
      return existing.promise;
    }
    const socket = this.connected.get(nodeId),
      session = socket ? this.sessions.get(socket) : undefined;
    if (
      !socket ||
      !session ||
      session.nodeId !== nodeId ||
      !session.ready ||
      this.now() - session.lastHeartbeatAt >= this.heartbeatTimeoutMs
    )
      return Promise.reject(new Error("Selected node is offline"));

    let resolveResult!: PendingAgentProcessOperation["resolve"],
      rejectResult!: PendingAgentProcessOperation["reject"];
    const promise = new Promise<Awaited<PendingAgentProcessOperation["promise"]>>(
      (resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      },
    );
    const timeout = setTimeout(() => {
      this.finishAgentProcessOperation(
        requestId,
        undefined,
        new Error("Node operation timed out; its result is not confirmed"),
      );
    }, this.processOperationTimeoutMs);
    this.pendingAgentProcessOperations.set(requestId, {
      nodeId,
      agentId,
      operationId,
      promise,
      resolve: resolveResult,
      reject: rejectResult,
      timeout,
    });
    try {
      this.send(socket, controlMessage);
    } catch {
      this.finishAgentProcessOperation(
        requestId,
        undefined,
        new Error("Could not send Agent process operation"),
      );
    }
    return promise;
  }

  activateAgent(nodeId: string, agentId: string): boolean {
    const socket = this.connected.get(nodeId),
      session = socket ? this.sessions.get(socket) : undefined;
    if (!socket || !session?.ready || session.nodeId !== nodeId) return false;
    try {
      this.send(socket, {
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
      return this.reject(socket, request.requestId, "invalid_identity", "连接已完成身份验证。");
    const row = z
      .looseObject({ public_key: z.string() })
      .optional()
      .parse(this.database.prepare("SELECT public_key FROM nodes WHERE id=?").get(request.nodeId));
    if (!row) {
      this.send(socket, {
        type: "control.error",
        requestId: request.requestId,
        code: "unknown_identity",
        message: "此节点身份尚未配对。",
      });
      return;
    }
    if (!verifySignature(row.public_key, session.nonce, request.signature))
      return this.reject(socket, request.requestId, "invalid_identity", "节点身份验证失败。");

    this.markConnected(socket, session, request.nodeId);
    this.send(socket, {
      type: "control.authenticated",
      requestId: request.requestId,
      nodeId: request.nodeId,
    });
    this.startReconciliation(socket, session, "", true);
  }

  private pair(
    socket: NodeSocket,
    session: SocketSession,
    request: Extract<NodeRequest, { type: "node.pair" }>,
  ): void {
    if (session.nodeId)
      return this.reject(socket, request.requestId, "pairing_rejected", "配对令牌无效或已使用。");
    if (
      !isEd25519PublicKey(request.publicKey) ||
      !verifySignature(request.publicKey, session.nonce, request.signature)
    )
      return this.reject(socket, request.requestId, "invalid_identity", "节点身份验证失败。");

    const now = this.now();
    let paired: boolean;
    try {
      paired = this.database
        .transaction(() => {
          const result = this.database
            .prepare(
              "UPDATE node_pairing_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?",
            )
            .run(now, hashToken(request.pairingToken), now);
          if (result.changes !== 1) return false;
          this.database
            .prepare("INSERT INTO nodes(id,public_key,paired_at,last_connected_at) VALUES(?,?,?,?)")
            .run(request.nodeId, request.publicKey, now, now);
          return true;
        })
        .immediate();
    } catch {
      return this.reject(socket, request.requestId, "pairing_rejected", "配对令牌无效或已使用。");
    }
    if (!paired)
      return this.reject(socket, request.requestId, "pairing_rejected", "配对令牌无效或已使用。");

    this.markConnected(socket, session, request.nodeId);
    this.send(socket, {
      type: "control.paired",
      requestId: request.requestId,
      nodeId: request.nodeId,
    });
    this.startReconciliation(socket, session, "", true);
  }

  private ping(
    socket: NodeSocket,
    session: SocketSession,
    request: Extract<NodeRequest, { type: "node.ping" }>,
  ): void {
    if (!session.nodeId || this.connected.get(session.nodeId) !== socket)
      return this.reject(socket, request.requestId, "not_authenticated", "节点尚未完成身份验证。");
    session.lastHeartbeatAt = this.now();
    this.send(socket, {
      type: "control.pong",
      requestId: request.requestId,
      acceptedAt: this.now(),
    });
    if (session.ready && !session.reconcile && !session.workspaceReconcile)
      this.startReconciliation(socket, session, "", false);
  }

  private startReconciliation(
    socket: NodeSocket,
    session: SocketSession,
    cursor: string,
    blocking: boolean,
  ): void {
    if (!session.nodeId || this.connected.get(session.nodeId) !== socket) return;
    const rows = z
      .looseObject({ operation_id: z.string(), agent_id: z.string(), request_json: z.string() })
      .array()
      .parse(
        this.database
          .prepare(
            `SELECT operation_id,agent_id,request_json FROM (
          SELECT operation_id,agent_id,request_json FROM owner_agent_process_operations
          WHERE node_id=? AND (? OR state IN ('executing','unknown'))
          UNION ALL
          SELECT operation_id,agent_id,'{"operation":{"kind":"process.stop_all"}}' AS request_json FROM owner_agent_stop_intents
          WHERE node_id=? AND state IN ('executing','unknown')
        ) WHERE operation_id>? ORDER BY operation_id LIMIT 100`,
          )
          .all(session.nodeId, blocking ? 1 : 0, session.nodeId, cursor),
      );
    if (rows.length === 0) {
      this.startWorkspaceReconciliation(socket, session, "", blocking);
      return;
    }
    // The current request owns its normal result until timeout or disconnect. A missing
    // receipt during that wait is not a recovery fact, just as for workspace operations.
    const validRows = rows.filter(
      (row) =>
        NodeRequestIdSchema.safeParse(row.operation_id).success &&
        ![...this.pendingAgentProcessOperations.values()].some(
          (pending) =>
            pending.nodeId === session.nodeId &&
            pending.agentId === row.agent_id &&
            pending.operationId === row.operation_id,
        ),
    );
    if (validRows.length === 0) {
      this.startReconciliation(socket, session, rows.at(-1)!.operation_id, blocking);
      return;
    }
    const requestId = randomUUID();
    session.reconcile = {
      requestId,
      operations: new Map(validRows.map((row) => [row.operation_id, row.agent_id])),
      cursor: rows.at(-1)!.operation_id,
      blocking,
    };
    this.send(socket, {
      type: "control.process.reconcile",
      requestId,
      operations: validRows.map((row) => {
        let requestHash = "unreadable";
        try {
          const operation = agentProcessOperationSchema.parse(
            JSON.parse(row.request_json).operation,
          );
          requestHash = processOperationRequestHash(row.agent_id, operation);
        } catch {
          /* Keep an unreadable intent unknown, even if a node has some result. */
        }
        return { operationId: row.operation_id, agentId: row.agent_id, requestHash };
      }),
    });
  }

  private receiveReconciliation(
    socket: NodeSocket,
    session: SocketSession,
    request: Extract<NodeRequest, { type: "node.process.reconcile.result" }>,
  ): void {
    const pending = session.reconcile;
    if (
      !session.nodeId ||
      this.connected.get(session.nodeId) !== socket ||
      !pending ||
      pending.requestId !== request.requestId
    )
      return this.reject(socket, request.requestId, "invalid_identity", "节点操作对账请求不匹配。");
    const conflicts = new Set<string>();
    const seen = new Set<string>();
    for (const receipt of request.receipts) {
      if (
        pending.operations.get(receipt.operationId) !== receipt.agentId ||
        seen.has(receipt.operationId)
      )
        conflicts.add(receipt.operationId);
      seen.add(receipt.operationId);
    }
    for (const receipt of request.receipts) {
      if (conflicts.has(receipt.operationId)) continue;
      const { revision, ...value } = receipt;
      this.processReceiptHandler?.(session.nodeId, {
        ...value,
        ...(revision !== undefined ? { revision } : {}),
      });
    }
    for (const [operationId, agentId] of pending.operations) {
      if (seen.has(operationId) && !conflicts.has(operationId)) continue;
      this.processReceiptHandler?.(session.nodeId, {
        operationId,
        agentId,
        state: "unknown",
        receipt: {
          reason: conflicts.has(operationId)
            ? "node_receipt_identity_conflict"
            : "no_durable_node_receipt",
        },
      });
    }
    delete session.reconcile;
    this.startReconciliation(socket, session, pending.cursor, pending.blocking);
  }

  private startWorkspaceReconciliation(
    socket: NodeSocket,
    session: SocketSession,
    cursor: string,
    blocking: boolean,
  ): void {
    if (!session.nodeId || this.connected.get(session.nodeId) !== socket) return;
    if (
      !this.database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='owner_agent_tool_actions'",
        )
        .get()
    ) {
      if (blocking) {
        session.ready = true;
        this.onReady?.();
      }
      return;
    }
    const rows = z
      .looseObject({
        operation_id: z.string(),
        agent_id: z.string(),
        request_hash: z.string().nullable(),
      })
      .array()
      .parse(
        this.database
          .prepare(
            `SELECT json_extract(CASE WHEN json_valid(action.result_json) THEN action.result_json ELSE '{}' END,'$.operationId') AS operation_id,
              action.agent_id, json_extract(CASE WHEN json_valid(action.result_json) THEN action.result_json ELSE '{}' END,'$.nodeRequestHash') AS request_hash
       FROM owner_agent_tool_actions action
       JOIN owner_agents agent ON agent.id=action.agent_id
       WHERE agent.node_id=? AND action.operation LIKE 'workspace.%'
         AND (? OR json_extract(CASE WHEN json_valid(action.result_json) THEN action.result_json ELSE '{}' END,'$.state') IN ('executing','unknown'))
         AND json_extract(CASE WHEN json_valid(action.result_json) THEN action.result_json ELSE '{}' END,'$.operationId')>?
       ORDER BY operation_id LIMIT 100`,
          )
          .all(session.nodeId, blocking ? 1 : 0, cursor),
      );
    if (rows.length === 0) {
      if (blocking) {
        session.ready = true;
        this.onReady?.();
      }
      return;
    }
    // A request still waiting on this connection owns its normal result. Missing terminal
    // evidence during that wait is not a recovery fact; timeout or disconnect releases it.
    const validRows = rows.filter(
      (row) =>
        NodeRequestIdSchema.safeParse(row.operation_id).success &&
        ![...this.pendingWorkspaceOperations.values()].some(
          (pending) =>
            pending.nodeId === session.nodeId &&
            pending.agentId === row.agent_id &&
            pending.operationId === row.operation_id,
        ),
    );
    if (validRows.length === 0) {
      this.startWorkspaceReconciliation(socket, session, rows.at(-1)!.operation_id, blocking);
      return;
    }
    const requestId = randomUUID();
    session.workspaceReconcile = {
      requestId,
      operations: new Map(validRows.map((row) => [row.operation_id, row.agent_id])),
      cursor: rows.at(-1)!.operation_id,
      blocking,
    };
    this.send(socket, {
      type: "control.workspace.reconcile",
      requestId,
      operations: validRows.map((row) => ({
        operationId: row.operation_id,
        agentId: row.agent_id,
        requestHash: row.request_hash ?? "unreadable",
      })),
    });
  }

  private receiveWorkspaceReconciliation(
    socket: NodeSocket,
    session: SocketSession,
    request: Extract<NodeRequest, { type: "node.workspace.reconcile.result" }>,
  ): void {
    const pending = session.workspaceReconcile;
    if (
      !session.nodeId ||
      this.connected.get(session.nodeId) !== socket ||
      !pending ||
      pending.requestId !== request.requestId
    )
      return this.reject(socket, request.requestId, "invalid_identity", "节点文件对账请求不匹配。");
    const conflicts = new Set<string>();
    const seen = new Set<string>();
    for (const receipt of request.receipts) {
      if (
        pending.operations.get(receipt.operationId) !== receipt.agentId ||
        seen.has(receipt.operationId)
      )
        conflicts.add(receipt.operationId);
      seen.add(receipt.operationId);
    }
    for (const receipt of request.receipts) {
      if (conflicts.has(receipt.operationId)) continue;
      this.deliverWorkspaceOperationResult(session.nodeId, {
        type: "node.workspace.operation.result",
        requestId: request.requestId,
        operationId: receipt.operationId,
        agentId: receipt.agentId,
        ok: true,
        result: receipt.result,
      });
    }
    for (const [operationId, agentId] of pending.operations) {
      if (seen.has(operationId) && !conflicts.has(operationId)) continue;
      this.deliverWorkspaceOperationResult(session.nodeId, {
        type: "node.workspace.operation.result",
        requestId: request.requestId,
        operationId,
        agentId,
        ok: false,
        error: conflicts.has(operationId)
          ? "Node receipt identity conflict; file operation result is unknown"
          : "No durable node receipt; file operation result is unknown",
      });
    }
    delete session.workspaceReconcile;
    this.startWorkspaceReconciliation(socket, session, pending.cursor, pending.blocking);
  }

  private receiveAgentProvisionMessage(
    socket: NodeSocket,
    session: SocketSession,
    request: Extract<
      NodeRequest,
      { type: "node.agent.provision.progress" | "node.agent.provision.result" }
    >,
  ): void {
    const nodeId = session.nodeId;
    if (!nodeId || this.connected.get(nodeId) !== socket)
      return this.reject(socket, request.requestId, "not_authenticated", "节点尚未完成身份验证。");
    const pending = this.pendingAgentProvisions.get(request.requestId);
    if (!pending) return;
    if (pending.nodeId !== nodeId || pending.agentId !== request.agentId)
      return this.reject(
        socket,
        request.requestId,
        "invalid_identity",
        "Agent 创建结果与请求不匹配。",
      );
    if (request.type === "node.agent.provision.progress") {
      pending.onProgress(request.stage);
      return;
    }
    this.finishAgentProvision(request.requestId, request);
  }

  private receiveAgentProcessOperationResult(
    socket: NodeSocket,
    session: SocketSession,
    request: Extract<NodeRequest, { type: "node.process.operation.result" }>,
  ): void {
    const nodeId = session.nodeId;
    if (!nodeId || this.connected.get(nodeId) !== socket)
      return this.reject(socket, request.requestId, "not_authenticated", "节点尚未完成身份验证。");
    const pending = this.pendingAgentProcessOperations.get(request.requestId);
    if (!pending) {
      const { revision, ...value } = request;
      this.processReceiptHandler?.(nodeId, {
        operationId: value.operationId,
        agentId: value.agentId,
        state: value.state,
        receipt: value.receipt,
        ...(revision !== undefined ? { revision } : {}),
      });
      return;
    }
    if (
      pending.nodeId !== nodeId ||
      pending.agentId !== request.agentId ||
      pending.operationId !== request.operationId
    )
      return this.reject(
        socket,
        request.requestId,
        "invalid_identity",
        "普通操作收据与节点请求不匹配。",
      );
    this.finishAgentProcessOperation(request.requestId, request);
  }

  private receiveWorkspaceOperationResult(
    socket: NodeSocket,
    session: SocketSession,
    request: Extract<NodeRequest, { type: "node.workspace.operation.result" }>,
  ): void {
    const nodeId = session.nodeId;
    if (!nodeId || this.connected.get(nodeId) !== socket)
      return this.reject(socket, request.requestId, "not_authenticated", "节点尚未完成身份验证。");
    const pending = this.pendingWorkspaceOperations.get(request.requestId);
    if (!pending) {
      this.deliverWorkspaceOperationResult(nodeId, request);
      return; // A late receipt may resolve a durable action that already timed out.
    }
    if (
      pending.nodeId !== nodeId ||
      pending.operationId !== request.operationId ||
      pending.agentId !== request.agentId
    )
      return this.reject(
        socket,
        request.requestId,
        "invalid_identity",
        "文件操作结果与控制面请求不匹配。",
      );
    this.deliverWorkspaceOperationResult(nodeId, request);
    this.finishWorkspaceOperation(request.requestId, request);
  }

  private deliverWorkspaceOperationResult(
    nodeId: string,
    result: NodeWorkspaceOperationResult,
  ): void {
    try {
      this.workspaceOperationResultHandler?.(nodeId, result);
    } catch {
      // A receipt write failure does not make the node protocol unauthenticated; a replay can recover it.
    }
  }

  private finishAgentProvision(
    requestId: string,
    result?: NodeAgentProvisionResult,
    error?: Error,
  ): void {
    const pending = this.pendingAgentProvisions.get(requestId);
    if (!pending) return;
    this.pendingAgentProvisions.delete(requestId);
    clearTimeout(pending.timeout);
    if (error) pending.reject(error);
    else if (result) pending.resolve(result);
  }

  private rejectAgentProvisions(nodeId: string, error: Error): void {
    for (const [requestId, pending] of this.pendingAgentProvisions) {
      if (pending.nodeId === nodeId) this.finishAgentProvision(requestId, undefined, error);
    }
  }

  private rejectAgentProcessOperations(nodeId: string, error: Error): void {
    for (const [requestId, pending] of this.pendingAgentProcessOperations) {
      if (pending.nodeId === nodeId) this.finishAgentProcessOperation(requestId, undefined, error);
    }
  }

  private finishAgentProcessOperation(
    requestId: string,
    result?: Extract<NodeRequest, { type: "node.process.operation.result" }>,
    error?: Error,
  ): void {
    const pending = this.pendingAgentProcessOperations.get(requestId);
    if (!pending) return;
    this.pendingAgentProcessOperations.delete(requestId);
    clearTimeout(pending.timeout);
    if (error) pending.reject(error);
    else if (result)
      pending.resolve({
        operationId: result.operationId,
        agentId: result.agentId,
        state: result.state,
        receipt: result.receipt,
        ...(result.revision !== undefined ? { revision: result.revision } : {}),
      });
  }

  private rejectWorkspaceOperations(nodeId: string, error: Error): void {
    for (const [requestId, pending] of this.pendingWorkspaceOperations) {
      if (pending.nodeId === nodeId) this.finishWorkspaceOperation(requestId, undefined, error);
    }
  }

  private finishWorkspaceOperation(
    requestId: string,
    result?: NodeWorkspaceOperationResult,
    error?: Error,
  ): void {
    const pending = this.pendingWorkspaceOperations.get(requestId);
    if (!pending) return;
    this.pendingWorkspaceOperations.delete(requestId);
    clearTimeout(pending.timeout);
    if (error) pending.reject(error);
    else if (result) pending.resolve(result);
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

  private reject(
    socket: NodeSocket,
    requestId: string | undefined,
    code: Extract<NodeControlMessage, { type: "control.error" }>["code"],
    message: string,
  ): void {
    this.send(socket, {
      type: "control.error",
      ...(requestId ? { requestId } : {}),
      code,
      message,
    });
    socket.close(1008, code);
  }

  private send(socket: NodeSocket, message: NodeControlMessage): void {
    socket.send(JSON.stringify(message));
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

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1)
    throw new Error("Node connection limits and timeouts must be positive integers");
  return result;
}

function isEd25519PublicKey(publicKeyPem: string): boolean {
  try {
    return createPublicKey(publicKeyPem).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

function verifySignature(publicKeyPem: string, nonce: string, signature: string): boolean {
  try {
    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") return false;
    return verify(null, Buffer.from(nonce, "utf8"), publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
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
