import type { WorkspaceVersion } from "@mate/protocol/workspace";
import { FILE_CHUNK_MAX_BYTES } from "@mate/protocol/workspace";
import { createHash } from "node:crypto";
import { z } from "zod";
import { WorkspaceError } from "../workspaces/errors.js";
import { isWorkspaceVersion as isVersion, sameVersion } from "../workspaces/results.js";
import { AttachmentError } from "./errors.js";

export function decodeChunk(
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
  if (
    !bytes.length ||
    bytes.length > FILE_CHUNK_MAX_BYTES ||
    bytes.length > expectedSize - expectedOffset
  )
    throw new WorkspaceError("file_changed", "Invalid or incomplete node chunk", 409);
  return bytes;
}

export function operationIdForAction(actionId: string): string {
  const bytes = createHash("sha256").update(actionId).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

// Recovery deliberately validates only the fields the existing receipt reader required.
// New uploads use AttachmentSummary; older readable receipts keep their extension fields.
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
