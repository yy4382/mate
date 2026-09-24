import { z } from "zod";
import { conversationTargetSchema, type ConversationTarget } from "../domain/conversations.js";
import type { Conversations } from "./messages.js";
import { InternalMessages } from "./internal.js";

/** Queue and revision share this contract; revision must not bypass authority capabilities. */
export function validateOutputIntent(
  messages: Conversations,
  actor: string,
  target: ConversationTarget,
  text: string,
  artifact = false,
): void {
  messages.references.validateTarget(conversationTargetSchema.parse(target));
  messages.requireAccess(actor, target.conversationId);
  z.string().min(1).max(35000).parse(text);
  if (messages.references.conversation(target.conversationId).authority === "internal") {
    new InternalMessages(messages).requireSupported(target);
    if (artifact) throw new Error("Internal artifacts are not supported");
  } else messages.requirePublication(actor, target);
}
