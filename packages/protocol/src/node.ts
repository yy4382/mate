import { createHash } from "node:crypto";
import type { AgentProcessOperation } from "./process-operations.js";
import type { WorkspaceOperation } from "./workspace-operations.js";

/** Hash the stable Agent and requested filesystem mutation recorded by both services. */
export function workspaceReceiptRequestHash(
  agentId: string,
  operation: WorkspaceOperation,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ agentId, operation: canonical(operation) }))
    .digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

/** Digest the exact node process intent also reconstructed during control-plane reconciliation. */
export function processOperationRequestHash(
  agentId: string,
  operation: AgentProcessOperation,
): string {
  return createHash("sha256").update(JSON.stringify({ agentId, operation })).digest("hex");
}
