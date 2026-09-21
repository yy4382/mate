import type { ConversationTarget } from '../domain/conversations.js';
import type { References } from '../conversations/references.js';
import { encode, type Store, type RunToken, type Effect } from './store.js';

/** Temporary v1 writer port, replaced with canonical payload writes in E2c. */
export interface LegacyReferenceWriter {
  ensureTarget(value: unknown): ConversationTarget;
  recordMessage(body: string): void;
}
export type MutableTargetType = 'works' | 'tasks' | 'schedules' | 'task_intents' | 'review_seats';

/** Every authoritative mutation and its derived references share the caller's transaction. */
export class ConversationWrites {
  constructor(private readonly store: Store, private readonly references: References, private readonly legacy: LegacyReferenceWriter) {}

  target(type: string, id: string, value: unknown): void {
    if (!this.store.db.inTransaction) throw new Error('Target index requires an authoritative transaction');
    this.references.indexTarget(type, id, this.legacy.ensureTarget(value));
  }

  mutable(type: MutableTargetType, id: string): void {
    if (!this.store.db.inTransaction) throw new Error('Target index requires an authoritative transaction');
    const key = type === 'review_seats' ? 'agent_id' : 'id';
    const row = this.store.db.prepare(`SELECT target FROM ${type} WHERE ${key}=?`).get(id) as { target: string } | undefined;
    if (!row) throw new Error('Target object missing after write');
    this.target(type, id, JSON.parse(row.target));
  }

  message(body: string): void {
    if (!this.store.db.inTransaction) throw new Error('Message references require an authoritative transaction');
    this.legacy.recordMessage(body);
  }

  queueOutput(actor: string, id: string, request: { target: unknown; [key: string]: unknown }): Effect {
    return this.store.atomic(() => {
      const row = this.store.queueOutput(actor, id, request);
      this.target('outbox', id, JSON.parse(row.request).target);
      return row;
    });
  }

  enqueue(actor: string, dedupe: string, payload: unknown, priority = 0, now = Date.now()): string {
    return this.store.atomic(() => {
      const id = this.store.enqueue(actor, dedupe, payload, priority, now);
      // Dedupe can return a prior notice with different body; index the stored authority.
      const row = this.store.db.prepare('SELECT payload FROM deliveries WHERE id=?').get(id) as { payload: string };
      const stored = JSON.parse(row.payload);
      if (stored.target) this.target('deliveries', id, stored.target);
      return id;
    });
  }

  prepareAction(run: RunToken, id: string, request: unknown): Effect {
    return this.store.atomic(() => {
      const row = this.store.prepareAction(run, id, request), body = JSON.parse(row.request);
      const target = body.args?.target ?? body.target;
      if (target) this.target('actions', id, target);
      return row;
    });
  }

  attention(actor: string, target: unknown, write: () => void): void {
    this.store.atomic(() => { write(); this.target('attention_state', encode([actor, encode(target)]), target); });
  }
}
