import type Database from "better-sqlite3";
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import {
  NodeControlMessageSchema,
  NodeRequestIdSchema,
  NodeRequestSchema,
  type NodeControlMessage,
  type NodeAgentProvisionResult,
  type NodeAgentRunResult,
  type NodeWorkspaceOperationResult,
  type ControlWorkspaceOperation,
  type AgentProvisionStage,
  type NodeRequest,
} from "../../nodes/protocol.js";
import type {
  AgentProcessOperation,
  AgentProcessOperationState,
} from "../../nodes/process-operations.js";
import { recordAgentActivity } from "../activity.js";
import type { PrivilegedGrant } from "../privileged-approvals.js";

export const DEFAULT_NODE_PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_NODE_MAX_CONNECTIONS = 128;
export const DEFAULT_NODE_MAX_UNAUTHENTICATED_CONNECTIONS = 32;
export const DEFAULT_NODE_HANDSHAKE_TIMEOUT_MS = 10_000;
export const DEFAULT_NODE_HEARTBEAT_TIMEOUT_MS = 35_000;
export const DEFAULT_NODE_OPERATION_TIMEOUT_MS = 60_000;
export const DEFAULT_NODE_MAX_ACTIVE_RUNS = 2;
export const DEFAULT_NODE_RUN_TIMEOUT_MS = 5 * 60_000;
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
  processOperationTimeoutMs?: number;
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

