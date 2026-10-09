import type { AttachmentSummary } from "@mate/protocol/owner";
import { FILE_CHUNK_MAX_BYTES } from "@mate/protocol/workspace";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { defineAgentTool } from "../runtime/tools/entry.js";
import { fileType, textRange, unreadable } from "../workspaces/reads/file-content.js";
import type { WorkspaceReads } from "../workspaces/reads/service.js";
import { authorizeAgentConversationRead, requireOwnerMembership } from "./access.js";
import { AttachmentError } from "./errors.js";
import { AttachmentPublication } from "./publication.js";
import { parseActionResult } from "./results.js";
import {
  attachmentRowSchema,
  insertUploadingAttachment,
  readReadyAttachment,
  toAttachmentSummary,
} from "./rows.js";
import {
  normalizeContentType,
  normalizeFilename,
  removeIfPresent,
  storagePath,
  streamUpload,
  syncDirectory,
  syncFile,
} from "./storage.js";
import { attachmentToolDefinitions } from "./tool-contracts.js";

export const DEFAULT_ATTACHMENT_MAX_BYTES = 512 * 1024 * 1024;

/** Conversation file storage uses bounded streams and private, server-generated paths. */
export class AttachmentService {
  agentTools() {
    return {
      "attachments.list": defineAgentTool(
        attachmentToolDefinitions["attachments.list"],
        (identity, input) => ({
          attachments: this.listForAgent({
            agentId: identity.agentId,
            channelId: input.conversationId,
          }),
        }),
        "Agent 文件请求被拒绝。",
      ),
      "attachments.read_chunk": defineAgentTool(
        attachmentToolDefinitions["attachments.read_chunk"],
        (identity, input) =>
          this.readChunkForAgent({ ...identity, ...input, channelId: input.conversationId }),
        "Agent 文件请求被拒绝。",
      ),
      "attachments.publish": defineAgentTool(
        attachmentToolDefinitions["attachments.publish"],
        (identity, input) =>
          this.publication.publishNodeFile({
            ...identity,
            path: input.path,
            ...(input.filename === undefined ? {} : { filename: input.filename }),
            actionId: identity.toolCallId,
            operationName: "attachments.publish",
            toolInput: input,
            channelId: input.conversationId,
          }),
        "Agent 文件请求被拒绝。",
      ),
    };
  }

  private readonly directory: string;
  private readonly maximumBytes: number;
  readonly publication: AttachmentPublication;

  constructor(
    private readonly db: Database.Database,
    reads: Pick<WorkspaceReads, "readForAgentPublish">,
    directory: string,
    maximumBytes = DEFAULT_ATTACHMENT_MAX_BYTES,
    private readonly now: () => number = Date.now,
    beforeAgentCommit?: () => Promise<void>,
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
    this.publication = new AttachmentPublication(
      db,
      reads,
      this.directory,
      maximumBytes,
      now,
      beforeAgentCommit,
    );
  }

  listForOwner(channelId: string): AttachmentSummary[] {
    requireOwnerMembership(this.db, channelId, false);
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
    return rows.map(toAttachmentSummary);
  }

  listForAgent({
    agentId,
    channelId,
  }: {
    agentId: string;
    channelId: string;
  }): AttachmentSummary[] {
    authorizeAgentConversationRead(this.db, agentId, channelId);
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
    return rows.map(toAttachmentSummary);
  }

  readChunkForAgent(input: {
    runId: string;
    agentId: string;
    channelId: string;
    attachmentId: string;
    offset: number;
    length: number;
  }) {
    authorizeAgentConversationRead(this.db, input.agentId, input.channelId);
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      !Number.isSafeInteger(input.length) ||
      input.length < 1 ||
      input.length > FILE_CHUNK_MAX_BYTES
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
    const path = storagePath(this.directory, `${row.storage_key}.blob`);
    const beforePath = lstatSync(path);
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
      const readRange = (offset: number, length: number) => {
        const bytes = Buffer.alloc(Math.min(length, row.size - offset));
        let count = 0;
        while (count < bytes.length) {
          const read = readSync(descriptor, bytes, count, bytes.length - count, offset + count);
          if (!read) throw new AttachmentError("attachment_not_found", "附件内容传输未读全。", 409);
          count += read;
        }
        return bytes;
      };
      const prefix = readRange(0, FILE_CHUNK_MAX_BYTES);
      const type = fileType(prefix, row.size > prefix.length);
      const start = Math.max(0, input.offset - 3);
      const end = Math.min(row.size, input.offset + input.length + 3);
      const content =
        type === "text/plain"
          ? textRange(readRange(start, end - start), {
              readOffset: start,
              offset: input.offset,
              length: input.length,
              totalBytes: row.size,
            })
          : unreadable(type, "上传图片或二进制附件不能直接读取。");
      const after = fstatSync(descriptor, { bigint: true });
      if (
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw new AttachmentError("attachment_not_found", "附件内容读取期间发生变化。", 409);
      return { attachment: toAttachmentSummary(row), totalBytes: row.size, ...content };
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
    requireOwnerMembership(this.db, input.channelId, true);
    const filename = normalizeFilename(input.filename);
    if (!filename) throw new AttachmentError("invalid_filename", "文件名无效。", 400);
    if (
      input.expectedLength !== undefined &&
      (!Number.isSafeInteger(input.expectedLength) ||
        input.expectedLength < 0 ||
        input.expectedLength > this.maximumBytes)
    )
      throw new AttachmentError("too_large", "附件超过文件大小上限。", 413);
    const id = randomUUID();
    const storageKey = randomUUID();
    const tempPath = storagePath(this.directory, `${storageKey}.uploading`);
    const finalPath = storagePath(this.directory, `${storageKey}.blob`);
    const createdAt = this.now();
    insertUploadingAttachment(this.db, {
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
      return readReadyAttachment(this.db, id)!;
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

  downloadForOwner({ channelId, attachmentId }: { channelId: string; attachmentId: string }) {
    requireOwnerMembership(this.db, channelId, false);
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
    const path = storagePath(this.directory, `${row.storage_key}.blob`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== row.size)
      throw new AttachmentError("attachment_not_found", "附件内容暂不可用。", 404);
    return {
      attachment: toAttachmentSummary(row),
      // The file ReadStream has no encoding, so its chunks are Buffer/Uint8Array bytes.
      stream: Readable.toWeb(
        createReadStream(path, { highWaterMark: 64 * 1024 }),
      ) as ReadableStream<Uint8Array>,
    };
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
        removeIfPresent(storagePath(this.directory, `${row.storage_key}.uploading`));
        removeIfPresent(storagePath(this.directory, `${row.storage_key}.blob`));
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
      if (name.endsWith(".uploading")) removeIfPresent(storagePath(this.directory, name));
  }
}
