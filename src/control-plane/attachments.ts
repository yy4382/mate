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
  unlinkSync,
  writeSync,
  createWriteStream,
} from "node:fs";
import { createReadStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { WorkspaceService, WorkspaceError, type WorkspaceVersion } from "./workspace.js";

export const DEFAULT_ATTACHMENT_MAX_BYTES = 512 * 1024 * 1024;

export class AttachmentError extends Error {
  constructor(
    readonly code:
      | "conversation_unavailable"
      | "attachment_not_found"
      | "invalid_filename"
      | "too_large"
      | "upload_failed"
      | "workspace_unavailable"
      | "operation_conflict"
      | "operation_unknown",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

export interface AttachmentSummary {
  id: string;
  channelId: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  uploader: { kind: "human"; id: "owner" } | { kind: "agent"; id: string };
  createdAt: number;
}

interface AttachmentRow {
  id: string;
  channel_id: string;
  storage_key: string;
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  uploader_kind: "human" | "agent";
  uploader_id: string;
  created_at: number;
}

/** Conversation file storage uses bounded streams and private, server-generated paths. */
export class AttachmentService {
  private readonly directory: string;
  private readonly maximumBytes: number;

  constructor(
    private readonly db: Database.Database,
    private readonly workspaces: WorkspaceService,
    directory: string,
    maximumBytes = DEFAULT_ATTACHMENT_MAX_BYTES,
    private readonly now: () => number = Date.now,
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
    const rows = this.db
      .prepare(
        `SELECT id,channel_id,storage_key,filename,content_type,size,sha256,
                uploader_kind,uploader_id,created_at
         FROM owner_conversation_attachments
         WHERE channel_id=? AND state='ready' ORDER BY created_at,id`,
      )
      .all(channelId) as AttachmentRow[];
    return rows.map(toSummary);
  }

  listForAgent(runId: string, agentId: string, channelId: string): AttachmentSummary[] {
    this.authorizeAgentConversation(runId, agentId, channelId);
    const rows = this.db
      .prepare(
        `SELECT id,channel_id,storage_key,filename,content_type,size,sha256,
                uploader_kind,uploader_id,created_at
         FROM owner_conversation_attachments
         WHERE channel_id=? AND state='ready' ORDER BY created_at,id`,
      )
      .all(channelId) as AttachmentRow[];
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
    this.authorizeAgentConversation(input.runId, input.agentId, input.channelId);
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      !Number.isSafeInteger(input.length) ||
      input.length < 1 ||
      input.length > 8192
    )
      throw new AttachmentError("attachment_not_found", "附件分块参数无效。", 400);
    const row = this.db
      .prepare(
        `SELECT id,channel_id,storage_key,filename,content_type,size,sha256,
                uploader_kind,uploader_id,created_at
         FROM owner_conversation_attachments
         WHERE id=? AND channel_id=? AND state='ready'`,
      )
      .get(input.attachmentId, input.channelId) as AttachmentRow | undefined;
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
    const row = this.db
      .prepare(
        `SELECT id,channel_id,storage_key,filename,content_type,size,sha256,
                uploader_kind,uploader_id,created_at
         FROM owner_conversation_attachments
         WHERE id=? AND channel_id=? AND state='ready'`,
      )
      .get(attachmentId, channelId) as AttachmentRow | undefined;
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

  async publishNodeFile(input: {
    runId: string;
    agentId: string;
    actionId: string;
    operationName: string;
    toolInput: Record<string, unknown>;
    channelId: string;
    path: string;
    filename?: string;
  }): Promise<AttachmentSummary> {
    const scope = this.authorizeAgentRun(input.runId, input.agentId),
      filename = normalizeFilename(input.filename ?? input.path.split("/").at(-1) ?? "");
    this.authorizeAgentConversation(input.runId, input.agentId, input.channelId);
    if (!filename) throw new AttachmentError("invalid_filename", "文件名无效。", 400);
    if (!input.actionId.startsWith(`mate:${scope.delivery_id}:`))
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
      const existing = this.db
        .prepare(
          `SELECT request_hash,result_json FROM owner_agent_tool_actions
           WHERE session_id=? AND action_id=?`,
        )
        .get(scope.session_id, input.actionId) as
        { request_hash: string; result_json: string } | undefined;
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
    try {
      const statResult = await this.workspaces.readForAgentPublish(input.runId, input.agentId, {
        kind: "workspace_stat",
        path: input.path,
      });
      if (statResult.type !== "file" || !isVersion(statResult.version))
        throw new AttachmentError("workspace_unavailable", "只能发布普通文件。", 400);
      const metadata = statResult as { size: number; version: WorkspaceVersion };
      if (
        !Number.isSafeInteger(metadata.size) ||
        metadata.size < 0 ||
        metadata.size > this.maximumBytes
      )
        throw new AttachmentError("too_large", "文件超过附件大小上限。", 413);
      const descriptor = openSync(tempPath, "wx", 0o600),
        digest = createHash("sha256");
      let offset = 0;
      try {
        while (offset < metadata.size) {
          const chunkResult = await this.workspaces.readForAgentPublish(
            input.runId,
            input.agentId,
            {
              kind: "workspace_read_chunk",
              path: input.path,
              offset,
              length: Math.min(8192, metadata.size - offset),
              version: metadata.version,
            },
          );
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
      const finalStat = await this.workspaces.readForAgentPublish(input.runId, input.agentId, {
        kind: "workspace_stat",
        path: input.path,
      });
      if (
        finalStat.type !== "file" ||
        !isVersion(finalStat.version) ||
        !sameVersion(metadata.version, finalStat.version)
      )
        throw new WorkspaceError("file_changed", "File changed while it was being published", 409);
      renameSync(tempPath, finalPath);
      syncDirectory(this.directory);
      const summary = this.db
        .transaction(() => {
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

  private authorizeAgentRun(
    runId: string,
    agentId: string,
  ): {
    session_id: string;
    node_id: string;
    delivery_id: string;
    channel_id: string;
  } {
    const row = this.db
      .prepare(
        `SELECT s.id AS session_id,r.node_id,r.delivery_id,d.channel_id
         FROM owner_agent_runs r JOIN owner_message_deliveries d ON d.id=r.delivery_id
         JOIN owner_agents a ON a.id=r.agent_id
         JOIN owner_agent_sessions s ON s.agent_id=a.id
         JOIN owner_channel_memberships m ON m.channel_id=d.channel_id
           AND m.principal_kind='agent' AND m.principal_id=a.id AND m.active=1
         JOIN owner_channel_memberships human ON human.channel_id=d.channel_id
           AND human.principal_kind='human' AND human.principal_id='owner' AND human.active=1
         WHERE r.id=? AND r.agent_id=? AND r.state='running'
           AND s.verified_at IS NOT NULL AND a.status IN ('waiting_credentials','ready')`,
      )
      .get(runId, agentId) as
      { session_id: string; node_id: string; delivery_id: string; channel_id: string } | undefined;
    if (!row)
      throw new AttachmentError(
        "conversation_unavailable",
        "当前 Agent 运行无权发布到此对话。",
        403,
      );
    return row;
  }

  private authorizeAgentConversation(runId: string, agentId: string, channelId: string): void {
    const row = this.db
      .prepare(
        `SELECT 1
         FROM owner_agent_runs r
         JOIN owner_agents a ON a.id=r.agent_id AND a.node_id=r.node_id
         JOIN owner_agent_sessions s ON s.agent_id=a.id AND s.verified_at IS NOT NULL
         JOIN owner_channels c ON c.id=? AND c.archived=0
         JOIN owner_channel_memberships agent ON agent.channel_id=?
           AND agent.principal_kind='agent' AND agent.principal_id=a.id AND agent.active=1
         WHERE r.id=? AND r.agent_id=? AND r.state='running'
           AND a.status IN ('waiting_credentials','ready')`,
      )
      .get(channelId, channelId, runId, agentId);
    if (!row)
      throw new AttachmentError(
        "conversation_unavailable",
        "Agent 当前不是此对话成员，无法读取或发布附件。",
        403,
      );
  }

  private requireOwnerMembership(channelId: string, forUpload: boolean): void {
    const row = this.db
      .prepare(
        `SELECT c.archived FROM owner_channels c
         JOIN owner_channel_memberships m ON m.channel_id=c.id
           AND m.principal_kind='human' AND m.principal_id='owner' AND m.active=1
         WHERE c.id=?`,
      )
      .get(channelId) as { archived: number } | undefined;
    if (!row || (forUpload && row.archived))
      throw new AttachmentError(
        "conversation_unavailable",
        "对话不存在、已归档或当前不可写。",
        404,
      );
  }

  private readReady(id: string): AttachmentSummary | undefined {
    const row = this.db
      .prepare(
        `SELECT id,channel_id,storage_key,filename,content_type,size,sha256,
                uploader_kind,uploader_id,created_at
         FROM owner_conversation_attachments WHERE id=? AND state='ready'`,
      )
      .get(id) as AttachmentRow | undefined;
    return row ? toSummary(row) : undefined;
  }

  private storagePath(name: string): string {
    const path = resolve(this.directory, name);
    if (dirname(path) !== this.directory) throw new Error("Invalid attachment storage key");
    return path;
  }

  private recoverInterruptedUploads(): void {
    const interrupted = this.db
      .prepare(`SELECT id,storage_key FROM owner_conversation_attachments WHERE state='uploading'`)
      .all() as Array<{ id: string; storage_key: string }>;
    const recover = this.db.transaction(() => {
      for (const row of interrupted) {
        removeIfPresent(this.storagePath(`${row.storage_key}.uploading`));
        removeIfPresent(this.storagePath(`${row.storage_key}.blob`));
        this.db
          .prepare("DELETE FROM owner_conversation_attachments WHERE id=? AND state='uploading'")
          .run(row.id);
      }
      const actions = this.db
        .prepare(
          "SELECT session_id,action_id,result_json FROM owner_agent_tool_actions WHERE operation='attachments.publish'",
        )
        .all() as Array<{ session_id: string; action_id: string; result_json: string }>;
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

async function streamUpload(
  body: ReadableStream<Uint8Array>,
  path: string,
  maximumBytes: number,
): Promise<{ size: number; sha256: string }> {
  let size = 0;
  const digest = createHash("sha256"),
    limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.byteLength;
        if (size > maximumBytes) return callback(new Error("Attachment too large"));
        digest.update(chunk);
        callback(null, chunk);
      },
    });
  await pipeline(
    Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>),
    limiter,
    createWriteStream(path, { flags: "wx", mode: 0o600, highWaterMark: 64 * 1024 }),
  );
  return { size, sha256: digest.digest("hex") };
}

function normalizeFilename(value: string): string | undefined {
  const filename = value.normalize("NFC").trim();
  if (
    filename.length < 1 ||
    Buffer.byteLength(filename) > 255 ||
    filename === "." ||
    filename === ".." ||
    /[\\/\u0000-\u001f\u007f]/.test(filename)
  )
    return undefined;
  return filename;
}

function normalizeContentType(value: string): string {
  const normalized = value.trim().slice(0, 160);
  return /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:\s*;[^\r\n]*)?$/.test(normalized)
    ? normalized
    : "application/octet-stream";
}

function toSummary(row: AttachmentRow): AttachmentSummary {
  return {
    id: row.id,
    channelId: row.channel_id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    sha256: row.sha256,
    uploader:
      row.uploader_kind === "human"
        ? { kind: "human", id: "owner" }
        : { kind: "agent", id: row.uploader_id },
    createdAt: row.created_at,
  };
}

function syncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function writeAll(descriptor: number, bytes: Uint8Array, offset: number): void {
  let written = 0;
  while (written < bytes.byteLength) {
    const count = writeSync(
      descriptor,
      bytes,
      written,
      bytes.byteLength - written,
      offset + written,
    );
    if (count <= 0) throw new Error("Could not write streamed attachment bytes");
    written += count;
  }
}

function decodeChunk(
  value: Record<string, unknown>,
  expectedOffset: number,
  expectedSize: number,
  expectedVersion: WorkspaceVersion,
): Buffer {
  if (
    typeof value.base64 !== "string" ||
    value.offset !== expectedOffset ||
    value.totalBytes !== expectedSize ||
    !isVersion(value.version) ||
    !sameVersion(expectedVersion, value.version) ||
    Buffer.from(value.base64, "base64").toString("base64") !== value.base64
  )
    throw new WorkspaceError("file_changed", "File changed during publish", 409);
  const bytes = Buffer.from(value.base64, "base64");
  if (!bytes.length || bytes.length > 8192 || bytes.length > expectedSize - expectedOffset)
    throw new WorkspaceError("file_changed", "Invalid or incomplete node chunk", 409);
  return bytes;
}

function isVersion(value: unknown): value is WorkspaceVersion {
  if (typeof value !== "object" || value === null) return false;
  const version = value as Record<string, unknown>;
  return (
    typeof version.device === "string" &&
    typeof version.inode === "string" &&
    typeof version.size === "number" &&
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

function operationIdForAction(actionId: string): string {
  const bytes = createHash("sha256").update(actionId).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseActionResult(value: string): {
  state: string;
  operationId?: string;
  result?: unknown;
} {
  try {
    const result = JSON.parse(value) as {
      state?: unknown;
      operationId?: unknown;
      result?: unknown;
    };
    if (typeof result.state !== "string") throw new Error("Invalid action receipt");
    return {
      state: result.state,
      ...(typeof result.operationId === "string" ? { operationId: result.operationId } : {}),
      ...(result.result === undefined ? {} : { result: result.result }),
    };
  } catch {
    throw new AttachmentError("operation_unknown", "文件发布收据无法读取。", 409);
  }
}

function parsePublishedAttachment(value: unknown): AttachmentSummary {
  try {
    const parsed =
      typeof value === "string"
        ? (JSON.parse(value) as AttachmentSummary)
        : (value as AttachmentSummary);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.id !== "string" ||
      typeof parsed.channelId !== "string" ||
      typeof parsed.filename !== "string" ||
      !Number.isSafeInteger(parsed.size) ||
      typeof parsed.sha256 !== "string" ||
      !parsed.uploader
    )
      throw new Error();
    return parsed;
  } catch {
    throw new AttachmentError("operation_unknown", "发布收据无法读取。", 409);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}
