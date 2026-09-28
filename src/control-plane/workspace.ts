import { isDeepStrictEqual } from "node:util";
import { AgentSession } from "./agent-session.js";
import type Database from "better-sqlite3";
import { recordAgentActivity } from "./activity.js";
import { workspaceReceiptRequestHash } from "../nodes/workspace-receipt.js";
import type { OwnerChat } from "./owner-chat.js";
import { createHash, randomUUID } from "node:crypto";
import { posix as posixPath } from "node:path";
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
      | "download_unknown"
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
  stage: string;
  home: string | null;
}

interface WorkspaceAccessAudit {
  principalKind: "owner" | "agent";
  principalId: string;
  agentId: string;
  runId?: string;
  operation: string;
  paths: string[];
}

export interface WorkspaceDownloadStatus {
  state: "started" | "succeeded" | "failed" | "cancelled";
  errorCode: string | null;
  expiresInMs: number;
}

const DOWNLOAD_STATUS_TTL_MS = 24 * 60 * 60 * 1000;

/** Owner reads and Agent file actions cross the paired node protocol one request at a time. */
export class WorkspaceService {
  private readonly downloadPruneTimer: ReturnType<typeof setInterval>;
  private readonly actionOperations = new Map<
    string,
    {
      sessionId: string;
      actionId: string;
      agentId: string;
      nodeId: string;
      runId: string;
      channelId: string;
      operation: string;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly db: Database.Database,
    private readonly nodes: NodeDirectory,
    private readonly chat: OwnerChat,
  ) {
    this.db
      .prepare(
        `UPDATE owner_workspace_access_audit
         SET result='failed',error_code='download_interrupted',completed_at=?
         WHERE operation='download' AND result='started'`,
      )
      .run(Date.now());
    this.pruneExpiredDownloadBindings(Date.now());
    this.downloadPruneTimer = setInterval(
      () => this.pruneExpiredDownloadBindings(Date.now()),
      60 * 60 * 1000,
    );
    this.downloadPruneTimer.unref();
    nodes.setWorkspaceOperationResultHandler((nodeId, result) =>
      this.receiveActionResult(nodeId, result),
    );
  }

  close(): void {
    clearInterval(this.downloadPruneTimer);
  }

  async list(
    agentId: string,
    path: string,
    offset = 0,
    limit = 32,
  ): Promise<{ path: string; entries: WorkspaceEntry[]; nextOffset: number | null }> {
    return this.withAccessAudit(
      { principalKind: "owner", principalId: "owner", agentId, operation: "list", paths: [path] },
      () => this.listUnchecked(agentId, path, offset, limit),
    );
  }

  private async listUnchecked(
    agentId: string,
    path: string,
    offset: number,
    limit: number,
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
    return this.withAccessAudit(
      { principalKind: "owner", principalId: "owner", agentId, operation: "stat", paths: [path] },
      () => this.statUnchecked(agentId, path),
    );
  }

  private async statUnchecked(agentId: string, path: string): Promise<WorkspaceStat> {
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
    return this.withAccessAudit(
      {
        principalKind: "owner",
        principalId: "owner",
        agentId,
        operation: "read_chunk",
        paths: [path],
      },
      () => this.readChunkUnchecked(agentId, path, offset, version, length),
    );
  }

  private async readChunkUnchecked(
    agentId: string,
    path: string,
    offset: number,
    version: WorkspaceVersion | undefined,
    length: number,
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
    return this.withAccessAudit(
      {
        principalKind: "agent",
        principalId: agentId,
        agentId,
        runId,
        operation: operation.kind,
        paths: [operation.path],
      },
      () => this.readForAgentPublishUnchecked(runId, agentId, operation),
    );
  }

