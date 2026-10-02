import {
  decodeChunk,
  operationIdForAction,
  parseActionResult,
  parsePublishedAttachment,
  canonicalJson,
} from "./results.js";
import { isWorkspaceVersion as isVersion, sameVersion } from "../workspaces/results.js";
import {
  streamUpload,
  normalizeFilename,
  normalizeContentType,
  syncFile,
  syncDirectory,
  removeIfPresent,
  writeAll,
} from "./storage.js";
import { attachmentRowSchema, toSummary } from "./rows.js";
import { AttachmentError } from "./errors.js";
import type { AttachmentSummary } from "@mate/protocol/owner";
import { attachmentToolDefinitions } from "./tool-contracts.js";
import { z } from "zod";
import { defineAgentTool, type AgentToolContext } from "../runtime/tools/entry.js";
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
} from "node:fs";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { dirname, isAbsolute, resolve } from "node:path";
import { WorkspaceService } from "../workspaces/service.js";
import { WorkspaceError } from "../workspaces/errors.js";

export const DEFAULT_ATTACHMENT_MAX_BYTES = 512 * 1024 * 1024;

/** Conversation file storage uses bounded streams and private, server-generated paths. */
export class AttachmentService {
  agentTools() {
    return {
      "attachments.list": defineAgentTool(
        attachmentToolDefinitions["attachments.list"],
        (identity, input) => {
          return {
            attachments: this.listForAgent(identity.agentId, input.conversationId),
          };
        },
        "Agent 文件请求被拒绝。",
      ),
      "attachments.read_chunk": defineAgentTool(
        attachmentToolDefinitions["attachments.read_chunk"],
        (identity, input) => {
          return this.readChunkForAgent({ ...identity, ...input, channelId: input.conversationId });
        },
        "Agent 文件请求被拒绝。",
      ),
      "attachments.publish": defineAgentTool(
        attachmentToolDefinitions["attachments.publish"],
        (identity, input) => {
          return this.publishNodeFile({
            ...identity,
            path: input.path,
            ...(input.filename === undefined ? {} : { filename: input.filename }),
            actionId: identity.toolCallId,
            operationName: "attachments.publish",
            toolInput: input,
            channelId: input.conversationId,
          });
        },
        "Agent 文件请求被拒绝。",
      ),
    };
  }

  private readonly directory: string;
  private readonly maximumBytes: number;

