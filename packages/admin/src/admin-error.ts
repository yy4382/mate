import type { z } from "zod";

/**
 * Why the admin module refused an operation. A refused operation changes nothing.
 *
 * - `invalid-input`: the input does not match the operation's schema.
 * - `unknown-agent`: no Agent has that ID.
 * - `agent-exists`: creating with the ID of an Agent that exists.
 * - `unknown-node`: no paired node has that ID.
 * - `unknown-provider`: the provider is not one Mate offers.
 * - `no-credentials`: the provider has no API key, so its models cannot be chosen.
 * - `unknown-model`: the provider's catalog has no such model.
 * - `unsupported-thinking-level`: the model does not accept that thinking level. It is refused, never lowered.
 * - `agent-closed`: the Agent is paused or closed, so there is nothing running to watch.
 * - `unknown-assistant`: the Agent has no work assistant by that name.
 * - `node-offline`: the Agent's node is not connected, or its connection was lost before it answered.
 * - `outside-workspace`: the path leaves the Agent's workspace, by `..`, an absolute path, or a symbolic link.
 * - `not-found`: the path, or the Agent's workspace on its node, does not exist.
 * - `unreadable`: the node cannot read the path, such as a FIFO or a file without permission.
 */
export type AdminErrorReason =
  | "invalid-input"
  | "unknown-agent"
  | "agent-exists"
  | "unknown-node"
  | "unknown-provider"
  | "no-credentials"
  | "unknown-model"
  | "unsupported-thinking-level"
  | "agent-closed"
  | "unknown-assistant"
  | "node-offline"
  | "outside-workspace"
  | "not-found"
  | "unreadable";

export class AdminError extends Error {
  readonly reason: AdminErrorReason;

  constructor(reason: AdminErrorReason, message: string) {
    super(message);
    this.name = "AdminError";
    this.reason = reason;
  }
}

/** Parse a caller's input at the boundary, turning a schema mismatch into a typed refusal. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AdminError("invalid-input", parsed.error.message);
  return parsed.data;
}
