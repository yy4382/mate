import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { NodeDirectory } from "./nodes/directory.js";
import type { Operation } from "../execution/backend.js";
import type { ControlWorkspaceOperation, NodeWorkspaceOperationResult } from "../nodes/protocol.js";

export interface WorkspaceEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
}

export interface WorkspaceVersion {
  device: string;
  inode: string;
  size: number;
  modifiedNs: string;
  changedNs: string;
}

export type WorkspaceStat =
  | { type: "directory"; size: number; modifiedAt: number }
  | { type: "file"; size: number; modifiedAt: number; version: WorkspaceVersion };

export interface WorkspaceChunk {
  bytes: Uint8Array;
  offset: number;
  totalBytes: number;
  version: WorkspaceVersion;
}

export class WorkspaceError extends Error {
  constructor(
    readonly code:
      | "agent_unavailable"
      | "node_offline"
      | "permission_denied"
      | "not_found"
      | "file_changed"
      | "unsafe_path"
      | "not_file"
      | "invalid_response"
      | "operation_unknown"
      | "operation_conflict"
      | "workspace_unavailable",
    message: string,
    readonly status: number,
    readonly lastConnectedAt?: string | null,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

interface WorkspaceAgent {
  id: string;
  node_id: string;
  status: string;
  verified_at: number | null;
  home: string | null;
}

/** Owner reads and Agent file actions cross the paired node protocol one request at a time. */
export class WorkspaceService {
  private readonly actionOperations = new Map<
    string,
    {
      sessionId: string;
      actionId: string;
      agentId: string;
      nodeId: string;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly db: Database.Database,
    private readonly nodes: NodeDirectory,
  ) {
    nodes.setWorkspaceOperationResultHandler((nodeId, result) =>
      this.receiveActionResult(nodeId, result),
    );
  }

  async list(
    agentId: string,
    path: string,
    offset = 0,
    limit = 32,
  ): Promise<{ path: string; entries: WorkspaceEntry[]; nextOffset: number | null }> {
    const result = await this.readOperation(agentId, {
      kind: "workspace_list",
      path,
      offset,
      limit,
    });
    if (
      typeof result !== "object" ||
      result === null ||
      !Array.isArray(result.entries) ||
      result.entries.some(
        (entry) =>
          typeof entry !== "object" ||
          entry === null ||
          typeof entry.name !== "string" ||
          !["file", "directory", "symlink", "other"].includes(entry.type) ||
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0,
      ) ||
      (result.nextOffset !== null && !Number.isSafeInteger(result.nextOffset))
    )
      throw invalidNodeResponse();
    return result as { path: string; entries: WorkspaceEntry[]; nextOffset: number | null };
  }

  async stat(agentId: string, path: string): Promise<WorkspaceStat> {
    const result = await this.readOperation(agentId, { kind: "workspace_stat", path });
    if (
      typeof result !== "object" ||
      result === null ||
      typeof result.modifiedAt !== "number" ||
      !Number.isFinite(result.modifiedAt)
    )
      throw invalidNodeResponse();
    if (
      result.type === "directory" &&
      typeof result.size === "number" &&
      Number.isSafeInteger(result.size) &&
      result.size >= 0
    )
      return result as WorkspaceStat;
    if (
      result.type === "file" &&
      typeof result.size === "number" &&
      Number.isSafeInteger(result.size) &&
      result.size >= 0 &&
      isWorkspaceVersion(result.version)
    )
      return result as WorkspaceStat;
    throw invalidNodeResponse();
  }

  async readChunk(
    agentId: string,
    path: string,
    offset: number,
    version?: WorkspaceVersion,
    length = 8192,
  ): Promise<WorkspaceChunk> {
    const result = await this.readOperation(agentId, {
      kind: "workspace_read_chunk",
      path,
      offset,
      length,
      ...(version ? { version } : {}),
    });
    if (
      typeof result !== "object" ||
      result === null ||
      typeof result.base64 !== "string" ||
      !Number.isSafeInteger(result.offset) ||
      !Number.isSafeInteger(result.totalBytes) ||
      !isWorkspaceVersion(result.version) ||
      Buffer.from(result.base64, "base64").toString("base64") !== result.base64
    )
      throw invalidNodeResponse();
    const bytes = Buffer.from(result.base64, "base64");
    if (
      bytes.byteLength > length ||
      result.offset !== offset ||
      result.totalBytes !== result.version.size ||
      (version && !sameVersion(version, result.version))
    )
      throw invalidNodeResponse();
    return {
      bytes,
      offset: result.offset,
      totalBytes: result.totalBytes,
      version: result.version,
    };
  }

  async readForAgentPublish(
    runId: string,
    agentId: string,
    operation: Extract<Operation, { kind: "workspace_stat" | "workspace_read_chunk" }>,
  ): Promise<Record<string, unknown>> {
    const authorized = this.authorizeActiveRun(runId, agentId),
      result = await this.runNodeOperation(
        {
          type: "control.workspace.operation",
          requestId: randomUUID(),
          operationId: randomUUID(),
          runId,
          agentId,
          mode: "agent_publish",
          operation,
        },
        authorized.node_id,
      );
    try {
      const value = JSON.parse(result.stdout) as unknown;
      if (typeof value !== "object" || value === null) throw new Error("Invalid result");
      return value as Record<string, unknown>;
    } catch {
      throw invalidNodeResponse();
    }
  }

  /** The body pulls only one bounded node chunk after the previous chunk is consumed. */
  async download(
    agentId: string,
    path: string,
  ): Promise<{ size: number; stream: ReadableStream<Uint8Array> }> {
    const metadata = await this.stat(agentId, path);
    if (metadata.type !== "file")
      throw new WorkspaceError("not_file", "只能下载普通文件。", 400);
    let offset = 0,
      cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (cancelled) return;
        if (offset >= metadata.size) {
          controller.close();
          return;
        }
        try {
          const chunk = await thisService.readChunk(
            agentId,
            path,
            offset,
            metadata.version,
            8192,
          );
          if (!chunk.bytes.byteLength || chunk.bytes.byteLength > metadata.size - offset)
            throw new WorkspaceError("file_changed", "文件在下载期间发生变化。", 409);
          offset += chunk.bytes.byteLength;
          controller.enqueue(chunk.bytes);
          if (offset === metadata.size) controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const thisService = this;
    return { size: metadata.size, stream };
  }

  /** Persist authorization and the node receipt before returning an Agent file action. */
  async agentAction(input: {
    runId: string;
    agentId: string;
    actionId: string;
    operationName: string;
    toolInput: Record<string, unknown>;
    operation: Exclude<Operation, { kind: "exec" }>;
  }): Promise<unknown> {
    const authorized = this.authorizeActiveRun(input.runId, input.agentId);
    if (!isMutatingOperation(input.operation))
      throw new WorkspaceError("workspace_unavailable", "此文件操作不允许修改工作区。", 403);
    if (!input.actionId.startsWith(`mate:${authorized.delivery_id}:`))
      throw new WorkspaceError("operation_conflict", "文件操作 ID 与当前消息授权不匹配。", 403);
    const operationId = deterministicOperationId(input.actionId),
      requestHash = hashToolRequest(input.operationName, input.toolInput),
      recorded = this.prepareToolAction(
        authorized.session_id,
        input.actionId,
        input.agentId,
        input.operationName,
        requestHash,
        operationId,
      );
    if (recorded.kind === "done") return recorded.result;
    this.trackActionOperation(operationId, {
      sessionId: authorized.session_id,
      actionId: input.actionId,
      agentId: input.agentId,
      nodeId: authorized.node_id,
    });

    try {
      const result = await this.runNodeOperation(
          {
            type: "control.workspace.operation",
            requestId: randomUUID(),
            operationId,
            runId: input.runId,
            agentId: input.agentId,
            mode: "agent_action",
            operation: input.operation,
          },
          authorized.node_id,
        ),
        value = parseOperationReceipt(result.stdout),
        envelope = { state: "succeeded", operationId, result: value };
      this.completeToolAction(
        authorized.session_id,
        input.actionId,
        input.agentId,
        requestHash,
        envelope,
      );
      this.clearActionOperation(operationId);
      return value;
    } catch (error) {
      this.markToolActionUnknown(
        authorized.session_id,
        input.actionId,
        input.agentId,
        requestHash,
        operationId,
        safeError(error),
      );
      throw error;
    }
  }

  private async readOperation(agentId: string, operation: Operation): Promise<Record<string, unknown>> {
    const agent = this.requireAgent(agentId);
    const result = await this.runNodeOperation(
      {
        type: "control.workspace.operation",
        requestId: randomUUID(),
        operationId: randomUUID(),
        agentId,
        mode: "owner_read",
        operation: operation as Extract<Operation, { kind: "workspace_list" | "workspace_stat" | "workspace_read_chunk" }>,
      },
      agent.node_id,
    );
    try {
      const value = JSON.parse(result.stdout) as unknown;
      if (typeof value !== "object" || value === null) throw new Error("Invalid result");
      return value as Record<string, unknown>;
    } catch {
      throw invalidNodeResponse();
    }
  }

  private async runNodeOperation(
    request: ControlWorkspaceOperation,
    nodeId: string,
  ): Promise<{ code: number; stdout: string; stderr: string; truncated: boolean }> {
    try {
      const response = await this.nodes.workspaceOperation(nodeId, request);
      if (!response.ok) throw mapNodeError(response.error);
      if (response.result.code !== 0) {
        const error = mapNodeError(response.result.stderr || "File request failed");
        throw error;
      }
      if (response.result.truncated)
        throw invalidNodeResponse();
      return response.result;
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      const message = error instanceof Error ? error.message : "Node file request failed";
      if (/offline|disconnected/i.test(message)) {
        const agentId = request.agentId,
          agent = this.db.prepare("SELECT node_id FROM owner_agents WHERE id=?").get(agentId) as
            | { node_id: string }
            | undefined,
          node = agent ? this.nodes.list().find((item) => item.id === agent.node_id) : undefined;
        throw new WorkspaceError(
          "node_offline",
          "节点当前离线，工作区暂不可用。",
          503,
          node?.lastConnectedAt ?? null,
        );
      }
      throw new WorkspaceError("workspace_unavailable", "节点暂时无法完成文件请求。", 503);
    }
  }

  private requireAgent(agentId: string): WorkspaceAgent {
    const row = this.db
      .prepare(
        `SELECT a.id,a.node_id,a.status,a.home,s.verified_at
         FROM owner_agents a JOIN owner_agent_sessions s ON s.agent_id=a.id WHERE a.id=?`,
      )
      .get(agentId) as WorkspaceAgent | undefined;
    if (
      !row ||
      row.verified_at === null ||
      row.home === null ||
      !["waiting_credentials", "ready"].includes(row.status)
    )
      throw new WorkspaceError("agent_unavailable", "Agent 工作区尚未准备好。", 404);
    const node = this.nodes.list().find((item) => item.id === row.node_id);
    if (!node?.online)
      throw new WorkspaceError(
        "node_offline",
        "节点当前离线，工作区暂不可用。",
        503,
        node?.lastConnectedAt ?? null,
      );
    return row;
  }

  private authorizeActiveRun(runId: string, agentId: string): {
    session_id: string;
    node_id: string;
    delivery_id: string;
    channel_id: string;
  } {
    const run = this.db
      .prepare(
        `SELECT s.id AS session_id,r.node_id,r.delivery_id,d.channel_id
         FROM owner_agent_runs r JOIN owner_message_deliveries d ON d.id=r.delivery_id
         JOIN owner_agents a ON a.id=r.agent_id
         JOIN owner_agent_sessions s ON s.agent_id=a.id
         JOIN owner_channel_memberships m ON m.channel_id=d.channel_id
           AND m.principal_kind='agent' AND m.principal_id=a.id AND m.active=1
         WHERE r.id=? AND r.agent_id=? AND r.state='running'
           AND s.verified_at IS NOT NULL AND a.status IN ('waiting_credentials','ready')`,
      )
      .get(runId, agentId) as
      | { session_id: string; node_id: string; delivery_id: string; channel_id: string }
      | undefined;
    if (!run)
      throw new WorkspaceError("workspace_unavailable", "当前 Agent 运行无权访问此文件。", 403);
    return run;
  }

  private prepareToolAction(
    sessionId: string,
    actionId: string,
    agentId: string,
    operation: string,
    requestHash: string,
    operationId: string,
  ): { kind: "new" | "replay" } | { kind: "done"; result: unknown } {
    const existing = this.db
      .prepare(
        "SELECT request_hash,result_json FROM owner_agent_tool_actions WHERE session_id=? AND action_id=?",
      )
      .get(sessionId, actionId) as { request_hash: string; result_json: string } | undefined;
    if (existing) {
      if (existing.request_hash !== requestHash)
        throw new WorkspaceError("operation_conflict", "操作 ID 已用于不同的文件请求。", 409);
      const envelope = parseEnvelope(existing.result_json);
      if (envelope.state === "succeeded") return { kind: "done", result: envelope.result };
      if (envelope.operationId && envelope.operationId !== operationId)
        throw new WorkspaceError("operation_unknown", "文件操作结果尚未确认。", 409);
      return { kind: "replay" };
    }
    this.db
      .prepare(
        `INSERT INTO owner_agent_tool_actions(
           session_id,action_id,agent_id,operation,request_hash,result_json,created_at
         ) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        sessionId,
        actionId,
        agentId,
        operation,
        requestHash,
        JSON.stringify({ state: "executing", operationId }),
        Date.now(),
      );
    return { kind: "new" };
  }

  private completeToolAction(
    sessionId: string,
    actionId: string,
    agentId: string,
    requestHash: string,
    envelope: unknown,
  ): void {
    this.db
      .prepare(
        `UPDATE owner_agent_tool_actions SET result_json=?
         WHERE session_id=? AND action_id=? AND agent_id=? AND request_hash=?`,
      )
      .run(JSON.stringify(envelope).slice(0, 100_000), sessionId, actionId, agentId, requestHash);
  }

  private markToolActionUnknown(
    sessionId: string,
    actionId: string,
    agentId: string,
    requestHash: string,
    operationId: string,
    message: string,
  ): void {
    this.completeToolAction(sessionId, actionId, agentId, requestHash, {
      state: "unknown",
      operationId,
      error: message,
    });
  }

  private trackActionOperation(
    operationId: string,
    identity: { sessionId: string; actionId: string; agentId: string; nodeId: string },
  ): void {
    const previous = this.actionOperations.get(operationId);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => this.actionOperations.delete(operationId), 10 * 60_000);
    timer.unref?.();
    this.actionOperations.set(operationId, { ...identity, timer });
  }

  private clearActionOperation(operationId: string): void {
    const entry = this.actionOperations.get(operationId);
    if (entry) clearTimeout(entry.timer);
    this.actionOperations.delete(operationId);
  }

  private receiveActionResult(nodeId: string, result: NodeWorkspaceOperationResult): void {
    const identity = this.actionOperations.get(result.operationId);
    if (!identity || identity.nodeId !== nodeId || identity.agentId !== result.agentId) return;
    let envelope: unknown;
    if (!result.ok) {
      envelope = { state: "unknown", operationId: result.operationId, error: result.error };
    } else if (result.result.code !== 0) {
      envelope = {
        state: "unknown",
        operationId: result.operationId,
        error: result.result.stderr || "File operation result is unknown",
      };
    } else {
      try {
        envelope = {
          state: "succeeded",
          operationId: result.operationId,
          result: JSON.parse(result.result.stdout) as unknown,
        };
      } catch {
        envelope = { state: "unknown", operationId: result.operationId, error: "Invalid node receipt" };
      }
    }
    const row = this.db
      .prepare("SELECT request_hash FROM owner_agent_tool_actions WHERE session_id=? AND action_id=?")
      .get(identity.sessionId, identity.actionId) as { request_hash: string } | undefined;
    if (row)
      this.completeToolAction(
        identity.sessionId,
        identity.actionId,
        identity.agentId,
        row.request_hash,
        envelope,
      );
    this.clearActionOperation(result.operationId);
  }
}

function isWorkspaceVersion(value: unknown): value is WorkspaceVersion {
  if (typeof value !== "object" || value === null) return false;
  const version = value as Record<string, unknown>;
  return (
    typeof version.device === "string" &&
    typeof version.inode === "string" &&
    Number.isSafeInteger(version.size) &&
    typeof version.modifiedNs === "string" &&
    typeof version.changedNs === "string"
  );
}

function sameVersion(left: WorkspaceVersion, right: WorkspaceVersion): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedNs === right.modifiedNs &&
    left.changedNs === right.changedNs
  );
}

function invalidNodeResponse(): WorkspaceError {
  return new WorkspaceError("invalid_response", "节点返回了无效的文件结果。", 502);
}

function mapNodeError(message: string): WorkspaceError {
  if (/operation_conflict/i.test(message))
    return new WorkspaceError("operation_conflict", "操作 ID 已用于不同的文件请求。", 409);
  if (/operation_unknown|outcome may be unknown/i.test(message))
    return new WorkspaceError("operation_unknown", "文件操作结果尚未确认，不会自动重试。", 409);
  if (/unsafe_path|symbolic link|symlink|escapes the workspace/i.test(message))
    return new WorkspaceError("unsafe_path", "路径越过了 Agent 私人工作区边界。", 403);
  if (/file_changed|file changed|changed while/i.test(message))
    return new WorkspaceError("file_changed", "文件在读取期间发生变化，请重新加载。", 409);
  if (/permission denied|eacces|eperm/i.test(message))
    return new WorkspaceError("permission_denied", "Agent Linux 用户没有读取此文件的权限。", 403);
  if (/enoent|not found|no such file or directory/i.test(message))
    return new WorkspaceError("not_found", "文件或目录不存在。", 404);
  if (/not_regular_file|regular single-link|is a directory/i.test(message))
    return new WorkspaceError("not_file", "只能读取普通文件。", 400);
  return new WorkspaceError("workspace_unavailable", "节点无法完成文件请求。", 502);
}

function isMutatingOperation(
  operation: Operation,
): operation is Extract<Operation, { kind: "write_bytes" | "write" | "edit" | "mkdir" | "move" | "remove" }> {
  return ["write_bytes", "write", "edit", "mkdir", "move", "remove"].includes(operation.kind);
}

function hashToolRequest(operation: string, input: unknown): string {
  return createHash("sha256").update(JSON.stringify({ operation, input })).digest("hex");
}

function deterministicOperationId(actionId: string): string {
  const bytes = createHash("sha256").update(actionId).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseOperationReceipt(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new WorkspaceError("invalid_response", "节点操作收据无法读取。", 502);
  }
}

function parseEnvelope(value: string): { state: string; operationId?: string; result?: unknown } {
  try {
    const envelope = JSON.parse(value) as {
      state?: unknown;
      operationId?: unknown;
      result?: unknown;
    };
    if (typeof envelope.state !== "string") throw new Error("Invalid action result");
    return {
      state: envelope.state,
      ...(typeof envelope.operationId === "string" ? { operationId: envelope.operationId } : {}),
      ...(envelope.result === undefined ? {} : { result: envelope.result }),
    };
  } catch {
    throw new WorkspaceError("operation_unknown", "文件操作收据无法读取。", 409);
  }
}

function safeError(error: unknown): string {
  return (error instanceof WorkspaceError ? error.message : "文件操作结果尚未确认。").slice(0, 240);
}
