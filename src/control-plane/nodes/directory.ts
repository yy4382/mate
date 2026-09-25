import type Database from "better-sqlite3";
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import {
  NodeControlMessageSchema,
  NodeRequestIdSchema,
  NodeRequestSchema,
  type NodeControlMessage,
  type NodeAgentProvisionResult,
  type NodeAgentRunResult,
  type AgentProvisionStage,
  type NodeRequest,
} from "../../nodes/protocol.js";

export const DEFAULT_NODE_PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_NODE_MAX_CONNECTIONS = 128;
export const DEFAULT_NODE_MAX_UNAUTHENTICATED_CONNECTIONS = 32;
export const DEFAULT_NODE_HANDSHAKE_TIMEOUT_MS = 10_000;
export const DEFAULT_NODE_HEARTBEAT_TIMEOUT_MS = 35_000;
export const DEFAULT_NODE_OPERATION_TIMEOUT_MS = 60_000;
export const DEFAULT_NODE_MAX_ACTIVE_RUNS = 2;
export const DEFAULT_NODE_RUN_TIMEOUT_MS = 5 * 60_000;

export interface NodeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

interface SocketSession {
  nonce: string;
  lastHeartbeatAt: number;
  nodeId?: string;
  handshakeTimeout?: ReturnType<typeof setTimeout>;
}

export interface NodeSummary {
  id: string;
  online: boolean;
  lastConnectedAt: string | null;
}

