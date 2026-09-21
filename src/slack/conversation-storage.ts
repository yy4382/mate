import type { MateConfig } from '../config.js';
import type { Store } from '../storage/store.js';
import { References } from '../conversations/references.js';
import { ConversationRecords } from '../storage/conversations.js';
import { ConversationWrites } from '../storage/conversation-writes.js';
import { LegacyConversationCodec } from './legacy-codec.js';

/** Explicit composition for the temporary v1 persistence adapter. */
export function slackConversationStorage(store: Store, config: MateConfig) {
  const references = new References(store), codec = new LegacyConversationCodec(references, config);
  return { records: new ConversationRecords(store, references, codec), writes: new ConversationWrites(store, references, codec) };
}
