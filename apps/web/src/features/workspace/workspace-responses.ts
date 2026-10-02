import { z } from "zod";
import {
  workspaceDirectoryPageSchema,
  workspaceDownloadStatusSchema,
  workspaceFileChunkSchema,
  workspaceFileStatSchema,
  workspaceStatSchema,
  workspaceVersionSchema,
} from "@mate/protocol/workspace";

const versionSchema = workspaceVersionSchema.loose();
export const directoryPageSchema = workspaceDirectoryPageSchema.omit({ path: true }).loose();
export const fileStatSchema = workspaceFileStatSchema.extend({ version: versionSchema }).loose();
export const statSchema = z.union([workspaceStatSchema.options[0].loose(), fileStatSchema]);
export const chunkSchema = workspaceFileChunkSchema.extend({ version: versionSchema }).loose();
// The status endpoint may omit its echoed ID. Invalid/absent TTL hints have always been ignored.
export const downloadStatusSchema = workspaceDownloadStatusSchema
  .omit({ downloadId: true })
  .extend({ expiresInMs: z.unknown().optional() })
  .loose();
export type DownloadStatus = z.infer<typeof downloadStatusSchema>;
