import type { MateConfig } from '../../../../../src/config.js';
import type { Store } from '../../../../../src/storage/store.js';
import { References } from '../../../../../src/conversations/references.js';
import { ConversationRecords } from '../../../../../src/storage/conversations.js';
import { ConversationWrites } from '../storage/conversation-writes.js';
import { LegacyFixtureWriter as LegacyConversationCodec } from './legacy-writer.js';

/** Explicit composition for the temporary v1 persistence adapter. */
export function slackConversationStorage(store: Store, config: MateConfig) {
  const references = new References(store), codec = new LegacyConversationCodec(references, config);
  return { records: new ConversationRecords(store, references, codec), writes: new ConversationWrites(store, references, codec) };
}