export interface AgentRunHandlers {
  /** Cursor is the per-run context projection position, not a persistent journal sequence. */
  context(
    runId: string,
    agentId: string,
    cursor: number,
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
        nextCursor: number | null;
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
  tool(
    runId: string,
    nodeId: string,
    agentId: string,
    toolCallId: string,
    operation: string,
    input: Record<string, unknown>,
  ):
    | { ok: true; result: unknown }
    | { ok: false; error: string }
    | Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;
  result(runId: string, agentId: string, ok: boolean, code?: string): void;
}

type NodeAgentRunRequest = Extract<
  NodeRequest,
  {
    type:
      | "node.agent.run.context"
      | "node.agent.run.journal"
      | "node.agent.run.tool"
      | "node.agent.run.result";
  }
>;
type NodeAgentRunToolRequest = Extract<NodeAgentRunRequest, { type: "node.agent.run.tool" }>;
type NodeAgentRunMessage = Exclude<NodeAgentRunRequest, NodeAgentRunToolRequest>;

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
  private readonly runTimeoutMs: number;
  private readonly heartbeatSweepTimer: ReturnType<typeof setInterval>;
  private readonly sessions = new WeakMap<NodeSocket, SocketSession>();
  private readonly connected = new Map<string, NodeSocket>();
  private readonly sockets = new Set<NodeSocket>();
  private readonly unauthenticated = new Set<NodeSocket>();
  private readonly pendingAgentProvisions = new Map<string, PendingAgentProvision>();
  private readonly pendingAgentRuns = new Map<string, PendingAgentRun>();
  private readonly pendingAgentProcessOperations = new Map<string, PendingAgentProcessOperation>();
  private readonly pendingWorkspaceOperations = new Map<string, PendingWorkspaceOperation>();
  private readonly pendingPrivileged = new Map<
    string,
    {
      nodeId: string;
      operationId: string;
      agentId: string;
      onStarted?: (startedAt: number) => void;
      resolve: (value: {
        state: "succeeded" | "failed" | "unknown";
        startedAt: number;
        receipt: unknown | null;
        revision?: number;
      }) => void;
      reject: (reason: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private approvalPublicKey?: string;
  private privilegedReceiptHandler?: (
    nodeId: string,
    requestId: string,
    result: {
      state: "succeeded" | "failed" | "unknown";
      startedAt: number;
      receipt: unknown | null;
      revision?: number;
    },
  ) => void;
  private privilegedReadyHandler?: () => void;
  private agentRunHandlers?: AgentRunHandlers;
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
    if (request.type === "node.agent.run.tool")
      return this.receiveAgentRunToolMessage(socket, session, request);
    if (
      request.type === "node.agent.run.context" ||
      request.type === "node.agent.run.journal" ||
      request.type === "node.agent.run.result"
    )
      return this.receiveAgentRunMessage(socket, session, request);
    if (request.type === "node.process.operation.result")
      return this.receiveAgentProcessOperationResult(socket, session, request);
    if (request.type === "node.privileged.started") {
      const pending = this.pendingPrivileged.get(request.requestId);
      if (
        session.nodeId &&
        this.connected.get(session.nodeId) === socket &&
        pending?.nodeId === session.nodeId &&
        pending.operationId === request.operationId &&
        pending.agentId === request.agentId
      )
        pending.onStarted?.(request.startedAt);
      return;
    }
    if (request.type === "node.privileged.result") {
      if (!session.nodeId || this.connected.get(session.nodeId) !== socket) return;
      const pending = this.pendingPrivileged.get(request.requestId);
      if (
        pending?.nodeId === session.nodeId &&
        pending.operationId === request.operationId &&
        pending.agentId === request.agentId
      ) {
        clearTimeout(pending.timeout);
        this.pendingPrivileged.delete(request.requestId);
        pending.resolve({
          state: request.state,
          startedAt: request.startedAt,
          receipt: request.receipt,
          ...(request.revision !== undefined ? { revision: request.revision } : {}),
        });
      }
      if (
        this.matchesPrivilegedIntent(
          session.nodeId,
          request.requestId,
          request.operationId,
          request.agentId,
        )
      )
        this.privilegedReceiptHandler?.(session.nodeId, request.requestId, {
          state: request.state,
          startedAt: request.startedAt,
          receipt: request.receipt,
          ...(request.revision !== undefined ? { revision: request.revision } : {}),
        });
      return;
    }
    if (request.type === "node.privileged.reconcile.result") {
      if (!session.nodeId || this.connected.get(session.nodeId) !== socket) return;
      for (const receipt of request.receipts)
        if (
          this.matchesPrivilegedIntent(
            session.nodeId,
            receipt.requestId,
            receipt.operationId,
            receipt.agentId,
          )
        )
          this.privilegedReceiptHandler?.(session.nodeId, receipt.requestId, {
            state: receipt.state,
            startedAt: receipt.startedAt,
            receipt: receipt.receipt,
            ...(receipt.revision !== undefined ? { revision: receipt.revision } : {}),
          });
      return;
    }
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
      this.rejectAgentProvisions(nodeId, new Error("节点连接已断开，Agent 创建结果尚未确认。"));
      this.rejectAgentRuns(nodeId, new Error("节点连接已断开，待处理私信仍保留在控制面。"));
      this.rejectAgentProcessOperations(
        nodeId,
        new Error("节点连接已断开，普通操作结果尚未确认。"),
      );
      this.rejectWorkspaceOperations(nodeId, new Error("节点连接已断开，文件操作结果尚未确认。"));
      for (const [requestId, pending] of this.pendingPrivileged) {
        if (pending.nodeId !== nodeId) continue;
        clearTimeout(pending.timeout);
        this.pendingPrivileged.delete(requestId);
        pending.reject(new Error("Privileged node receipt unavailable"));
      }
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

  setAgentRunHandlers(handlers: AgentRunHandlers): void {
    this.agentRunHandlers = handlers;
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
    const controlMessage = NodeControlMessageSchema.parse(request) as NodeWorkspaceOperationStart,
      existing = this.pendingWorkspaceOperations.get(request.requestId);
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

  setPrivilegedApprovalHandler(
    publicKey: string,
    receipt: NonNullable<NodeDirectory["privilegedReceiptHandler"]>,
    onReady: () => void,
  ): void {
    this.approvalPublicKey = publicKey;
    this.privilegedReceiptHandler = receipt;
    this.privilegedReadyHandler = onReady;
  }

  executePrivileged(
    nodeId: string,
    grant: PrivilegedGrant,
    onStarted?: (startedAt: number) => void,
  ): Promise<{
    state: "succeeded" | "failed" | "unknown";
    startedAt: number;
    receipt: unknown | null;
    revision?: number;
  }> {
    const socket = this.connected.get(nodeId);
    const session = socket ? this.sessions.get(socket) : undefined;
    if (
      !socket ||
      !session?.ready ||
      session.nodeId !== nodeId ||
      this.now() - session.lastHeartbeatAt >= this.heartbeatTimeoutMs
    )
      return Promise.reject(new Error("Selected node is offline"));
    const command = grant.command;
    const requestId = command.requestId;
    if (this.pendingPrivileged.has(requestId))
      return Promise.reject(new Error("Privileged request already in flight"));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingPrivileged.delete(requestId);
        reject(new Error("Privileged receipt timed out"));
      }, this.processOperationTimeoutMs);
      this.pendingPrivileged.set(requestId, {
        nodeId,
        operationId: command.operationId,
        agentId: command.agentId,
        ...(onStarted ? { onStarted } : {}),
        resolve,
        reject,
        timeout,
      });
      try {
        this.send(socket, {
          type: "control.privileged.operation",
          requestId,
          command,
          signature: grant.signature,
        });
      } catch {
        clearTimeout(timeout);
        this.pendingPrivileged.delete(requestId);
        reject(new Error("Could not send privileged command to node"));
      }
    });
  }

  private matchesPrivilegedIntent(
    nodeId: string,
    requestId: string,
    operationId: string,
    agentId: string,
  ): boolean {
    const row = this.database
      .prepare(
        `SELECT 1 FROM owner_privileged_approvals
      WHERE request_id=? AND operation_id=? AND agent_id=? AND node_id=?`,
      )
      .get(requestId, operationId, agentId, nodeId);
    return !!row;
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
      !session.ready ||
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

  cancelAgentRun(
    runId: string,
    agentId: string,
    reason: "timeout" | "credentials_changed" | "manual_pause",
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
      new Error(
        reason === "timeout"
          ? "Agent run timed out"
          : reason === "manual_pause"
            ? "Agent run paused"
            : "Model credential changed",
      ),
    );
    return true;
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
      ...(this.approvalPublicKey ? { privilegedPublicKey: this.approvalPublicKey } : {}),
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
      ...(this.approvalPublicKey ? { privilegedPublicKey: this.approvalPublicKey } : {}),
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
    const rows = this.database
      .prepare(
        `SELECT operation_id,agent_id FROM (
          SELECT operation_id,agent_id FROM owner_agent_process_operations
          WHERE node_id=? AND state IN ('executing','unknown')
          UNION ALL
          SELECT operation_id,agent_id FROM owner_agent_stop_intents
          WHERE node_id=? AND state IN ('executing','unknown')
        ) WHERE operation_id>? ORDER BY operation_id LIMIT 100`,
      )
      .all(session.nodeId, session.nodeId, cursor) as Array<{
      operation_id: string;
      agent_id: string;
    }>;
    if (rows.length === 0) {
      this.startWorkspaceReconciliation(socket, session, "", blocking);
      return;
    }
    const requestId = randomUUID();
    session.reconcile = {
      requestId,
      operations: new Map(rows.map((row) => [row.operation_id, row.agent_id])),
      cursor: rows.at(-1)!.operation_id,
      blocking,
    };
    this.send(socket, {
      type: "control.process.reconcile",
      requestId,
      operations: rows.map((row) => ({ operationId: row.operation_id, agentId: row.agent_id })),
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
    const seen = new Set<string>();
    for (const receipt of request.receipts) {
      if (
        pending.operations.get(receipt.operationId) !== receipt.agentId ||
        seen.has(receipt.operationId)
      )
        return this.reject(
          socket,
          request.requestId,
          "invalid_identity",
          "节点操作收据不属于本次对账。",
        );
      seen.add(receipt.operationId);
    }
    for (const receipt of request.receipts) {
      const { revision, ...value } = receipt;
      this.processReceiptHandler?.(session.nodeId, {
        ...value,
        ...(revision !== undefined ? { revision } : {}),
      });
    }
    for (const [operationId, agentId] of pending.operations) {
      if (seen.has(operationId)) continue;
      this.processReceiptHandler?.(session.nodeId, {
        operationId,
        agentId,
        state: "unknown",
        receipt: { reason: "no_durable_node_receipt" },
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
        this.privilegedReadyHandler?.();
      }
      return;
    }
    const rows = this.database
      .prepare(
        `SELECT json_extract(action.result_json,'$.operationId') AS operation_id,
              action.agent_id
       FROM owner_agent_tool_actions action
       JOIN owner_agents agent ON agent.id=action.agent_id
       WHERE agent.node_id=? AND action.operation LIKE 'workspace.%'
         AND json_extract(action.result_json,'$.state') IN ('executing','unknown')
         AND json_extract(action.result_json,'$.operationId')>?
       ORDER BY operation_id LIMIT 100`,
      )
      .all(session.nodeId, cursor) as Array<{ operation_id: string; agent_id: string }>;
    if (rows.length === 0) {
      if (blocking) {
        session.ready = true;
        this.onReady?.();
        this.privilegedReadyHandler?.();
      }
      return;
    }
    const requestId = randomUUID();
    session.workspaceReconcile = {
      requestId,
      operations: new Map(rows.map((row) => [row.operation_id, row.agent_id])),
      cursor: rows.at(-1)!.operation_id,
      blocking,
    };
    this.send(socket, {
      type: "control.workspace.reconcile",
      requestId,
      operations: rows.map((row) => ({ operationId: row.operation_id, agentId: row.agent_id })),
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
    const seen = new Set<string>();
    for (const receipt of request.receipts) {
      if (
        pending.operations.get(receipt.operationId) !== receipt.agentId ||
        seen.has(receipt.operationId)
      )
        return this.reject(
          socket,
          request.requestId,
          "invalid_identity",
          "节点文件收据不属于本次对账。",
        );
      seen.add(receipt.operationId);
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
      if (seen.has(operationId)) continue;
      this.deliverWorkspaceOperationResult(session.nodeId, {
        type: "node.workspace.operation.result",
        requestId: request.requestId,
        operationId,
        agentId,
        ok: false,
        error: "No durable node receipt; file operation result is unknown",
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

  private receiveAgentRunMessage(
    socket: NodeSocket,
    session: SocketSession,
    request: NodeAgentRunMessage,
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
              request.cursor,
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
        nextCursor: page?.nextCursor ?? null,
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

  private async receiveAgentRunToolMessage(
    socket: NodeSocket,
    session: SocketSession,
    request: NodeAgentRunToolRequest,
  ): Promise<void> {
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

    let outcome: { ok: true; result: unknown } | { ok: false; error: string };
    try {
      outcome = pending
        ? await (this.agentRunHandlers?.tool(
            request.runId,
            nodeId,
            request.agentId,
            request.toolCallId,
            request.operation,
            request.input,
          ) ?? { ok: false, error: "Agent tool service is unavailable" })
        : { ok: false, error: "Agent run is no longer active" };
    } catch {
      outcome = { ok: false, error: "Agent tool request was refused" };
    }
    if (
      this.connected.get(nodeId) !== socket ||
      (pending !== undefined && this.pendingAgentRuns.get(request.runId) !== pending)
    )
      return;
    const response = NodeControlMessageSchema.parse({
      type: "control.agent.run.tool_result",
      requestId: request.requestId,
      runId: request.runId,
      toolCallId: request.toolCallId,
      ...outcome,
    });
    this.send(socket, response);
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
