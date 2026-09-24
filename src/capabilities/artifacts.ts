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
  text?: string | undefined;
  viewToken?: string | undefined;
  draftId?: string | undefined;
  revision?: number | undefined;
  format?: "text" | "binary" | undefined;
}

export interface ArtifactPayload {
  title: string;
  content: string;
  contentHash: string;
  encoding?: "base64";
  filename?: string;
}