export interface NodeDirectoryOptions {
  now?: () => number;
  pairingTokenTtlMs?: number;
  maxConnections?: number;
  maxUnauthenticatedConnections?: number;
  handshakeTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  operationTimeoutMs?: number;
  runTimeoutMs?: number;
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

export type NodeAgentRunStart = Extract<NodeControlMessage, { type: "control.agent.run" }>;

interface PendingAgentRun {
  nodeId: string;
  agentId: string;
  promise: Promise<NodeAgentRunResult>;
  resolve: (result: NodeAgentRunResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface AgentRunHandlers {
  context(
    runId: string,
    agentId: string,
    after: number,
    limit: number,
  ):
    | {
        messages: Array<{
          sequence: number;
          role: "user" | "assistant";
          text: string;
          sourceChannelId: string;
          sourceVisibility: "public" | "private";
          currentRunInput: boolean;
        }>;
        nextAfter: number | null;
      }
    | undefined;
  journal(
    runId: string,
    nodeId: string,
    agentId: string,
    requestId: string,
    text: string,
    replayOnly: boolean,
  ): boolean;
  result(runId: string, agentId: string, ok: boolean, code?: string): void;
}

type NodeAgentRunRequest = Extract<
  NodeRequest,
  { type: "node.agent.run.context" | "node.agent.run.journal" | "node.agent.run.result" }
>;

/** Pairing credentials and durable node identities for this control plane. */
export class NodeDirectory {
  private readonly now: () => number;
  private readonly pairingTokenTtlMs: number;
  private readonly maxConnections: number;
  private readonly maxUnauthenticatedConnections: number;
  private readonly handshakeTimeoutMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly operationTimeoutMs: number;
  private readonly runTimeoutMs: number;
  private readonly heartbeatSweepTimer: ReturnType<typeof setInterval>;
  private readonly sessions = new WeakMap<NodeSocket, SocketSession>();
  private readonly connected = new Map<string, NodeSocket>();
  private readonly sockets = new Set<NodeSocket>();
  private readonly unauthenticated = new Set<NodeSocket>();
  private readonly pendingAgentProvisions = new Map<string, PendingAgentProvision>();
  private readonly pendingAgentRuns = new Map<string, PendingAgentRun>();
  private agentRunHandlers?: AgentRunHandlers;

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
    this.runTimeoutMs = positiveInteger(options.runTimeoutMs, DEFAULT_NODE_RUN_TIMEOUT_MS);
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

  list(): NodeSummary[] {
    const rows = this.database
      .prepare("SELECT id, last_connected_at FROM nodes ORDER BY paired_at, id")
      .all() as Array<{ id: string; last_connected_at: number | null }>;
    const now = this.now();
    return rows.map((row) => {
      const socket = this.connected.get(row.id);
      const session = socket ? this.sessions.get(socket) : undefined;
      return {
        id: row.id,
        online:
          session?.nodeId === row.id && now - session.lastHeartbeatAt < this.heartbeatTimeoutMs,
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
    if (
      request.type === "node.agent.run.context" ||
      request.type === "node.agent.run.journal" ||
      request.type === "node.agent.run.result"
    )
      return this.receiveAgentRunMessage(socket, session, request);
    return this.receiveAgentProvisionMessage(socket, session, request);
  }

  close(socket: NodeSocket): void {
    this.sockets.delete(socket);
    this.unauthenticated.delete(socket);
    const session = this.sessions.get(socket);
    if (session?.handshakeTimeout) clearTimeout(session.handshakeTimeout);
    const nodeId = session?.nodeId;
    if (nodeId && this.connected.get(nodeId) === socket) {
      this.connected.delete(nodeId);
      this.rejectAgentProvisions(nodeId, new Error("节点连接已断开，Agent 创建结果尚未确认。"));
      this.rejectAgentRuns(nodeId, new Error("节点连接已断开，待处理私信仍保留在控制面。"));
    }
    this.sessions.delete(socket);
  }

  provisionAgent(
    nodeId: string,
    requestId: string,
    agentId: string,
    onProgress: (stage: AgentProvisionStage) => void,
  ): Promise<NodeAgentProvisionResult> {
    const controlMessage = NodeControlMessageSchema.parse({
      type: "control.agent.provision",
      requestId,
      agentId,
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

  setAgentRunHandlers(handlers: AgentRunHandlers): void {
    this.agentRunHandlers = handlers;
  }

  runAgent(nodeId: string, request: NodeAgentRunStart): Promise<NodeAgentRunResult> {
    const controlMessage = NodeControlMessageSchema.parse(request) as NodeAgentRunStart;
    const existing = this.pendingAgentRuns.get(request.runId);
    if (existing) {
      if (existing.nodeId !== nodeId || existing.agentId !== request.agentId)
        return Promise.reject(new Error("Agent run identifier is already in use"));
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
    const nodeRuns = [...this.pendingAgentRuns.values()].filter(
      (run) => run.nodeId === nodeId,
    ).length;
    if (nodeRuns >= DEFAULT_NODE_MAX_ACTIVE_RUNS)
      return Promise.reject(new Error("Selected node has reached its fixed Agent run capacity"));

    let resolveResult!: (result: NodeAgentRunResult) => void, rejectResult!: (error: Error) => void;
    const promise = new Promise<NodeAgentRunResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const timeout = setTimeout(() => {
      this.cancelAgentRun(request.runId, request.agentId, "timeout");
    }, this.runTimeoutMs);
    this.pendingAgentRuns.set(request.runId, {
      nodeId,
      agentId: request.agentId,
      promise,
      resolve: resolveResult,
      reject: rejectResult,
      timeout,
    });
    try {
      this.send(socket, controlMessage);
    } catch {
      this.finishAgentRun(request.runId, undefined, new Error("Could not send Agent run"));
    }
    return promise;
  }

  cancelAgentRun(
    runId: string,
    agentId: string,
    reason: "timeout" | "credentials_changed",
  ): boolean {
    const pending = this.pendingAgentRuns.get(runId);
    if (!pending || pending.agentId !== agentId) return false;
    const socket = this.connected.get(pending.nodeId),
      session = socket ? this.sessions.get(socket) : undefined;
    if (socket && session?.nodeId === pending.nodeId) {
      try {
        this.send(socket, {
          type: "control.agent.run.cancel",
          requestId: randomUUID(),
          runId,
          agentId,
          reason,
        });
      } catch {
        // The durable run fails below; a disconnect also closes the node-side worker.
      }
    }
    this.finishAgentRun(
      runId,
      undefined,
      new Error(reason === "timeout" ? "Agent run timed out" : "Model credential changed"),
    );
    return true;
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
    const row = this.database
      .prepare("SELECT public_key FROM nodes WHERE id=?")
      .get(request.nodeId) as { public_key: string } | undefined;
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

  private receiveAgentRunMessage(
    socket: NodeSocket,
    session: SocketSession,
    request: NodeAgentRunRequest,
  ): void {
    const nodeId = session.nodeId;
    if (!nodeId || this.connected.get(nodeId) !== socket)
      return this.reject(socket, request.requestId, "not_authenticated", "节点尚未完成身份验证。");
    const pending = this.pendingAgentRuns.get(request.runId);
    if (pending && (pending.nodeId !== nodeId || pending.agentId !== request.agentId))
      return this.reject(
        socket,
        request.requestId,
        "invalid_identity",
        "Agent run 与节点请求不匹配。",
      );

    if (request.type === "node.agent.run.context") {
      let page: ReturnType<AgentRunHandlers["context"]>;
      try {
        page = pending
          ? this.agentRunHandlers?.context(
              request.runId,
              request.agentId,
              request.after,
              request.limit,
            )
          : undefined;
      } catch {
        page = undefined;
      }
      this.send(socket, {
        type: "control.agent.run.context",
        requestId: request.requestId,
        runId: request.runId,
        messages: page?.messages ?? [],
        nextAfter: page?.nextAfter ?? null,
      });
      return;
    }

    if (request.type === "node.agent.run.journal") {
      let accepted = false;
      try {
        accepted =
          this.agentRunHandlers?.journal(
            request.runId,
            nodeId,
            request.agentId,
            request.requestId,
            request.text,
            !pending,
          ) ?? false;
      } catch {
        accepted = false;
      }
      this.send(socket, {
        type: "control.agent.run.journal_ack",
        requestId: request.requestId,
        runId: request.runId,
        accepted,
      });
      return;
    }

    if (!pending) return; // Late result from a disconnected run is deliberately ignored.
    try {
      this.agentRunHandlers?.result(
        request.runId,
        request.agentId,
        request.ok,
        request.ok ? undefined : request.code,
      );
    } finally {
      this.finishAgentRun(request.runId, request);
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

  private rejectAgentRuns(nodeId: string, error: Error): void {
    for (const [runId, pending] of this.pendingAgentRuns) {
      if (pending.nodeId === nodeId) this.finishAgentRun(runId, undefined, error);
    }
  }

  private finishAgentRun(runId: string, result?: NodeAgentRunResult, error?: Error): void {
    const pending = this.pendingAgentRuns.get(runId);
    if (!pending) return;
    this.pendingAgentRuns.delete(runId);
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
    session.lastHeartbeatAt = this.now();
    this.connected.set(nodeId, socket);
    this.database
      .prepare("UPDATE nodes SET last_connected_at=? WHERE id=?")
      .run(this.now(), nodeId);
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
