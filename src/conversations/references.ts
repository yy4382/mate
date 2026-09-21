import { randomUUID } from 'node:crypto';
import type { Store } from '../storage/store.js';
import { referenceSchema, conversationTargetSchema, type ConversationIdentity, type ConversationTarget, type ExternalConversation, type ExternalMessage, type MessageIdentity } from '../domain/conversations.js';

/** Trusted application/adapter boundary. These methods do not grant read or send access. */
export class References {
  constructor(private readonly store: Store) {}

  conversation(id: string): ConversationIdentity {
    referenceSchema.parse(id);
    const row = this.store.db.prepare('SELECT * FROM conversation_identities WHERE id=?').get(id) as ConversationIdentity | undefined;
    if (!row) throw new Error('Unknown conversation identity');
    return row;
  }

  createConversation(kind: ConversationIdentity['kind'], authority: ConversationIdentity['authority'], id: string = randomUUID()): ConversationIdentity {
    referenceSchema.parse(id);
    return this.store.atomic(() => {
      const old = this.store.db.prepare('SELECT * FROM conversation_identities WHERE id=?').get(id) as ConversationIdentity | undefined;
      if (old) {
        if (old.kind !== kind || old.authority !== authority) throw new Error('Conversation identity conflict');
        return old;
      }
      this.store.db.prepare('INSERT INTO conversation_identities VALUES(?,?,?)').run(id, kind, authority);
      return this.conversation(id);
    });
  }

  private locator(locator: ExternalConversation): void {
    referenceSchema.parse(locator.provider); referenceSchema.parse(locator.workspace); referenceSchema.parse(locator.externalId);
  }

  findConversation(locator: ExternalConversation): string | undefined {
    this.locator(locator);
    return (this.store.db.prepare('SELECT conversation_id FROM conversation_bindings WHERE provider=? AND workspace=? AND external_id=?')
      .get(locator.provider, locator.workspace, locator.externalId) as { conversation_id: string } | undefined)?.conversation_id;
  }

  bindConversation(locator: ExternalConversation, id: string, mode: 'primary' | 'projection'): void {
    this.locator(locator);
    this.store.atomic(() => {
      const conversation = this.conversation(id);
      if ((conversation.authority === 'internal') !== (mode === 'projection')) throw new Error('Binding authority mismatch');
      const old = this.store.db.prepare('SELECT conversation_id,mode FROM conversation_bindings WHERE provider=? AND workspace=? AND external_id=?')
        .get(locator.provider, locator.workspace, locator.externalId) as { conversation_id: string; mode: string } | undefined;
      if (old) {
        if (old.conversation_id !== id || old.mode !== mode) throw new Error('External conversation already bound');
        return;
      }
      this.store.db.prepare('INSERT INTO conversation_bindings VALUES(?,?,?,?,?)').run(locator.provider, locator.workspace, locator.externalId, id, mode);
    });
  }

  message(id: string): MessageIdentity {
    referenceSchema.parse(id);
    const row = this.store.db.prepare('SELECT id,conversation_id conversationId,root_id rootId FROM message_identities WHERE id=?').get(id) as MessageIdentity | undefined;
    if (!row) throw new Error('Unknown message identity');
    return row;
  }

  /** A root may have identity without loaded content. Never invent text or membership. */
  createMessage(conversationId: string, id: string = randomUUID(), rootId: string = id): MessageIdentity {
    referenceSchema.parse(id); referenceSchema.parse(rootId); this.conversation(conversationId);
    return this.store.atomic(() => {
      const old = this.store.db.prepare('SELECT id FROM message_identities WHERE id=?').get(id);
      if (old) {
        const message = this.message(id);
        if (message.conversationId !== conversationId || message.rootId !== null && message.rootId !== rootId) throw new Error('Message identity conflict');
        if (message.rootId !== null) return message;
      }
      if (id !== rootId) {
        const root = this.message(rootId);
        if (root.conversationId !== conversationId || root.rootId !== root.id) throw new Error('Invalid thread root');
      }
      this.store.db.prepare('INSERT INTO message_identities VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET root_id=excluded.root_id').run(id, conversationId, rootId);
      return this.message(id);
    });
  }

  /** A referenced message may not have loaded thread metadata yet. */
  reserveMessage(conversationId: string, id: string = randomUUID()): MessageIdentity {
    referenceSchema.parse(id); this.conversation(conversationId);
    return this.store.atomic(() => {
      this.store.db.prepare('INSERT INTO message_identities VALUES(?,?,NULL) ON CONFLICT(id) DO NOTHING').run(id, conversationId);
      const message = this.message(id);
      if (message.conversationId !== conversationId) throw new Error('Message identity conflict');
      return message;
    });
  }

  findMessage(locator: ExternalMessage): string | undefined {
    this.locator(locator); referenceSchema.parse(locator.messageId);
    return (this.store.db.prepare('SELECT message_id FROM message_bindings WHERE provider=? AND workspace=? AND external_conversation=? AND external_message=?')
      .get(locator.provider, locator.workspace, locator.externalId, locator.messageId) as { message_id: string } | undefined)?.message_id;
  }

  bindMessage(locator: ExternalMessage, id: string): void {
    this.locator(locator); referenceSchema.parse(locator.messageId);
    this.store.atomic(() => {
      const conversationId = this.findConversation(locator), message = this.message(id);
      if (conversationId !== message.conversationId) throw new Error('Message binding conversation mismatch');
      const old = this.findMessage(locator);
      if (old) {
        if (old !== id) throw new Error('External message already bound');
        return;
      }
      this.store.db.prepare('INSERT INTO message_bindings VALUES(?,?,?,?,?)').run(locator.provider, locator.workspace, locator.externalId, locator.messageId, id);
    });
  }

  validateTarget(target: ConversationTarget): ConversationTarget {
    conversationTargetSchema.parse(target); this.conversation(target.conversationId);
    if (target.threadId) {
      const root = this.message(target.threadId);
      if (root.conversationId !== target.conversationId || root.rootId !== root.id) throw new Error('Invalid target thread');
    }
    return target;
  }

  /** Derived index; caller must read its authoritative object and update in the same transaction. */
  indexTarget(objectType: string, objectId: string, target: ConversationTarget): void {
    referenceSchema.parse(objectType); referenceSchema.parse(objectId); this.validateTarget(target);
    this.store.db.prepare('INSERT INTO canonical_targets VALUES(?,?,?,?) ON CONFLICT(object_type,object_id) DO UPDATE SET conversation_id=excluded.conversation_id,thread_id=excluded.thread_id')
      .run(objectType, objectId, target.conversationId, target.threadId ?? null);
  }

  indexedTarget(objectType: string, objectId: string): ConversationTarget | undefined {
    const row = this.store.db.prepare('SELECT conversation_id,thread_id FROM canonical_targets WHERE object_type=? AND object_id=?')
      .get(objectType, objectId) as { conversation_id: string; thread_id: string | null } | undefined;
    return row ? { conversationId: row.conversation_id, ...(row.thread_id ? { threadId: row.thread_id } : {}) } : undefined;
  }
}
