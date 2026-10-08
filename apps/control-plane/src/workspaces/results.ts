import type { WorkspaceOperation, WorkspaceFailureCode } from "@mate/protocol";
import type { WorkspaceVersion } from "@mate/protocol/workspace";
import { createHash } from "node:crypto";
import { posix as posixPath } from "node:path";
import { z } from "zod";
import { WorkspaceError } from "./errors.js";

// Node response versions allow extension fields and non-decimal strings; tool request
// versions use the stricter schema from protocol.
export const workspaceVersionResultSchema = z.looseObject({
  device: z.string(),
  inode: z.string(),
  size: z.number().refine(Number.isSafeInteger),
  modifiedNs: z.string(),
  changedNs: z.string(),
});
const workspaceEntryResultSchema = z.looseObject({
  name: z.string(),
  type: z.enum(["file", "directory", "symlink", "other"]),
  size: z.number().refine(Number.isSafeInteger).nonnegative(),
});
// Directory responses validate entries and pagination while retaining node metadata.
export const workspaceDirectoryResultSchema = z.looseObject({
  entries: workspaceEntryResultSchema.array(),
  nextOffset: z.number().refine(Number.isSafeInteger).nullable(),
});
export const workspaceStatResultSchema = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("directory"),
    size: z.number().refine(Number.isSafeInteger).nonnegative(),
    modifiedAt: z.number(),
  }),
  z.looseObject({
    type: z.literal("file"),
    size: z.number().refine(Number.isSafeInteger).nonnegative(),
    modifiedAt: z.number(),
    version: workspaceVersionResultSchema,
  }),
]);
export function isWorkspaceVersion(
  value: unknown,
): value is z.infer<typeof workspaceVersionResultSchema> {
  return workspaceVersionResultSchema.safeParse(value).success;
}

export function sameVersion(left: WorkspaceVersion, right: WorkspaceVersion): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedNs === right.modifiedNs &&
    left.changedNs === right.changedNs
  );
}

export function invalidNodeResponse(): WorkspaceError {
  return new WorkspaceError("invalid_response", "节点返回了无效的文件结果。", 502);
}

/** Legacy diagnostic adaptation is only for results with no structured code. */
function legacyFileFailureCode(message: string) {
  if (/operation_conflict/i.test(message)) return "operation_conflict";
  if (/operation_unknown|outcome may be unknown/i.test(message)) return "operation_unknown";
  if (/unsafe_path|symbolic link|symlink|escapes the workspace/i.test(message))
    return "unsafe_path";
  if (/file_changed|file changed|changed while/i.test(message)) return "file_changed";
  if (/permission[_ ]denied|eacces|eperm/i.test(message)) return "permission_denied";
  if (/enoent|not found|no such file or directory/i.test(message)) return "not_found";
  if (/not_file|not_regular_file|regular single-link|is a directory/i.test(message))
    return "not_file";
  return "workspace_unavailable";
}

export function mapNodeError(message: string, errorCode?: WorkspaceFailureCode): WorkspaceError {
  const code = errorCode ?? legacyFileFailureCode(message);
  switch (code) {
    case "operation_conflict":
      return new WorkspaceError(code, "操作 ID 已用于不同的文件请求。", 409);
    case "operation_unknown":
      return new WorkspaceError(code, "文件操作结果尚未确认，不会自动重试。", 409);
    case "unsafe_path":
      return new WorkspaceError(code, "路径不在可读取的工作区范围内。", 403);
    case "file_changed":
      return new WorkspaceError(code, "文件在读取期间发生变化，请重新加载。", 409);
    case "permission_denied":
      return new WorkspaceError(code, "当前运行账号没有读取此文件的权限。", 403);
    case "not_found":
      return new WorkspaceError(code, "文件或目录不存在。", 404);
    case "not_file":
      return new WorkspaceError(code, "只能读取普通文件。", 400);
    case "workspace_unavailable":
      return new WorkspaceError(code, "节点无法完成文件请求。", 502);
  }
}

export function confirmedFileFailure(
  code: number,
  stderr: string,
  errorCode?: WorkspaceFailureCode,
): WorkspaceError {
  const mapped = mapNodeError(stderr || "File request failed", errorCode);
  return new WorkspaceError(mapped.code, `${mapped.message}（节点结果码 ${code}）`, mapped.status);
}

