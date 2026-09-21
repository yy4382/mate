import type { MateConfig } from '../config.js';
import type { Store } from '../storage/store.js';
import { slackConversationStorage } from './conversation-storage.js';
/** Legacy Slack facade. Application code imports conversations directly. */
import { Messages as ConversationMessages } from '../conversations/messages.js';
import { SlackMessageNormalizer } from './normalize.js';
export * from '../conversations/messages.js';
export * from '../conversations/output.js';
export type { MessageTransport as SlackTransport } from '../conversations/output.js';
export class Messages extends ConversationMessages {
  constructor(store: Store, config: MateConfig) { super(store, config, slackConversationStorage(store, config)); }
  normalize(appId: string, eventId: string): void {
    new SlackMessageNormalizer(this).normalize(appId, eventId);
  }
}
