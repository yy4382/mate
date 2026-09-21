import type { Target } from '../conversations/messages.js';

export interface AttachmentArgs {
  message: { channel: string; ts: string };
  fileId: string;
  grantId: string;
  path: string;
}
export interface PublishArgs {
  grantId: string;
  path: string;
  title: string;
  target: Target;
  text?: string;
  viewToken?: string;
  draftId?: string;
  revision?: number;
  format?: 'text' | 'binary';
}