  constructor(
    private readonly db: Database.Database,
    private readonly workspaces: WorkspaceService,
    directory: string,
    maximumBytes = DEFAULT_ATTACHMENT_MAX_BYTES,
    private readonly now: () => number = Date.now,
    private readonly beforeAgentCommit?: () => Promise<void>,
  ) {
    if (!isAbsolute(directory)) throw new Error("Attachment storage path must be absolute");
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
      throw new Error("Attachment size limit must be a positive integer");
    this.directory = resolve(directory);
    this.maximumBytes = maximumBytes;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const directoryStat = lstatSync(this.directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
      throw new Error("Attachment storage must be a real directory");
    this.recoverInterruptedUploads();
  }

  listForOwner(channelId: string): AttachmentSummary[] {
    this.requireOwnerMembership(channelId, false);
    const rows = attachmentRowSchema.array().parse(
      this.db
        .prepare(
          `SELECT id,channel_id,storage_key,filename,content_type,size,sha256,
                uploader_kind,uploader_id,created_at
         FROM owner_conversation_attachments
         WHERE channel_id=? AND state='ready' ORDER BY created_at,id`,
        )
        .all(channelId),
    );
    return rows.map(toSummary);
  }

  listForAgent(agentId: string, channelId: string): AttachmentSummary[] {
    this.authorizeAgentConversationRead(agentId, channelId);
    const rows = attachmentRowSchema.array().parse(
      this.db
        .prepare(
          `SELECT id,channel_id,storage_key,filename,content_type,size,sha256,
                uploader_kind,uploader_id,created_at
         FROM owner_conversation_attachments
         WHERE channel_id=? AND state='ready' ORDER BY created_at,id`,
        )
        .all(channelId),
    );
    return rows.map(toSummary);
  }

  readChunkForAgent(input: {
    runId: string;
    agentId: string;
    channelId: string;
    attachmentId: string;
    offset: number;
    length: number;
  }): { attachment: AttachmentSummary; offset: number; totalBytes: number; base64: string } {
    this.authorizeAgentConversationRead(input.agentId, input.channelId);
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      !Number.isSafeInteger(input.length) ||
      input.length < 1 ||
      input.length > 8192
    )
      throw new AttachmentError("attachment_not_found", "附件分块参数无效。", 400);
    const row = attachmentRowSchema.optional().parse(
      this.db
        .prepare(
          `SELECT id,channel_id,storage_key,filename,content_type,size,sha256,
                uploader_kind,uploader_id,created_at
         FROM owner_conversation_attachments
         WHERE id=? AND channel_id=? AND state='ready'`,
        )
        .get(input.attachmentId, input.channelId),
    );
    if (!row) throw new AttachmentError("attachment_not_found", "附件不存在。", 404);
    if (input.offset > row.size)
      throw new AttachmentError("attachment_not_found", "附件分块位置超出文件大小。", 416);
    const path = this.storagePath(`${row.storage_key}.blob`),
      beforePath = lstatSync(path);
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size !== row.size)
      throw new AttachmentError("attachment_not_found", "附件内容暂不可用。", 404);
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(descriptor, { bigint: true });
      if (
        !before.isFile() ||
        before.size !== BigInt(row.size) ||
        before.ino !== BigInt(beforePath.ino)
      )
        throw new AttachmentError("attachment_not_found", "附件内容暂不可用。", 404);
      const bytes = Buffer.alloc(Math.min(input.length, row.size - input.offset));
      let count = 0;
      while (count < bytes.length) {
        const read = readSync(descriptor, bytes, count, bytes.length - count, input.offset + count);
        if (!read) break;
        count += read;
      }
      const after = fstatSync(descriptor, { bigint: true });
      if (
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw new AttachmentError("attachment_not_found", "附件内容读取期间发生变化。", 409);
      return {
        attachment: toSummary(row),
        offset: input.offset,
        totalBytes: row.size,
        base64: bytes.subarray(0, count).toString("base64"),
      };
    } finally {
      closeSync(descriptor);
    }
  }

  async uploadForOwner(input: {
    channelId: string;
    filename: string;
    contentType: string;
    body: ReadableStream<Uint8Array>;
    expectedLength?: number;
  }): Promise<AttachmentSummary> {
    this.requireOwnerMembership(input.channelId, true);
    const filename = normalizeFilename(input.filename);
    if (!filename) throw new AttachmentError("invalid_filename", "文件名无效。", 400);
    if (
      input.expectedLength !== undefined &&
      (!Number.isSafeInteger(input.expectedLength) ||
        input.expectedLength < 0 ||
        input.expectedLength > this.maximumBytes)
    )
      throw new AttachmentError("too_large", "附件超过文件大小上限。", 413);
    const id = randomUUID(),
      storageKey = randomUUID(),
      tempPath = this.storagePath(`${storageKey}.uploading`),
      finalPath = this.storagePath(`${storageKey}.blob`),
      createdAt = this.now();
    insertUploading(this.db, {
      id,
      channelId: input.channelId,
      storageKey,
      filename,
      contentType: normalizeContentType(input.contentType),
      uploaderKind: "human",
      uploaderId: "owner",
      createdAt,
    });

    try {
      const outcome = await streamUpload(input.body, tempPath, this.maximumBytes);
      if (input.expectedLength !== undefined && outcome.size !== input.expectedLength)
        throw new Error("Attachment length did not match Content-Length");
      syncFile(tempPath);
      renameSync(tempPath, finalPath);
      syncDirectory(this.directory);
      this.db
        .prepare(
          `UPDATE owner_conversation_attachments
           SET size=?,sha256=?,state='ready' WHERE id=? AND state='uploading'`,
        )
        .run(outcome.size, outcome.sha256, id);
      return this.readReady(id)!;
    } catch (error) {
      removeIfPresent(tempPath);
      removeIfPresent(finalPath);
      this.db
        .prepare("DELETE FROM owner_conversation_attachments WHERE id=? AND state='uploading'")
        .run(id);
      if (error instanceof AttachmentError) throw error;
      const message = error instanceof Error ? error.message : "Attachment stream failed";
      if (/too large/i.test(message))
        throw new AttachmentError("too_large", "附件超过文件大小上限。", 413);
      throw new AttachmentError("upload_failed", "附件上传中断，未保存文件。", 400);
    }
  }

  downloadForOwner(
    channelId: string,
    attachmentId: string,
  ): { attachment: AttachmentSummary; stream: ReadableStream<Uint8Array> } {
    this.requireOwnerMembership(channelId, false);
    const row = attachmentRowSchema.optional().parse(
      this.db
        .prepare(
          `SELECT id,channel_id,storage_key,filename,content_type,size,sha256,
                uploader_kind,uploader_id,created_at
         FROM owner_conversation_attachments
         WHERE id=? AND channel_id=? AND state='ready'`,
        )
        .get(attachmentId, channelId),
    );
    if (!row) throw new AttachmentError("attachment_not_found", "附件不存在。", 404);
    const path = this.storagePath(`${row.storage_key}.blob`),
      stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== row.size)
      throw new AttachmentError("attachment_not_found", "附件内容暂不可用。", 404);
    return {
      attachment: toSummary(row),
      stream: Readable.toWeb(
        createReadStream(path, { highWaterMark: 64 * 1024 }),
      ) as ReadableStream<Uint8Array>,
    };
  }

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
    const scope = input.run,
      filename = normalizeFilename(input.filename ?? input.path.split("/").at(-1) ?? "");
    this.authorizeAgentConversation(input.agentId, input.channelId);
    if (!filename) throw new AttachmentError("invalid_filename", "文件名无效。", 400);
    if (!input.actionId.startsWith(`mate:${scope.action_scope_id}:`))
      throw new AttachmentError("operation_conflict", "文件发布 ID 与当前消息授权不匹配。", 403);
    const operationId = operationIdForAction(input.actionId),
      requestHash = createHash("sha256")
        .update(
          canonicalJson({
            operation: input.operationName,
            input: input.toolInput,
            destination: { path: input.path, filename, channelId: input.channelId },
          }),
        )
        .digest("hex"),
      id = randomUUID(),
      storageKey = randomUUID(),
      tempPath = this.storagePath(`${storageKey}.uploading`),
      finalPath = this.storagePath(`${storageKey}.blob`),
      createdAt = this.now(),
      contentType = "application/octet-stream";
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
      insertUploading(this.db, {
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
      const statResult = await this.workspaces.readForAgentPublish(input, {
        kind: "workspace_stat",
        path: input.path,
      });
      if (statResult.type !== "file" || !isVersion(statResult.version))
        throw new AttachmentError("workspace_unavailable", "只能发布普通文件。", 400);
      if (
        typeof statResult.size !== "number" ||
        !Number.isSafeInteger(statResult.size) ||
        statResult.size < 0 ||
        statResult.size > this.maximumBytes
      )
        throw new AttachmentError("too_large", "文件超过附件大小上限。", 413);
      const metadata = { size: statResult.size, version: statResult.version };
      const descriptor = openSync(tempPath, "wx", 0o600),
        digest = createHash("sha256");
      let offset = 0;
      try {
        while (offset < metadata.size) {
          const chunkResult = await this.workspaces.readForAgentPublish(input, {
            kind: "workspace_read_chunk",
            path: input.path,
            offset,
            length: Math.min(8192, metadata.size - offset),
            version: metadata.version,
          });
          const bytes = decodeChunk(chunkResult, offset, metadata.size, metadata.version);
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
      const finalStat = await this.workspaces.readForAgentPublish(input, {
        kind: "workspace_stat",
        path: input.path,
      });
      if (
        finalStat.type !== "file" ||
        !isVersion(finalStat.version) ||
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
          const result = this.readReady(id);
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

  /**
   * Attachment reads follow conversation visibility: a public channel's attachments are
   * readable by any Agent with an active run, while a private conversation stays member-only.
   * A direct message is never opened by visibility, even if one were ever stored public.
   */
  private authorizeAgentConversationRead(agentId: string, channelId: string): void {
    const row = this.db
      .prepare(
        `SELECT 1
         FROM owner_channels c
         LEFT JOIN owner_channel_memberships member ON member.channel_id=?
           AND member.principal_kind='agent' AND member.principal_id=? AND member.active=1
         WHERE c.id=? AND c.archived=0
           AND (member.active=1 OR (
             c.visibility='public'
             AND NOT EXISTS (
               SELECT 1 FROM owner_agent_direct_channels d WHERE d.channel_id=c.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM owner_agent_peer_direct_channels p WHERE p.channel_id=c.id
             )
           ))`,
      )
      .get(channelId, agentId, channelId);
    if (!row)
      throw new AttachmentError(
        "conversation_unavailable",
        "Agent 当前无权读取此对话的附件。",
        403,
      );
  }

  /** Publishing still requires membership, even where reading does not. */
  private authorizeAgentConversation(agentId: string, channelId: string): void {
    const row = this.db
      .prepare(
        `SELECT 1
         FROM owner_channels c
         JOIN owner_channel_memberships agent ON agent.channel_id=?
           AND agent.principal_kind='agent' AND agent.principal_id=? AND agent.active=1
         WHERE c.id=? AND c.archived=0`,
      )
      .get(channelId, agentId, channelId);
    if (!row)
      throw new AttachmentError(
        "conversation_unavailable",
        "Agent 当前不是此对话成员，无法发布附件。",
        403,
      );
  }

  private requireOwnerMembership(channelId: string, forUpload: boolean): void {
    const row = z
      .looseObject({ archived: z.number() })
      .optional()
      .parse(
        this.db
          .prepare(
            `SELECT c.archived FROM owner_channels c
         JOIN owner_channel_memberships m ON m.channel_id=c.id
           AND m.principal_kind='human' AND m.principal_id='owner' AND m.active=1
         WHERE c.id=?`,
          )
          .get(channelId),
      );
    if (!row || (forUpload && row.archived))
      throw new AttachmentError(
        "conversation_unavailable",
        "对话不存在、已归档或当前不可写。",
        404,
      );
  }

  private readReady(id: string): AttachmentSummary | undefined {
    const row = attachmentRowSchema.optional().parse(
      this.db
        .prepare(
          `SELECT id,channel_id,storage_key,filename,content_type,size,sha256,
                uploader_kind,uploader_id,created_at
         FROM owner_conversation_attachments WHERE id=? AND state='ready'`,
        )
        .get(id),
    );
    return row ? toSummary(row) : undefined;
  }

  private storagePath(name: string): string {
    const path = resolve(this.directory, name);
    if (dirname(path) !== this.directory) throw new Error("Invalid attachment storage key");
    return path;
  }

  private recoverInterruptedUploads(): void {
    const interrupted = z
      .looseObject({ id: z.string(), storage_key: z.string() })
      .array()
      .parse(
        this.db
          .prepare(
            `SELECT id,storage_key FROM owner_conversation_attachments WHERE state='uploading'`,
          )
          .all(),
      );
    const recover = this.db.transaction(() => {
      for (const row of interrupted) {
        removeIfPresent(this.storagePath(`${row.storage_key}.uploading`));
        removeIfPresent(this.storagePath(`${row.storage_key}.blob`));
        this.db
          .prepare("DELETE FROM owner_conversation_attachments WHERE id=? AND state='uploading'")
          .run(row.id);
      }
      const actions = z
        .looseObject({ session_id: z.string(), action_id: z.string(), result_json: z.string() })
        .array()
        .parse(
          this.db
            .prepare(
              "SELECT session_id,action_id,result_json FROM owner_agent_tool_actions WHERE operation='attachments.publish'",
            )
            .all(),
        );
      for (const action of actions) {
        const result = parseActionResult(action.result_json);
        if (result.state === "executing")
          this.db
            .prepare(
              "UPDATE owner_agent_tool_actions SET result_json=? WHERE session_id=? AND action_id=?",
            )
            .run(
              JSON.stringify({
                state: "failed",
                operationId: result.operationId,
                error: "文件发布在控制面重启时中断。",
              }),
              action.session_id,
              action.action_id,
            );
      }
    });
    recover.immediate();
    for (const name of readdirSync(this.directory))
      if (name.endsWith(".uploading")) removeIfPresent(this.storagePath(name));
  }
}

function insertUploading(
  db: Database.Database,
  input: {
    id: string;
    channelId: string;
    storageKey: string;
    filename: string;
    contentType: string;
    uploaderKind: "human" | "agent";
    uploaderId: string;
    createdAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO owner_conversation_attachments(
       id,channel_id,storage_key,filename,content_type,size,sha256,uploader_kind,uploader_id,state,created_at
     ) VALUES(?,?,?,?,?,0,? ,?,?,'uploading',?)`,
  ).run(
    input.id,
    input.channelId,
    input.storageKey,
    input.filename,
    input.contentType,
    "0".repeat(64),
    input.uploaderKind,
    input.uploaderId,
    input.createdAt,
  );
}
