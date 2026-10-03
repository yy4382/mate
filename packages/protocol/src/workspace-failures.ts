import { z } from "zod";
import type { NodeWorkspaceOperationResult } from "./messages.js";

/** Stable file failure categories; diagnostic prose does not choose recovery or UI state. */
export const workspaceFailureCodeSchema = z.enum([
  "operation_conflict",
  "operation_unknown",
  "unsafe_path",
  "file_changed",
  "permission_denied",
  "not_found",
  "not_file",
  "workspace_unavailable",
]);
export type WorkspaceFailureCode = z.infer<typeof workspaceFailureCodeSchema>;

/** Old receipts used a strict prefix for unknown effects, unlike legacy UI text mapping.
 * Do not backfill a code into those receipts: same-revision evidence must remain identical. */
export function workspaceResultIsUnknown(
  result: Pick<
    Extract<NodeWorkspaceOperationResult, { ok: true }>["result"],
    "errorCode" | "stderr"
  >,
) {
  const code = workspaceFailureCodeSchema.safeParse(result.errorCode);
  return code.success
    ? code.data === "operation_unknown"
    : result.stderr.startsWith("operation_unknown:");
}
