import type {Store} from './store.js';

/** Structural changes shared by the legacy conversion and empty canonical bootstrap. */
export function beginCanonicalSchema(store:Store):void {
    // Preserve primary keys/FKs while removing the legacy NOT NULL root constraint.
    store.db.exec(`
      ALTER TABLE outbox ADD COLUMN target TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE messages ADD COLUMN canonical_thread TEXT;
      UPDATE messages SET canonical_thread=thread;
      ALTER TABLE messages DROP COLUMN thread;
      ALTER TABLE messages RENAME COLUMN canonical_thread TO thread;
      DROP INDEX conversation_event_target;
      ALTER TABLE conversation_events ADD COLUMN canonical_thread TEXT;
      UPDATE conversation_events SET canonical_thread=thread;
      ALTER TABLE conversation_events DROP COLUMN thread;
      ALTER TABLE conversation_events RENAME COLUMN canonical_thread TO thread;
      CREATE INDEX conversation_event_target ON conversation_events(channel,thread,seq);
    `);
}
export function finishCanonicalSchema(store:Store):void {
    store.db.exec(`
      CREATE INDEX outbox_scope ON outbox(json_extract(target,'$.conversationId'),json_extract(target,'$.threadId'),state);
      CREATE TRIGGER outbox_target_required BEFORE INSERT ON outbox WHEN json_type(NEW.target,'$.conversationId') IS NOT 'text'
        OR NOT EXISTS(SELECT 1 FROM conversation_identities WHERE id=json_extract(NEW.target,'$.conversationId'))
        OR (json_type(NEW.target,'$.threadId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM message_identities WHERE id=json_extract(NEW.target,'$.threadId') AND root_id=id AND conversation_id=json_extract(NEW.target,'$.conversationId')))
        BEGIN SELECT RAISE(ABORT,'Canonical output routing required'); END;
      CREATE TRIGGER outbox_target_immutable BEFORE UPDATE OF target ON outbox WHEN NEW.target IS NOT OLD.target
        BEGIN SELECT RAISE(ABORT,'Output target is immutable'); END;
      CREATE INDEX task_conversation ON tasks(json_extract(target,'$.conversationId'));
      CREATE INDEX work_conversation ON works(json_extract(target,'$.conversationId'));
      CREATE INDEX schedule_conversation ON schedules(json_extract(target,'$.conversationId'));
      CREATE INDEX intent_conversation ON task_intents(json_extract(target,'$.conversationId'));
    `);
}
