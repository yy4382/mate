import type { WorkspaceVersion } from "@mate/protocol/workspace";
import { FILE_CHUNK_MAX_BYTES } from "@mate/protocol/workspace";
import { z } from "zod";
import { WorkspaceError } from "../workspaces/errors.js";
import { isWorkspaceVersion, sameVersion } from "../workspaces/results.js";
import { AttachmentError } from "./errors.js";

export function decodeChunk(
  value: Record<string, unknown>,
  { offset, size, version }: { offset: number; size: number; version: WorkspaceVersion },
) {
  if (
    typeof value.base64 !== "string" ||
    value.offset !== offset ||
    value.totalBytes !== size ||
    !isWorkspaceVersion(value.version) ||
    !sameVersion(version, value.version) ||
    Buffer.from(value.base64, "base64").toString("base64") !== value.base64
  )
    throw new WorkspaceError("file_changed", "File changed during publish", 409);
  const bytes = Buffer.from(value.base64, "base64");
  if (!bytes.length || bytes.length > FILE_CHUNK_MAX_BYTES || bytes.length > size - offset)
    throw new WorkspaceError("file_changed", "Invalid or incomplete node chunk", 409);
  return bytes;
}

const actionResultSchema = z.looseObject({
  state: z.string(),
  operationId: z.unknown().optional(),
  result: z.unknown().optional(),
});
export function parseActionResult(value: string) {
  try {
    const result = actionResultSchema.parse(JSON.parse(value));
    return {
      state: result.state,
      ...(typeof result.operationId === "string" ? { operationId: result.operationId } : {}),
      ...(result.result === undefined ? {} : { result: result.result }),
    };
  } catch {
    throw new AttachmentError("operation_unknown", "文件发布收据无法读取。", 409);
  }
}

// Publication receipts expose these fields and retain any additional stored metadata.
const publishedAttachmentReceiptSchema = z.looseObject({
  id: z.string(),
  channelId: z.string(),
  filename: z.string(),
  size: z.number().refine(Number.isSafeInteger),
  sha256: z.string(),
  uploader: z.unknown().refine(Boolean),
});
export function parsePublishedAttachment(value: unknown) {
  try {
    return publishedAttachmentReceiptSchema.parse(
      typeof value === "string" ? JSON.parse(value) : value,
    );
  } catch {
    throw new AttachmentError("operation_unknown", "发布收据无法读取。", 409);
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}
