import { createHash } from "node:crypto";

/** A committed assistant entry and Pi tool call name the same action across run recovery. */
export function durableToolIdentity(
  actionScopeId: string,
  assistantId: string,
  toolCallId: string,
): string {
  return `mate:${actionScopeId}:${createHash("sha256")
    .update(JSON.stringify([assistantId, toolCallId]))
    .digest("hex")}:1`;
}
