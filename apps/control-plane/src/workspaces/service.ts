import { WorkspaceActionLedger } from "./action-ledger.js";
import { NodeRequestError } from "../nodes/pending-requests.js";
import { fileType, decodeText, textRange, unreadable } from "./file-content.js";
import { WorkspaceImage } from "./image-result.js";
import { workspaceVersionSchema } from "@mate/protocol/workspace";
import { workspaceDirectoryResultSchema, workspaceStatResultSchema } from "./results.js";
import { workspaceDownloadStatusSchema } from "./contracts.js";
import {
  isWorkspaceVersion,
  sameVersion,
  invalidNodeResponse,
  mapNodeError,
  confirmedFileFailure,
  isMutatingOperation,
  hashToolRequest,
  deterministicOperationId,
  parseOperationReceipt,
  safeError,
  operationPaths,
  safeAuditPath,
  workspaceAccessErrorCode,
} from "./results.js";
import { WorkspaceError } from "./errors.js";
import type { WorkspaceVersion } from "@mate/protocol/workspace";
import type { WorkspaceChunk, WorkspaceDownloadStatus } from "./contracts.js";
import { workspaceToolDefinitions } from "./tool-contracts.js";
import { z } from "zod";
import { defineAgentTool, type AgentToolContext } from "../runtime/tools/entry.js";
import { type Operation, type ControlWorkspaceOperation } from "@mate/protocol";

import { isDeepStrictEqual } from "node:util";
import { AgentSession } from "../runtime/session/service.js";
import type Database from "better-sqlite3";
import { workspaceReceiptRequestHash } from "@mate/protocol/node";
import type { OwnerChat } from "../conversations/service.js";
import { createHash, randomUUID } from "node:crypto";
import type { NodeDirectory } from "../nodes/directory.js";

const workspaceAgentSchema = z.looseObject({
  id: z.string(),
  node_id: z.string(),
  stage: z.string(),
  home: z.string().nullable(),
});
type WorkspaceAgent = z.infer<typeof workspaceAgentSchema>;

interface WorkspaceAccessAudit {
  principalKind: "owner" | "agent";
  principalId: string;
  agentId: string;
  runId?: string;
  operation: string;
  paths: string[];
}

const DOWNLOAD_STATUS_TTL_MS = 24 * 60 * 60 * 1000;

/** Owner reads and Agent file actions cross the paired node protocol one request at a time. */
export class WorkspaceService {
  agentTools() {
    return {
      "workspace.list": defineAgentTool(
        workspaceToolDefinitions["workspace.list"],
        (identity, input) => {
          return this.readForAgent(identity, {
            kind: "workspace_list",
            ...input,
          });
        },
        "Agent 文件请求被拒绝。",
      ),
      "workspace.stat": defineAgentTool(
        workspaceToolDefinitions["workspace.stat"],
        (identity, input) => {
          return this.readForAgent(identity, {
            kind: "workspace_stat",
            ...input,
          });
        },
        "Agent 文件请求被拒绝。",
      ),
      "workspace.read": defineAgentTool(
        workspaceToolDefinitions["workspace.read"],
        (identity, input) => {
          return this.readForAgent(identity, { kind: "read", ...input });
        },
        "Agent 文件请求被拒绝。",
      ),
      "workspace.read_chunk": defineAgentTool(
        workspaceToolDefinitions["workspace.read_chunk"],
        (identity, input) => {
          return this.readForAgent(identity, {
            kind: "workspace_read_chunk",
            ...input,
          });
        },
        "Agent 文件请求被拒绝。",
      ),
      "workspace.write": defineAgentTool(
        workspaceToolDefinitions["workspace.write"],
        (identity, input) => {
          return this.agentAction({
            ...identity,
            actionId: identity.toolCallId,
            operationName: "workspace.write",
            toolInput: input,
            operation: { kind: "write", ...input },
          });
        },
        "Agent 文件请求被拒绝。",
      ),
      "workspace.write_bytes": defineAgentTool(
        workspaceToolDefinitions["workspace.write_bytes"],
        (identity, input) => {
          return this.agentAction({
            ...identity,
            actionId: identity.toolCallId,
            operationName: "workspace.write_bytes",
            toolInput: input,
            operation: { kind: "write_bytes", ...input },
          });
        },
        "Agent 文件请求被拒绝。",
      ),
      "workspace.edit": defineAgentTool(
        workspaceToolDefinitions["workspace.edit"],
        (identity, input) => {
          return this.agentAction({
            ...identity,
            actionId: identity.toolCallId,
            operationName: "workspace.edit",
            toolInput: input,
            operation: { kind: "edit", ...input },
          });
        },
        "Agent 文件请求被拒绝。",
      ),
      "workspace.mkdir": defineAgentTool(
        workspaceToolDefinitions["workspace.mkdir"],
        (identity, input) => {
          return this.agentAction({
            ...identity,
            actionId: identity.toolCallId,
            operationName: "workspace.mkdir",
            toolInput: input,
            operation: { kind: "mkdir", ...input },
          });
        },
        "Agent 文件请求被拒绝。",
      ),
      "workspace.move": defineAgentTool(
        workspaceToolDefinitions["workspace.move"],
        (identity, input) => {
          return this.agentAction({
            ...identity,
            actionId: identity.toolCallId,
            operationName: "workspace.move",
            toolInput: input,
            operation: { kind: "move", ...input },
          });
        },
        "Agent 文件请求被拒绝。",
      ),
      "workspace.remove": defineAgentTool(
        workspaceToolDefinitions["workspace.remove"],
        (identity, input) => {
          return this.agentAction({
            ...identity,
            actionId: identity.toolCallId,
            operationName: "workspace.remove",
            toolInput: input,
            operation: { kind: "remove", ...input },
          });
        },
        "Agent 文件请求被拒绝。",
      ),
    };
  }

