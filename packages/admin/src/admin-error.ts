import type { z } from "zod";

/**
 * Why the admin module refused an operation. A refused operation changes nothing.
 *
 * - `invalid-input`: the input does not match the operation's schema.
 * - `unknown-agent`: no Agent has that ID.
 * - `unknown-node`: no paired node has that ID.
 * - `unknown-provider`: the provider is not one Mate offers.
 * - `no-credentials`: the provider has no API key, so its models cannot be chosen.
 * - `unknown-model`: the provider's catalog has no such model.
 * - `unsupported-thinking-level`: the model does not accept that thinking level. It is refused, never lowered.
 * - `agent-closed`: the Agent is paused or closed, so there is nothing running to watch.
 * - `unknown-assistant`: the Agent has no work assistant by that name.
 * - `not-implemented`: the node gateway does not offer workspace browsing yet.
 */
export type AdminErrorReason =
  | "invalid-input"
  | "unknown-agent"
  | "unknown-node"
  | "unknown-provider"
  | "no-credentials"
  | "unknown-model"
  | "unsupported-thinking-level"
  | "agent-closed"
  | "unknown-assistant"
  | "not-implemented";

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
