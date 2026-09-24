import { z } from "zod";

export const referenceSchema = z.string().min(1).max(1000);
export const conversationTargetSchema = z
  .object({
    conversationId: referenceSchema,
    threadId: referenceSchema.optional(),
  })
  .strict();
export type ConversationTarget = z.infer<typeof conversationTargetSchema>;
export interface ConversationIdentity {
  id: string;
  kind: "channel" | "dm";
  authority: "internal" | "external";
}
export interface MessageIdentity {
  id: string;
  conversationId: string;
  rootId: string | null;
}
export interface ExternalConversation {
  provider: string;
  workspace: string;
  externalId: string;
}
export interface ExternalMessage extends ExternalConversation {
  messageId: string;
}
