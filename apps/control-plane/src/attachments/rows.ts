import type { AttachmentSummary } from "@mate/protocol/owner";
import type Database from "better-sqlite3";
import { z } from "zod";

export const attachmentRowSchema = z.looseObject({
  id: z.string(),
  channel_id: z.string(),
  storage_key: z.string(),
  filename: z.string(),
  content_type: z.string(),
  size: z.number(),
  sha256: z.string(),
  uploader_kind: z.union([z.literal("human"), z.literal("agent")]),
  uploader_id: z.string(),
  created_at: z.number(),
});
export type AttachmentRow = z.infer<typeof attachmentRowSchema>;

export function toAttachmentSummary(row: AttachmentRow): AttachmentSummary {
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
export function readReadyAttachment(
  db: Database.Database,
  id: string,
): AttachmentSummary | undefined {
  const row = attachmentRowSchema.optional().parse(
    db
      .prepare(
        `SELECT id,channel_id,storage_key,filename,content_type,size,sha256,
                uploader_kind,uploader_id,created_at
         FROM owner_conversation_attachments WHERE id=? AND state='ready'`,
      )
      .get(id),
  );
  return row ? toAttachmentSummary(row) : undefined;
}
export function insertUploadingAttachment(
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