export function isMutatingOperation(
  operation: WorkspaceOperation,
): operation is Extract<
  WorkspaceOperation,
  { kind: "write_bytes" | "write" | "edit" | "mkdir" | "move" | "remove" }
> {
  return ["write_bytes", "write", "edit", "mkdir", "move", "remove"].includes(operation.kind);
}

export function hashToolRequest(operation: string, input: unknown): string {
  return createHash("sha256").update(JSON.stringify({ operation, input })).digest("hex");
}

export function deterministicOperationId(actionId: string): string {
  const bytes = createHash("sha256").update(actionId).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function parseOperationReceipt(value: string): unknown {
  try {
    const receipt: unknown = JSON.parse(value);
    return receipt;
  } catch {
    throw new WorkspaceError("invalid_response", "节点操作收据无法读取。", 502);
  }
}

const actionEnvelopeSchema = z.looseObject({
  state: z.string(),
  operationId: z.unknown().optional(),
  runId: z.unknown().optional(),
  channelId: z.unknown().optional(),
  operation: z.unknown().optional(),
  nodeRequestHash: z.unknown().optional(),
  revision: z.unknown().optional(),
  result: z.unknown().optional(),
});

export function parseEnvelope(value: string) {
  try {
    const envelope = actionEnvelopeSchema.parse(JSON.parse(value));
    return {
      state: envelope.state,
      ...(typeof envelope.operationId === "string" ? { operationId: envelope.operationId } : {}),
      ...(typeof envelope.runId === "string" ? { runId: envelope.runId } : {}),
      ...(typeof envelope.channelId === "string" ? { channelId: envelope.channelId } : {}),
      ...(typeof envelope.operation === "string" ? { operation: envelope.operation } : {}),
      ...(typeof envelope.nodeRequestHash === "string"
        ? { nodeRequestHash: envelope.nodeRequestHash }
        : {}),
      ...(typeof envelope.revision === "number" &&
      Number.isSafeInteger(envelope.revision) &&
      envelope.revision > 0
        ? { revision: envelope.revision }
        : {}),
      ...(envelope.result === undefined ? {} : { result: envelope.result }),
    };
  } catch {
    throw new WorkspaceError("operation_unknown", "文件操作收据无法读取。", 409);
  }
}

/** Keep owner-visible operation diagnostics short; this is a character bound, not bytes. */
const operationErrorPreviewChars = 240;

export function safeError(error: unknown): string {
  return (error instanceof WorkspaceError ? error.message : "文件操作结果尚未确认。").slice(
    0,
    operationErrorPreviewChars,
  );
}

export function operationPaths(operation: WorkspaceOperation): string[] {
  return operation.kind === "move" ? [operation.path, operation.destination] : [operation.path];
}

export function safeAuditPath(path: string, home?: string): string {
  const segments = path.split("/").filter((part) => part !== "" && part !== ".");
  if (path.includes("\0") || segments.includes("..")) return "[invalid path]";
  if (path.startsWith("/")) {
    if (!home?.startsWith("/")) return "[absolute path request]";
    const normalizedHome = posixPath.normalize(home);
    const normalizedPath = posixPath.normalize(path);
    if (normalizedPath !== normalizedHome && !normalizedPath.startsWith(`${normalizedHome}/`))
      return "[absolute path request]";
    const relative = posixPath.relative(normalizedHome, normalizedPath);
    return relative.slice(0, 4096);
  }
  if (/^[A-Za-z]:[\\/]/.test(path)) return "[absolute path request]";
  const normalized = posixPath.normalize(path);
  return (normalized === "." ? "" : normalized).slice(0, 4096);
}

export function workspaceAccessErrorCode(error: unknown): string {
  if (error instanceof WorkspaceError) return error.code;
  const message = error instanceof Error ? error.message : "";
  if (/file_changed|file changed|changed while/i.test(message)) return "file_changed";
  if (/permission denied|eacces|eperm/i.test(message)) return "permission_denied";
  if (/enoent|not found|no such file or directory/i.test(message)) return "not_found";
  if (/unsafe_path|symbolic link|symlink|escapes the workspace/i.test(message))
    return "unsafe_path";
  return "workspace_unavailable";
}
