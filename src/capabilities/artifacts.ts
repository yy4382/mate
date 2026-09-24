import type { ConversationTarget as Target } from "../domain/conversations.js";

export interface AttachmentArgs {
  message: { messageId: string };
  fileId: string;
  path: string;
}
export interface PublishArgs {
  path: string;
  title: string;
  target: Target;
  text?: string;
  viewToken?: string;
  draftId?: string;
  revision?: number;
  format?: "text" | "binary";
}

export interface ArtifactPayload {
  title: string;
  content: string;
  contentHash: string;
  encoding?: "base64";
  filename?: string;
}
