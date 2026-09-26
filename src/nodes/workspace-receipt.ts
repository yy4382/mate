import { createHash } from "node:crypto";
import type { Operation } from "../execution/backend.js";

/** Hash the stable Agent and requested filesystem mutation recorded by both services. */
export function workspaceReceiptRequestHash(
  agentId: string,
  operation: Exclude<Operation, { kind: "exec" }>,
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
