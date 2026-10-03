import { z } from "zod";

/** Maximum bytes in a bounded workspace or attachment file chunk. */
export const FILE_CHUNK_MAX_BYTES = 8 * 1024;

/** A file's identity and revision, shared by owner reads and node workspace operations. */
export const workspaceVersionSchema = z
  .object({
    device: z.string().regex(/^[0-9]+$/),
    inode: z.string().regex(/^[0-9]+$/),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    modifiedNs: z.string().regex(/^[0-9]+$/),
    changedNs: z.string().regex(/^[0-9]+$/),
  })
  .strict();

export const workspaceEntrySchema = z.object({
  name: z.string(),
  type: z.enum(["file", "directory", "symlink", "other"]),
  size: z.number(),
});

export const workspaceDirectoryPageSchema = z.object({
  path: z.string(),
  entries: z.array(workspaceEntrySchema),
  nextOffset: z.number().nullable(),
});

export const workspaceFileStatSchema = z.object({
  type: z.literal("file"),
  size: z.number(),
  modifiedAt: z.number(),
  version: workspaceVersionSchema,
});

export const workspaceStatSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("directory"), size: z.number(), modifiedAt: z.number() }),
  workspaceFileStatSchema,
]);

/** The HTTP chunk representation; services may keep decoded bytes internally. */
export const workspaceFileChunkSchema = z.object({
  offset: z.number(),
  totalBytes: z.number(),
  base64: z.string(),
  version: workspaceVersionSchema,
});

export const workspaceDownloadStatusSchema = z.object({
  downloadId: z.string(),
  state: z.enum(["started", "succeeded", "failed", "cancelled"]),
  errorCode: z.string().nullable(),
  expiresInMs: z.number().optional(),
});

export type WorkspaceVersion = z.infer<typeof workspaceVersionSchema>;
export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;
export type WorkspaceDirectoryPage = z.infer<typeof workspaceDirectoryPageSchema>;
export type WorkspaceFileStat = z.infer<typeof workspaceFileStatSchema>;
export type WorkspaceStat = z.infer<typeof workspaceStatSchema>;
export type WorkspaceFileChunk = z.infer<typeof workspaceFileChunkSchema>;
export type WorkspaceDownloadStatus = z.infer<typeof workspaceDownloadStatusSchema>;