  private async readForAgentPublishUnchecked(
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

  /** Agent reads require an active run and the membership that supplied its current delivery. */
  async readForAgent(
    runId: string,
    agentId: string,
    operation: Extract<
      Operation,
      { kind: "read" | "workspace_list" | "workspace_stat" | "workspace_read_chunk" }
    >,
  ): Promise<Record<string, unknown>> {
    return this.withAccessAudit(
      {
        principalKind: "agent",
        principalId: agentId,
        agentId,
        runId,
        operation: operation.kind,
        paths: [operation.path],
      },
      () => this.readForAgentUnchecked(runId, agentId, operation),
    );
  }

  private async readForAgentUnchecked(
    runId: string,
    agentId: string,
    operation: Extract<
      Operation,
      { kind: "read" | "workspace_list" | "workspace_stat" | "workspace_read_chunk" }
    >,
  ): Promise<Record<string, unknown>> {
    const authorized = this.authorizeActiveRun(runId, agentId),
      result = await this.runNodeOperation(
        {
          type: "control.workspace.operation",
          requestId: randomUUID(),
          operationId: randomUUID(),
          runId,
          agentId,
          mode: "agent_read",
          operation,
        },
        authorized.node_id,
      );
    if (operation.kind === "read") return { content: result.stdout };
    return parseOperationReceipt(result.stdout) as Record<string, unknown>;
  }

  /** The body pulls only one bounded node chunk after the previous chunk is consumed. */
  async download(
    agentId: string,
    path: string,
    downloadId: string,
    ownerSessionToken: string,
  ): Promise<{ size: number; stream: ReadableStream<Uint8Array>; downloadId: string }> {
    this.pruneExpiredDownloadBindings(Date.now());
    const access = {
      principalKind: "owner" as const,
      principalId: "owner",
      agentId,
      operation: "download",
      paths: [path],
    };
    const ownerSessionHash = createHash("sha256").update(ownerSessionToken).digest("hex");
    this.recordAccess(access, "started", undefined, {
      id: downloadId,
      ownerSessionHash,
      expiresAt: Date.now() + DOWNLOAD_STATUS_TTL_MS,
      completedAt: null,
    });
    try {
      return await this.downloadUnchecked(agentId, path, downloadId);
    } catch (error) {
      this.completeDownloadAudit(downloadId, "failed", workspaceAccessErrorCode(error));
      throw error;
    }
  }

  downloadStatus(
    agentId: string,
    downloadId: string,
    ownerSessionToken: string,
  ): WorkspaceDownloadStatus {
    this.pruneExpiredDownloadBindings(Date.now());
    const ownerSessionHash = createHash("sha256").update(ownerSessionToken).digest("hex");
    const row = this.db
      .prepare(
        `SELECT result,error_code,download_expires_at FROM owner_workspace_access_audit
         WHERE download_id=? AND agent_id=? AND actor_kind='owner' AND operation='download'
           AND owner_session_hash=? AND download_expires_at>?`,
      )
      .get(downloadId, agentId, ownerSessionHash, Date.now()) as
      | {
          result: WorkspaceDownloadStatus["state"];
          error_code: string | null;
          download_expires_at: number;
        }
      | undefined;
    if (!row) throw new WorkspaceError("download_unknown", "找不到这次文件下载记录。", 404);
    return {
      state: row.result,
      errorCode: row.error_code,
      expiresInMs: Math.max(0, row.download_expires_at - Date.now()),
    };
  }

  private async downloadUnchecked(
    agentId: string,
    path: string,
    downloadId: string,
  ): Promise<{ size: number; stream: ReadableStream<Uint8Array>; downloadId: string }> {
    const metadata = await this.stat(agentId, path);
    if (metadata.type !== "file") throw new WorkspaceError("not_file", "只能下载普通文件。", 400);
    let offset = 0,
      finished = false;
    const thisService = this,
      finish = (result: "succeeded" | "failed" | "cancelled", errorCode?: string) => {
        if (finished) return;
        finished = true;
        thisService.completeDownloadAudit(downloadId, result, errorCode);
      };
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (finished) return;
        if (offset >= metadata.size) {
          finish("succeeded");
          controller.close();
          return;
        }
        try {
          const chunk = await thisService.readChunk(agentId, path, offset, metadata.version, 8192);
          if (!chunk.bytes.byteLength || chunk.bytes.byteLength > metadata.size - offset)
            throw new WorkspaceError("file_changed", "文件在下载期间发生变化。", 409);
          offset += chunk.bytes.byteLength;
          thisService.renewDownloadBinding(downloadId);
          controller.enqueue(chunk.bytes);
          if (offset === metadata.size) {
            finish("succeeded");
            controller.close();
          }
        } catch (error) {
          finish("failed", workspaceAccessErrorCode(error));
          controller.error(error);
        }
      },
      cancel() {
        finish("cancelled", "download_cancelled");
      },
    });
    return { size: metadata.size, stream, downloadId };
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
    return this.withAccessAudit(
      {
        principalKind: "agent",
        principalId: input.agentId,
        agentId: input.agentId,
        runId: input.runId,
        operation: input.operationName,
        paths: operationPaths(input.operation),
      },
      () => this.agentActionUnchecked(input),
    );
  }

  private async agentActionUnchecked(input: {
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
    if (!input.actionId.startsWith(`mate:${authorized.delivery_id}:`)) {
      const original = new AgentSession(this.db).toolAction(input.agentId, input.actionId);
      if (
        !original ||
        original.name !== "tools.call" ||
        !isDeepStrictEqual(original.input, { name: input.operationName, input: input.toolInput })
      )
        throw new WorkspaceError("operation_conflict", "文件操作 ID 与已保存调用不匹配。", 403);
    }
    const operationId = deterministicOperationId(input.actionId),
      requestHash = hashToolRequest(input.operationName, input.toolInput),
      nodeRequestHash = workspaceReceiptRequestHash(input.agentId, input.operation),
      recorded = this.prepareToolAction(
        authorized.session_id,
        input.actionId,
        input.agentId,
        input.operationName,
        input.toolInput,
        requestHash,
        nodeRequestHash,
        operationId,
        input.runId,
        authorized.channel_id,
      );
    if (recorded.kind === "done") return recorded.result;
    if (recorded.kind === "failed") throw confirmedFileFailure(recorded.code, recorded.stderr);
    this.trackActionOperation(operationId, {
      sessionId: authorized.session_id,
      actionId: input.actionId,
      agentId: input.agentId,
      nodeId: authorized.node_id,
      runId: input.runId,
      channelId: authorized.channel_id,
      operation: input.operationName,
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
        envelope = {
          state: "succeeded" as const,
          operationId,
          runId: input.runId,
          channelId: authorized.channel_id,
          operation: input.operationName,
          nodeRequestHash,
          ...(result.revision !== undefined ? { revision: result.revision } : {}),
          result: value,
        };
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
        input.runId,
        authorized.channel_id,
        input.operationName,
        safeError(error),
        nodeRequestHash,
      );
      throw error;
    }
  }

  private async readOperation(
    agentId: string,
    operation: Operation,
  ): Promise<Record<string, unknown>> {
    const agent = this.requireAgent(agentId);
    const result = await this.runNodeOperation(
      {
        type: "control.workspace.operation",
        requestId: randomUUID(),
        operationId: randomUUID(),
        agentId,
        mode: "owner_read",
        operation: operation as Extract<
          Operation,
          { kind: "workspace_list" | "workspace_stat" | "workspace_read_chunk" }
        >,
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

  private async withAccessAudit<T>(
    access: WorkspaceAccessAudit,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await action();
      this.recordAccess(access, "succeeded");
      return result;
    } catch (error) {
      this.recordAccess(access, "failed", workspaceAccessErrorCode(error));
      throw error;
    }
  }

  private recordAccess(
    access: WorkspaceAccessAudit,
    result: WorkspaceDownloadStatus["state"],
    errorCode?: string,
    download?: {
      id: string;
      ownerSessionHash: string;
      expiresAt: number;
      completedAt: number | null;
    },
  ): void {
    const identity = this.db
        .prepare("SELECT home FROM owner_agents WHERE id=?")
        .get(access.agentId) as { home: string | null } | undefined,
      paths = access.paths.map((path) => safeAuditPath(path, identity?.home ?? undefined));
    this.db
      .prepare(
        `INSERT INTO owner_workspace_access_audit(
           at,actor_kind,actor_id,agent_id,run_id,operation,relative_paths,result,
           download_id,owner_session_hash,download_expires_at,completed_at,error_code
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        Date.now(),
        access.principalKind,
        access.principalId,
        access.agentId,
        access.runId ?? null,
        access.operation,
        JSON.stringify(paths),
        result,
        download?.id ?? null,
        download?.ownerSessionHash ?? null,
        download?.expiresAt ?? null,
        download ? download.completedAt : result === "started" ? null : Date.now(),
        errorCode ?? null,
      );
  }

  /** Retain download state for 24 hours, then erase its lookup ID and owner-session binding. */
  private pruneExpiredDownloadBindings(now: number): void {
    this.db
      .prepare(
        `UPDATE owner_workspace_access_audit
         SET result=CASE WHEN result='started' THEN 'failed' ELSE result END,
             error_code=CASE WHEN result='started' THEN 'download_status_expired' ELSE error_code END,
             completed_at=CASE WHEN result='started' THEN ? ELSE completed_at END,
             download_id=NULL,owner_session_hash=NULL,download_expires_at=NULL
         WHERE operation='download' AND download_id IS NOT NULL AND download_expires_at<=?`,
      )
      .run(now, now);
  }

  /** Active streams refresh status retention as each bounded chunk makes progress. */
  private renewDownloadBinding(downloadId: string): void {
    this.db
      .prepare(
        `UPDATE owner_workspace_access_audit SET download_expires_at=?
         WHERE download_id=? AND result='started'`,
      )
      .run(Date.now() + DOWNLOAD_STATUS_TTL_MS, downloadId);
  }

  private completeDownloadAudit(
    downloadId: string,
    result: "succeeded" | "failed" | "cancelled",
    errorCode?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE owner_workspace_access_audit
         SET result=?,error_code=?,completed_at=?,download_expires_at=?
         WHERE download_id=? AND result='started'`,
      )
      .run(result, errorCode ?? null, Date.now(), Date.now() + DOWNLOAD_STATUS_TTL_MS, downloadId);
  }

  private async runNodeOperation(
    request: ControlWorkspaceOperation,
    nodeId: string,
  ): Promise<{
    code: number;
    stdout: string;
    stderr: string;
    truncated: boolean;
    revision?: number;
  }> {
    try {
      const response = await this.nodes.workspaceOperation(nodeId, request);
      if (!response.ok) throw mapNodeError(response.error);
      if (response.result.code !== 0) {
        throw confirmedFileFailure(response.result.code, response.result.stderr);
      }
      if (response.result.truncated) throw invalidNodeResponse();
      const revision = response.revision ?? response.result.revision;
      return {
        code: response.result.code,
        stdout: response.result.stdout,
        stderr: response.result.stderr,
        truncated: response.result.truncated,
        ...(revision !== undefined ? { revision } : {}),
      };
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      const message = error instanceof Error ? error.message : "Node file request failed";
      if (/timed out|timeout|outcome is unknown/i.test(message))
        throw new WorkspaceError("operation_unknown", "文件操作结果尚未确认，不会自动重试。", 409);
      if (/offline|disconnected/i.test(message)) {
        const agentId = request.agentId,
          agent = this.db.prepare("SELECT node_id FROM owner_agents WHERE id=?").get(agentId) as
            { node_id: string } | undefined,
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
        `SELECT a.id,a.node_id,a.stage,a.home
         FROM owner_agents a JOIN owner_agent_sessions s ON s.agent_id=a.id WHERE a.id=?`,
      )
      .get(agentId) as WorkspaceAgent | undefined;
    if (!row || row.home === null || row.stage !== "complete")
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

  private authorizeActiveRun(
    runId: string,
    agentId: string,
  ): {
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
           AND a.stage='complete'
           AND NOT EXISTS (SELECT 1 FROM owner_agent_recovery_holds hold WHERE hold.agent_id=a.id)`,
      )
      .get(runId, agentId) as
      { session_id: string; node_id: string; delivery_id: string; channel_id: string } | undefined;
    if (!run)
      throw new WorkspaceError("workspace_unavailable", "当前 Agent 运行无权访问此文件。", 403);
    return run;
  }

  private prepareToolAction(
    sessionId: string,
    actionId: string,
    agentId: string,
    operation: string,
    toolInput: Record<string, unknown>,
    requestHash: string,
    nodeRequestHash: string,
    operationId: string,
    runId: string,
    channelId: string,
  ):
    | { kind: "new" }
    | { kind: "done"; result: unknown }
    | { kind: "failed"; code: number; stderr: string } {
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
      if (envelope.state === "failed") {
        const result = envelope.result;
        if (
          typeof result !== "object" ||
          result === null ||
          !Number.isSafeInteger((result as { code?: unknown }).code) ||
          (result as { code: number }).code === 0 ||
          typeof (result as { stderr?: unknown }).stderr !== "string"
        )
          throw new WorkspaceError("operation_unknown", "文件操作失败收据无法读取。", 409);
        return {
          kind: "failed",
          code: (result as { code: number }).code,
          stderr: (result as { stderr: string }).stderr,
        };
      }
      if (envelope.operationId && envelope.operationId !== operationId)
        throw new WorkspaceError("operation_unknown", "文件操作结果尚未确认。", 409);
      if (envelope.state === "executing")
        this.markToolActionUnknown(
          sessionId,
          actionId,
          agentId,
          requestHash,
          operationId,
          envelope.runId ?? runId,
          envelope.channelId ?? channelId,
          operation,
          "没有已确认的节点文件收据；不会重新执行此操作",
          envelope.nodeRequestHash,
        );
      throw new WorkspaceError("operation_unknown", "文件操作结果尚未确认。", 409);
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
        JSON.stringify({
          state: "executing",
          operationId,
          runId,
          channelId,
          operation,
          nodeRequestHash,
        }),
        Date.now(),
      );
    recordAgentActivity(this.db, {
      agentId,
      kind: "operation.started",
      referenceId: operationId,
      summary: "文件操作已提交节点执行。",
      detail: { operation, input: toolInput },
      at: Date.now(),
    });
    return { kind: "new" };
  }

  private completeToolAction(
    sessionId: string,
    actionId: string,
    agentId: string,
    requestHash: string,
    envelope: {
      state: "unknown" | "succeeded" | "failed";
      operationId: string;
      runId: string;
      channelId: string;
      operation: string;
      nodeRequestHash?: string;
      revision?: number;
      result?: unknown;
      error?: string;
    },
  ): void {
    this.db
      .transaction(() => {
        const existing = this.db
          .prepare(
            "SELECT result_json FROM owner_agent_tool_actions WHERE session_id=? AND action_id=? AND agent_id=? AND request_hash=?",
          )
          .get(sessionId, actionId, agentId, requestHash) as { result_json: string } | undefined;
        if (!existing) return;
        const prior = parseEnvelope(existing.result_json);
        if (prior.state === "succeeded" || prior.state === "failed") return;
        this.db
          .prepare(
            `UPDATE owner_agent_tool_actions SET result_json=?
             WHERE session_id=? AND action_id=? AND agent_id=? AND request_hash=?`,
          )
          .run(
            JSON.stringify({
              ...envelope,
              ...((envelope.nodeRequestHash ?? prior.nodeRequestHash)
                ? { nodeRequestHash: envelope.nodeRequestHash ?? prior.nodeRequestHash }
                : {}),
            }).slice(0, 100_000),
            sessionId,
            actionId,
            agentId,
            requestHash,
          );
        if (prior.state !== envelope.state)
          recordAgentActivity(this.db, {
            agentId,
            kind:
              prior.state === "unknown" && envelope.state !== "unknown"
                ? "receipt.corrected"
                : "operation.finished",
            referenceId: envelope.operationId,
            summary:
              envelope.state === "succeeded"
                ? "文件操作收据已确认成功。"
                : envelope.state === "failed"
                  ? "文件操作收据已确认失败。"
                  : "文件操作结果尚未确认。",
            detail: {
              operation: envelope.operation,
              result: envelope.result,
              error: envelope.error,
            },
            at: Date.now(),
          });
        if (prior.state === "unknown" && envelope.state !== "unknown")
          this.chat.notifyAgentReceiptCorrection(agentId, envelope.operationId, envelope.state);
      })
      .immediate();
  }

  private markToolActionUnknown(
    sessionId: string,
    actionId: string,
    agentId: string,
    requestHash: string,
    operationId: string,
    runId: string,
    channelId: string,
    operation: string,
    message: string,
    nodeRequestHash?: string,
  ): void {
    this.completeToolAction(sessionId, actionId, agentId, requestHash, {
      state: "unknown",
      operationId,
      runId,
      channelId,
      operation,
      ...(nodeRequestHash ? { nodeRequestHash } : {}),
      error: message,
    });
  }

  private trackActionOperation(
    operationId: string,
    identity: {
      sessionId: string;
      actionId: string;
      agentId: string;
      nodeId: string;
      runId: string;
      channelId: string;
      operation: string;
    },
  ): void {
    const previous = this.actionOperations.get(operationId);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => this.actionOperations.delete(operationId), 10 * 60_000);
    timer.unref?.();
    this.actionOperations.set(operationId, { ...identity, timer });
  }

  private clearActionOperation(operationId: string): void {
    const entry = this.actionOperations.get(operationId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.actionOperations.delete(operationId);
  }

  private receiveActionResult(nodeId: string, result: NodeWorkspaceOperationResult): void {
    let identity = this.actionOperations.get(result.operationId);
    if (!identity) {
      const row = this.db
        .prepare(
          `SELECT action.session_id,action.action_id,action.agent_id,action.operation,
                  action.request_hash,action.result_json,agent.node_id
           FROM owner_agent_tool_actions action
           JOIN owner_agents agent ON agent.id=action.agent_id
           WHERE json_extract(action.result_json,'$.operationId')=?
             AND action.agent_id=? AND action.operation LIKE 'workspace.%'`,
        )
        .get(result.operationId, result.agentId) as
        | {
            session_id: string;
            action_id: string;
            agent_id: string;
            operation: string;
            request_hash: string;
            result_json: string;
            node_id: string;
          }
        | undefined;
      if (!row || row.node_id !== nodeId) return;
      const prior = parseEnvelope(row.result_json);
      if (
        prior.operationId !== result.operationId ||
        typeof prior.runId !== "string" ||
        typeof prior.channelId !== "string"
      )
        return;
      identity = {
        sessionId: row.session_id,
        actionId: row.action_id,
        agentId: row.agent_id,
        nodeId: row.node_id,
        runId: prior.runId,
        channelId: prior.channelId,
        operation: row.operation,
      };
    }
    if (identity.nodeId !== nodeId || identity.agentId !== result.agentId) return;
    let envelope: {
      state: "unknown" | "succeeded" | "failed";
      operationId: string;
      runId: string;
      channelId: string;
      operation: string;
      nodeRequestHash?: string;
      revision?: number;
      result?: unknown;
      error?: string;
    };
    const revision = result.ok ? (result.revision ?? result.result.revision) : undefined;
    if (!result.ok) {
      envelope = {
        state: "unknown",
        operationId: result.operationId,
        runId: identity.runId,
        channelId: identity.channelId,
        operation: identity.operation,
        error: result.error,
      };
    } else if (result.result.code !== 0) {
      envelope = {
        state: result.result.stderr.startsWith("operation_unknown:") ? "unknown" : "failed",
        operationId: result.operationId,
        runId: identity.runId,
        channelId: identity.channelId,
        operation: identity.operation,
        ...(revision !== undefined ? { revision } : {}),
        result: { code: result.result.code, stderr: result.result.stderr },
        error: result.result.stderr || "File operation failed",
      };
    } else {
      try {
        envelope = {
          state: "succeeded",
          operationId: result.operationId,
          runId: identity.runId,
          channelId: identity.channelId,
          operation: identity.operation,
          ...(revision !== undefined ? { revision } : {}),
          result: JSON.parse(result.result.stdout) as unknown,
        };
      } catch {
        envelope = {
          state: "unknown",
          operationId: result.operationId,
          runId: identity.runId,
          channelId: identity.channelId,
          operation: identity.operation,
          ...(revision !== undefined ? { revision } : {}),
          error: "Invalid node receipt",
        };
      }
    }
    const row = this.db
      .prepare(
        "SELECT request_hash FROM owner_agent_tool_actions WHERE session_id=? AND action_id=?",
      )
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
    return new WorkspaceError("unsafe_path", "路径不在可读取的工作区范围内。", 403);
  if (/file_changed|file changed|changed while/i.test(message))
    return new WorkspaceError("file_changed", "文件在读取期间发生变化，请重新加载。", 409);
  if (/permission[_ ]denied|eacces|eperm/i.test(message))
    return new WorkspaceError("permission_denied", "当前运行账号没有读取此文件的权限。", 403);
  if (/enoent|not found|no such file or directory/i.test(message))
    return new WorkspaceError("not_found", "文件或目录不存在。", 404);
  if (/not_file|not_regular_file|regular single-link|is a directory/i.test(message))
    return new WorkspaceError("not_file", "只能读取普通文件。", 400);
  return new WorkspaceError("workspace_unavailable", "节点无法完成文件请求。", 502);
}

function confirmedFileFailure(code: number, stderr: string): WorkspaceError {
  const mapped = mapNodeError(stderr || "File request failed");
  return new WorkspaceError(mapped.code, `${mapped.message}（节点结果码 ${code}）`, mapped.status);
}

function isMutatingOperation(
  operation: Operation,
): operation is Extract<
  Operation,
  { kind: "write_bytes" | "write" | "edit" | "mkdir" | "move" | "remove" }
> {
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

function parseEnvelope(value: string): {
  state: string;
  operationId?: string;
  runId?: string;
  channelId?: string;
  operation?: string;
  nodeRequestHash?: string;
  revision?: number;
  result?: unknown;
} {
  try {
    const envelope = JSON.parse(value) as {
      state?: unknown;
      operationId?: unknown;
      runId?: unknown;
      channelId?: unknown;
      operation?: unknown;
      nodeRequestHash?: unknown;
      revision?: unknown;
      result?: unknown;
    };
    if (typeof envelope.state !== "string") throw new Error("Invalid action result");
    return {
      state: envelope.state,
      ...(typeof envelope.operationId === "string" ? { operationId: envelope.operationId } : {}),
      ...(typeof envelope.runId === "string" ? { runId: envelope.runId } : {}),
      ...(typeof envelope.channelId === "string" ? { channelId: envelope.channelId } : {}),
      ...(typeof envelope.operation === "string" ? { operation: envelope.operation } : {}),
      ...(typeof envelope.nodeRequestHash === "string"
        ? { nodeRequestHash: envelope.nodeRequestHash }
        : {}),
      ...(Number.isSafeInteger(envelope.revision) && (envelope.revision as number) > 0
        ? { revision: envelope.revision as number }
        : {}),
      ...(envelope.result === undefined ? {} : { result: envelope.result }),
    };
  } catch {
    throw new WorkspaceError("operation_unknown", "文件操作收据无法读取。", 409);
  }
}

function safeError(error: unknown): string {
  return (error instanceof WorkspaceError ? error.message : "文件操作结果尚未确认。").slice(0, 240);
}

function operationPaths(operation: Exclude<Operation, { kind: "exec" }>): string[] {
  return operation.kind === "move" ? [operation.path, operation.destination] : [operation.path];
}

function safeAuditPath(path: string, home?: string): string {
  const segments = path.split("/").filter((part) => part !== "" && part !== ".");
  if (path.includes("\0") || segments.includes("..")) return "[invalid path]";
  if (path.startsWith("/")) {
    if (!home?.startsWith("/")) return "[absolute path request]";
    const normalizedHome = posixPath.normalize(home),
      normalizedPath = posixPath.normalize(path);
    if (normalizedPath !== normalizedHome && !normalizedPath.startsWith(`${normalizedHome}/`))
      return "[absolute path request]";
    const relative = posixPath.relative(normalizedHome, normalizedPath);
    return relative.slice(0, 4096);
  }
  if (/^[A-Za-z]:[\\/]/.test(path)) return "[absolute path request]";
  const normalized = posixPath.normalize(path);
  return (normalized === "." ? "" : normalized).slice(0, 4096);
}

function workspaceAccessErrorCode(error: unknown): string {
  if (error instanceof WorkspaceError) return error.code;
  const message = error instanceof Error ? error.message : "";
  if (/file_changed|file changed|changed while/i.test(message)) return "file_changed";
  if (/permission denied|eacces|eperm/i.test(message)) return "permission_denied";
  if (/enoent|not found|no such file or directory/i.test(message)) return "not_found";
  if (/unsafe_path|symbolic link|symlink|escapes the workspace/i.test(message))
    return "unsafe_path";
  return "workspace_unavailable";
}
