import { createHash } from "node:crypto";

/** The original Agent session and Durable tool task name one action across run recovery. */
export function durableToolIdentity(
  actionScopeId: string,
  sessionId: string,
  taskId: string,
): string {
  return `mate:${actionScopeId}:${createHash("sha256")
    .update(JSON.stringify([sessionId, taskId]))
    .digest("hex")}:1`;
}

export function operationIdForAction(actionId: string): string {
  const bytes = createHash("sha256").update(actionId).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