  private readonly downloadPruneTimer: ReturnType<typeof setInterval>;
  private readonly actions: WorkspaceActionLedger;

  constructor(
    private readonly db: Database.Database,
    private readonly nodes: NodeDirectory,
    chat: OwnerChat,
  ) {
    this.actions = new WorkspaceActionLedger(db, (agentId, operationId, state) =>
      chat.notifyAgentReceiptCorrection(agentId, operationId, state),
    );
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
      this.actions.receive(nodeId, result),
    );
  }

  close(): void {
    clearInterval(this.downloadPruneTimer);
    this.actions.close();
  }

  async list(agentId: string, path: string, offset = 0, limit = 32) {
    return this.withAccessAudit(
      { principalKind: "owner", principalId: "owner", agentId, operation: "list", paths: [path] },
      () => this.listUnchecked(agentId, path, offset, limit),
    );
  }

  private async listUnchecked(agentId: string, path: string, offset: number, limit: number) {
    const result = await this.readOperation(agentId, {
      kind: "workspace_list",
      path,
      offset,
      limit,
    });
    const parsed = workspaceDirectoryResultSchema.safeParse(result);
    if (!parsed.success) throw invalidNodeResponse();
    return parsed.data;
  }

  async stat(agentId: string, path: string) {
    return this.withAccessAudit(
      { principalKind: "owner", principalId: "owner", agentId, operation: "stat", paths: [path] },
      () => this.statUnchecked(agentId, path),
    );
  }

  private async statUnchecked(agentId: string, path: string) {
    const result = await this.readOperation(agentId, { kind: "workspace_stat", path });
    const parsed = workspaceStatResultSchema.safeParse(result);
    if (!parsed.success) throw invalidNodeResponse();
    return parsed.data;
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
    identity: AgentToolContext,
    operation: Extract<Operation, { kind: "workspace_stat" | "workspace_read_chunk" }>,
  ): Promise<Record<string, unknown>> {
    const { runId, agentId } = identity;
    return this.withAccessAudit(
      {
        principalKind: "agent",
        principalId: agentId,
        agentId,
        runId,
        operation: operation.kind,
        paths: [operation.path],
      },
      () => this.readForAgentPublishUnchecked(identity, operation),
    );
  }

  private async readForAgentPublishUnchecked(
    identity: AgentToolContext,
    operation: Extract<Operation, { kind: "workspace_stat" | "workspace_read_chunk" }>,
  ): Promise<Record<string, unknown>> {
    const { agentId } = identity;
    await identity.committed;
    identity.requireCurrentRun();
    const result = await this.runNodeOperation(
      {
        type: "control.workspace.operation",
        requestId: randomUUID(),
        operationId: randomUUID(),
        agentId,
        mode: "agent_publish",
        operation,
      },
      identity.run.node_id,
    );
    try {
      return z.record(z.string(), z.unknown()).parse(JSON.parse(result.stdout));
    } catch {
      throw invalidNodeResponse();
    }
  }

  /** The shared tool entry accepts Agent reads independently of the triggering conversation. */
  async readForAgent(
    identity: AgentToolContext,
    operation: Extract<
      Operation,
      { kind: "read" | "workspace_list" | "workspace_stat" | "workspace_read_chunk" }
    >,
  ): Promise<unknown> {
    const { runId, agentId } = identity;
    return this.withAccessAudit(
      {
        principalKind: "agent",
        principalId: agentId,
        agentId,
        runId,
        operation: operation.kind,
        paths: [operation.path],
      },
      () => this.readForAgentUnchecked(identity, operation),
    );
  }

  private async readForAgentUnchecked(
    identity: AgentToolContext,
    operation: Extract<
      Operation,
      { kind: "read" | "workspace_list" | "workspace_stat" | "workspace_read_chunk" }
    >,
  ): Promise<unknown> {
    await identity.committed;
    identity.requireCurrentRun();
    if (operation.kind === "read" || operation.kind === "workspace_read_chunk") {
      const version = operation.kind === "workspace_read_chunk" ? operation.version : undefined;
      const prefix = await this.agentChunk(identity, operation.path, 0, 8192, version);
      const type = fileType(prefix.bytes, prefix.totalBytes > prefix.bytes.length);
      if (type !== "text/plain") {
        if (operation.kind === "workspace_read_chunk")
          return {
            ...unreadable(type, "二进制分块不能直接读取；完整图片请使用 workspace.read。"),
            version: prefix.version,
            totalBytes: prefix.totalBytes,
          };
        if (!type.startsWith("image/")) return unreadable(type, "此文件类型不能直接读取。");
        if (prefix.totalBytes > 5 * 1024 * 1024)
          return unreadable(type, "图片超过 5 MiB 完整读取上限。");
        const chunks = [prefix.bytes];
        for (let offset = prefix.bytes.length; offset < prefix.totalBytes;) {
          const chunk = await this.agentChunk(
            identity,
            operation.path,
            offset,
            8192,
            prefix.version,
          );
          chunks.push(chunk.bytes);
          offset += chunk.bytes.length;
        }
        return new WorkspaceImage(type, Buffer.concat(chunks).toString("base64"));
      }
      if (operation.kind === "read") {
        if (prefix.totalBytes > 8192)
          throw new WorkspaceError(
            "not_file",
            "File exceeds read limit; use workspace.read_chunk",
            413,
          );
        return { content: decodeText(prefix.bytes) };
      }
      if (operation.offset > prefix.totalBytes)
        throw new WorkspaceError("not_file", "文件分块位置超出文件大小。", 416);
      const start = Math.max(0, operation.offset - 3);
      const end = Math.min(prefix.totalBytes, operation.offset + operation.length + 3);
      const parts: Buffer[] = [];
      for (let offset = start; offset < end;) {
        const chunk = await this.agentChunk(
          identity,
          operation.path,
          offset,
          Math.min(8192, end - offset),
          prefix.version,
        );
        parts.push(chunk.bytes);
        offset += chunk.bytes.length;
      }
      return {
        ...textRange(
          Buffer.concat(parts),
          start,
          operation.offset,
          operation.length,
          prefix.totalBytes,
        ),
        version: prefix.version,
      };
    }
    const result = await this.agentReadOperation(identity, operation);
    return parseOperationReceipt(result.stdout);
  }

  private async agentReadOperation(
    identity: AgentToolContext,
    operation: Extract<
      Operation,
      { kind: "workspace_list" | "workspace_stat" | "workspace_read_chunk" }
    >,
  ) {
    identity.requireCurrentRun();
    const result = await this.runNodeOperation(
      {
        type: "control.workspace.operation",
        requestId: randomUUID(),
        operationId: randomUUID(),
        agentId: identity.agentId,
        mode: "agent_read",
        operation,
      },
      identity.run.node_id,
    );
    identity.requireCurrentRun();
    return result;
  }

  private async agentChunk(
    identity: AgentToolContext,
    path: string,
    offset: number,
    length: number,
    version?: WorkspaceVersion,
  ) {
    const result = await this.agentReadOperation(identity, {
      kind: "workspace_read_chunk",
      path,
      offset,
      length,
      ...(version ? { version } : {}),
    });
    const parsed = z
      .object({
        base64: z.string(),
        offset: z.number().int().nonnegative(),
        totalBytes: z.number().int().nonnegative(),
        version: workspaceVersionSchema,
      })
      .safeParse(parseOperationReceipt(result.stdout));
    if (!parsed.success) throw invalidNodeResponse();
    const value = parsed.data;
    const bytes = Buffer.from(value.base64, "base64");
    if (
      bytes.toString("base64") !== value.base64 ||
      value.offset !== offset ||
      value.totalBytes !== value.version.size ||
      (version && !sameVersion(version, value.version)) ||
      bytes.length !== Math.min(length, Math.max(0, value.totalBytes - offset))
    )
      throw new WorkspaceError("invalid_response", "文件传输未读全或版本不一致。", 502);
    return { bytes, version: value.version, totalBytes: value.totalBytes };
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
    const row = z
      .looseObject({
        result: workspaceDownloadStatusSchema.shape.state,
        error_code: z.string().nullable(),
        download_expires_at: z.number(),
      })
      .optional()
      .parse(
        this.db
          .prepare(
            `SELECT result,error_code,download_expires_at FROM owner_workspace_access_audit
         WHERE download_id=? AND agent_id=? AND actor_kind='owner' AND operation='download'
           AND owner_session_hash=? AND download_expires_at>?`,
          )
          .get(downloadId, agentId, ownerSessionHash, Date.now()),
      );
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
  async agentAction(
    input: AgentToolContext & {
      actionId: string;
      operationName: string;
      toolInput: Record<string, unknown>;
      operation: Operation;
    },
  ): Promise<unknown> {
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

  private async agentActionUnchecked(
    input: AgentToolContext & {
      actionId: string;
      operationName: string;
      toolInput: Record<string, unknown>;
      operation: Operation;
    },
  ): Promise<unknown> {
    const authorized = input.run;
    if (!isMutatingOperation(input.operation))
      throw new WorkspaceError("workspace_unavailable", "此文件操作不允许修改工作区。", 403);
    if (!input.actionId.startsWith(`mate:${authorized.action_scope_id}:`)) {
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
      intent = {
        sessionId: authorized.session_id,
        actionId: input.actionId,
        agentId: input.agentId,
        operation: input.operationName,
        requestHash,
        nodeRequestHash,
        operationId,
        runId: input.runId,
        channelId: authorized.channel_id,
      },
      recorded = this.actions.prepare(intent, input.toolInput);
    if (recorded.kind === "done") return recorded.result;
    if (recorded.kind === "failed") throw confirmedFileFailure(recorded.code, recorded.stderr);
    await input.committed;
    this.actions.track(operationId, {
      sessionId: authorized.session_id,
      actionId: input.actionId,
      agentId: input.agentId,
      nodeId: authorized.node_id,
      runId: input.runId,
      channelId: authorized.channel_id,
      operation: input.operationName,
    });

    try {
      input.requireCurrentRun();
      const result = await this.runNodeOperation(
          {
            type: "control.workspace.operation",
            requestId: randomUUID(),
            operationId,
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
      this.actions.complete(intent, envelope);
      this.actions.forget(operationId);
      return value;
    } catch (error) {
      this.actions.markUnknown(intent, safeError(error));
      throw error;
    }
  }

  private async readOperation(
    agentId: string,
    operation: Extract<
      Operation,
      { kind: "workspace_list" | "workspace_stat" | "workspace_read_chunk" }
    >,
  ): Promise<Record<string, unknown>> {
    const agent = this.requireAgent(agentId);
    const result = await this.runNodeOperation(
      {
        type: "control.workspace.operation",
        requestId: randomUUID(),
        operationId: randomUUID(),
        agentId,
        mode: "owner_read",
        operation,
      },
      agent.node_id,
    );
    try {
      return z.record(z.string(), z.unknown()).parse(JSON.parse(result.stdout));
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
    const identity = z
        .looseObject({ home: z.string().nullable() })
        .optional()
        .parse(this.db.prepare("SELECT home FROM owner_agents WHERE id=?").get(access.agentId)),
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
      if (error instanceof NodeRequestError && error.code === "timeout")
        throw new WorkspaceError("operation_unknown", "文件操作结果尚未确认，不会自动重试。", 409);
      if (error instanceof NodeRequestError && error.code === "offline") {
        const agentId = request.agentId,
          agent = z
            .looseObject({ node_id: z.string() })
            .optional()
            .parse(this.db.prepare("SELECT node_id FROM owner_agents WHERE id=?").get(agentId)),
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
    const row = workspaceAgentSchema
      .optional()
      .parse(
        this.db
          .prepare(`SELECT a.id,a.node_id,a.stage,a.home FROM owner_agents a WHERE a.id=?`)
          .get(agentId),
      );
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
}
