import type { UserMessage } from "@earendil-works/pi-ai";

/** A pending business input, never a second copy of the committed transcript. */
export interface ModelContextMessage {
  id: string;
  message: UserMessage;
  actionScopeId: string;
  pending?: boolean;
  recoveryFact?: boolean;
  conversationId?: number;
}
