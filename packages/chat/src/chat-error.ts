import type { z } from "zod";

/**
 * Why the chat app refused an operation. A refused operation changes nothing.
 *
 * - `unknown-account`: the acting account, or an account the request names, does not exist.
 * - `inactive-account`: the acting account has been deactivated.
 * - `not-found`: the conversation, timeline, message or task does not exist, or the account may not read it. The two
 *   cases are deliberately indistinguishable, so a non-member cannot learn that a private conversation exists.
 * - `not-member`: the account can read the conversation but must be a member to act in it.
 * - `archived`: the channel is archived and therefore read-only.
 * - `invalid-target`: the operation names a target it can never apply to, such as a DM with yourself, a task
 *   transferred to yourself or to a non-member, or joining a DM.
 * - `request-conflict`: the requestId was already used by this account for a different request.
 * - `handle-taken`: another account already uses that handle.
 * - `owner-only`: the operation belongs to the owner alone, such as the live view and push subscriptions.
 * - `invalid-input`: the input does not match the operation's schema.
 */
export type ChatErrorReason =
  | "unknown-account"
  | "inactive-account"
  | "not-found"
  | "not-member"
  | "archived"
  | "invalid-target"
  | "request-conflict"
  | "handle-taken"
  | "owner-only"
  | "invalid-input";

export class ChatError extends Error {
  readonly reason: ChatErrorReason;

  constructor(reason: ChatErrorReason, message: string) {
    super(message);
    this.name = "ChatError";
    this.reason = reason;
  }
}

/** Parse a caller's input at the boundary, turning a schema mismatch into a typed refusal. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ChatError("invalid-input", parsed.error.message);
  return parsed.data;
}
