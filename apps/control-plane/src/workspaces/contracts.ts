import { z } from "zod";
import { workspaceVersionSchema } from "@mate/protocol/workspace";
export const workspaceChunkSchema = z.object({
  bytes: z.instanceof(Uint8Array),
  offset: z.number(),
  totalBytes: z.number(),
  version: workspaceVersionSchema,
});
export type WorkspaceChunk = z.infer<typeof workspaceChunkSchema>;
export const workspaceDownloadStatusSchema = z.object({
  state: z.enum(["started", "succeeded", "failed", "cancelled"]),
  errorCode: z.string().nullable(),
  expiresInMs: z.number(),
});
export type WorkspaceDownloadStatus = z.infer<typeof workspaceDownloadStatusSchema>;
