import { z } from "zod";
import type { AttachmentSummary } from "@mate/protocol/owner";
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

export function toSummary(row: AttachmentRow): AttachmentSummary {
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
