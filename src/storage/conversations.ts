import { parseMessage, type MessageDTO, type CanonicalEffect } from '../domain/messages.js';
import { conversationTargetSchema, type ConversationTarget } from '../domain/conversations.js';
import type { References } from '../conversations/references.js';
import type { Store } from './store.js';

export interface LegacyPayloadDecoder {
  target(value: unknown): ConversationTarget;
  message(body: string): MessageDTO;
}

/** Persistence interpretation only. Application services must enforce actor visibility. */
export class ConversationRecords {
  constructor(private readonly store: Store, private readonly references: References, private readonly legacy: LegacyPayloadDecoder) {}

  message(id: string): MessageDTO | undefined {
    const row = this.store.db.prepare('SELECT body FROM messages WHERE key=?').get(id) as { body: string } | undefined;
    if (!row) return undefined;
    const body = JSON.parse(row.body);
    let message: MessageDTO;
    if (Object.hasOwn(body,'format')) {
      if (body.format !== 'mate.message.v2') throw new Error('Unsupported stored message format');
      message = parseMessage(body.message);
      const identity = this.references.message(message.id);
      if (message.conversationId !== identity.conversationId || message.rootId !== identity.rootId) throw new Error('Stored message reference mismatch');
    } else message = this.legacy.message(row.body);
    if (message.id !== id) throw new Error('Stored message identity mismatch');
    return message;
  }

  mutableTarget(type: 'works' | 'tasks' | 'schedules' | 'task_intents' | 'review_seats', id: string): ConversationTarget {
    const key = type === 'review_seats' ? 'agent_id' : 'id';
    const row = this.store.db.prepare(`SELECT target FROM ${type} WHERE ${key}=?`).get(id) as { target: string } | undefined;
    if (!row) throw new Error('Target object missing');
    const marker = this.store.db.prepare("SELECT value FROM runtime_meta WHERE key='conversation_format'").get() as {value:string}|undefined;
    if (marker && marker.value !== 'mate.conversations.v2') throw new Error('Unsupported conversation data format');
    return this.checkedTarget(type, id, JSON.parse(row.target), !!marker);
  }

  /** Only effects with an explicit conversation target; not an action authorization API. */
  targetedEffect(type: 'outbox' | 'actions', id: string): CanonicalEffect {
    const row = type === 'outbox' ? this.store.output(id) : this.store.action(id);
    if (!row) throw new Error('Effect missing');
    const request = JSON.parse(row.request);
    if (Object.hasOwn(request,'format') && request.format !== 'mate.effect.v2') throw new Error('Unsupported stored effect format');
    const storedTarget = type === 'outbox' ? request.target : request.args?.target ?? request.target;
    if (!storedTarget) throw new Error('Effect has no conversation target');
    return {
      id, actor: row.agent_id, state: row.state, target: this.checkedTarget(type, id, storedTarget, request.format === 'mate.effect.v2'),
      original: { request: row.request, requestHash: row.request_hash, receipt: row.receipt },
    };
  }

  private checkedTarget(type: string, id: string, stored: unknown, canonical = false): ConversationTarget {
    const decoded = canonical ? this.references.validateTarget(conversationTargetSchema.parse(stored)) : this.legacy.target(stored), indexed = this.references.indexedTarget(type, id);
    if (!indexed || indexed.conversationId !== decoded.conversationId || indexed.threadId !== decoded.threadId) throw new Error('Canonical target index missing or inconsistent');
    return decoded;
  }
}
