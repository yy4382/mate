import { FILE_CHUNK_MAX_BYTES } from "@mate/protocol/workspace";
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync } from "node:fs";
import { z } from "zod";
import type { AgentToolContext } from "../runtime/tools/entry.js";
import { operationIdForAction } from "../runtime/tools/identity.js";
import { WorkspaceError } from "../workspaces/errors.js";
import { isWorkspaceVersion, sameVersion } from "../workspaces/results.js";
import type { WorkspaceReads } from "../workspaces/reads/service.js";
import { authorizeAgentConversation } from "./access.js";
import { AttachmentError } from "./errors.js";
import {
  canonicalJson,
  decodeChunk,
  parseActionResult,
  parsePublishedAttachment,
} from "./results.js";
import { insertUploadingAttachment, readReadyAttachment } from "./rows.js";
import {
  normalizeFilename,
  removeIfPresent,
  storagePath,
  syncDirectory,
  writeAll,
} from "./storage.js";

/** Reserves the publication before awaiting, then atomically commits bytes, metadata and receipt. */
export class AttachmentPublication {
  constructor(
    private readonly db: Database.Database,
    private readonly reads: Pick<WorkspaceReads, "readForAgentPublish">,
    private readonly directory: string,
    private readonly maximumBytes: number,
    private readonly now: () => number,
    private readonly beforeAgentCommit?: () => Promise<void>,
  ) {}
  async publishNodeFile(
    input: AgentToolContext & {
      actionId: string;
      operationName: string;
      toolInput: Record<string, unknown>;
      channelId: string;
      path: string;
      filename?: string;
    },
  ) {
    const scope = input.run;
    const filename = normalizeFilename(input.filename ?? input.path.split("/").at(-1) ?? "");
    authorizeAgentConversation(this.db, input.agentId, input.channelId);
    if (!filename) throw new AttachmentError("invalid_filename", "文件名无效。", 400);
    if (!input.actionId.startsWith(`mate:${scope.action_scope_id}:`))
      throw new AttachmentError("operation_conflict", "文件发布 ID 与当前消息授权不匹配。", 403);
    const operationId = operationIdForAction(input.actionId);
    const requestHash = createHash("sha256")
      .update(
        canonicalJson({
          operation: input.operationName,
          input: input.toolInput,
          destination: { path: input.path, filename, channelId: input.channelId },
        }),
      )
      .digest("hex");
    const id = randomUUID();
    const storageKey = randomUUID();
    const tempPath = storagePath(this.directory, `${storageKey}.uploading`);
    const finalPath = storagePath(this.directory, `${storageKey}.blob`);
    const createdAt = this.now();
    const contentType = "application/octet-stream";
    const reserve = this.db.transaction(() => {
      const existing = z
        .looseObject({ request_hash: z.string(), result_json: z.string() })
        .optional()
        .parse(
          this.db
            .prepare(
              `SELECT request_hash,result_json FROM owner_agent_tool_actions
           WHERE session_id=? AND action_id=?`,
            )
            .get(scope.session_id, input.actionId),
        );
      if (existing) {
        if (existing.request_hash !== requestHash)
          throw new AttachmentError("operation_conflict", "操作 ID 已用于另一份文件。", 409);
        const result = parseActionResult(existing.result_json);
        if (result.operationId !== operationId)
          throw new AttachmentError("operation_conflict", "文件发布收据与操作 ID 不匹配。", 409);
        if (result.state === "succeeded")
          return { kind: "done" as const, result: parsePublishedAttachment(result.result) };
        if (result.state === "failed")
          throw new AttachmentError("upload_failed", "文件发布失败。", 409);
        throw new AttachmentError("operation_unknown", "文件发布仍在执行或结果尚未确认。", 409);
      }
      this.db
        .prepare(
          `INSERT INTO owner_agent_tool_actions(
             session_id,action_id,agent_id,operation,request_hash,result_json,created_at
           ) VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          scope.session_id,
          input.actionId,
          input.agentId,
          input.operationName,
          requestHash,
          JSON.stringify({ state: "executing", operationId }),
          createdAt,
        );
      insertUploadingAttachment(this.db, {
        id,
        channelId: input.channelId,
        storageKey,
        filename,
        contentType,
        uploaderKind: "agent",
        uploaderId: input.agentId,
        createdAt,
      });
      return { kind: "started" as const };
    });
    const reservation = reserve.immediate();
    if (reservation.kind === "done") return reservation.result;
    await input.committed;
    try {
      const statResult = await this.reads.readForAgentPublish(input, {
        kind: "workspace_stat",
        path: input.path,
      });
      if (statResult.type !== "file" || !isWorkspaceVersion(statResult.version))
        throw new AttachmentError("workspace_unavailable", "只能发布普通文件。", 400);
      if (
        typeof statResult.size !== "number" ||
        !Number.isSafeInteger(statResult.size) ||
        statResult.size < 0 ||
        statResult.size > this.maximumBytes
      )
        throw new AttachmentError("too_large", "文件超过附件大小上限。", 413);
      const metadata = { size: statResult.size, version: statResult.version };
      const descriptor = openSync(tempPath, "wx", 0o600);
      const digest = createHash("sha256");
      let offset = 0;
      try {
        while (offset < metadata.size) {
          const chunkResult = await this.reads.readForAgentPublish(input, {
            kind: "workspace_read_chunk",
            path: input.path,
            offset,
            length: Math.min(FILE_CHUNK_MAX_BYTES, metadata.size - offset),
            version: metadata.version,
          });
          const bytes = decodeChunk(chunkResult, {
            offset,
            size: metadata.size,
            version: metadata.version,
          });
          if (!bytes.length)
            throw new WorkspaceError("file_changed", "File ended during publish", 409);
          digest.update(bytes);
          writeAll(descriptor, bytes, offset);
          offset += bytes.length;
        }
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      const finalStat = await this.reads.readForAgentPublish(input, {
        kind: "workspace_stat",
        path: input.path,
      });
      if (
        finalStat.type !== "file" ||
        !isWorkspaceVersion(finalStat.version) ||
        !sameVersion(metadata.version, finalStat.version)
      )
        throw new WorkspaceError("file_changed", "File changed while it was being published", 409);
      if (this.beforeAgentCommit) await this.beforeAgentCommit();
      const summary = this.db
        .transaction(() => {
          input.requireCurrentRun();
          renameSync(tempPath, finalPath);
          syncDirectory(this.directory);
          this.db
            .prepare(
              `UPDATE owner_conversation_attachments
             SET size=?,sha256=?,state='ready' WHERE id=? AND state='uploading'`,
            )
            .run(metadata.size, digest.digest("hex"), id);
          const result = readReadyAttachment(this.db, id);
          if (!result) throw new Error("Published attachment disappeared before commit");
          this.db
            .prepare(
              `UPDATE owner_agent_tool_actions SET result_json=?
             WHERE session_id=? AND action_id=? AND request_hash=?`,
            )
            .run(
              JSON.stringify({ state: "succeeded", operationId, result }),
              scope.session_id,
              input.actionId,
              requestHash,
            );
          return result;
        })
        .immediate();
      return summary;
    } catch (error) {
      removeIfPresent(tempPath);
      removeIfPresent(finalPath);
      this.db
        .prepare("DELETE FROM owner_conversation_attachments WHERE id=? AND state='uploading'")
        .run(id);
      const normalized =
        error instanceof AttachmentError
          ? error
          : error instanceof WorkspaceError
            ? new AttachmentError("workspace_unavailable", error.message, error.status)
            : new AttachmentError("upload_failed", "节点文件未能完整发布。", 409);
      this.db
        .prepare(
          `UPDATE owner_agent_tool_actions SET result_json=?
           WHERE session_id=? AND action_id=? AND request_hash=?`,
        )
        .run(
          JSON.stringify({ state: "failed", operationId, error: normalized.message }),
          scope.session_id,
          input.actionId,
          requestHash,
        );
      throw normalized;
    }
  }
}
