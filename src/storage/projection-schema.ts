import type {Store} from './store.js';
/** Explicit offline additive migration; configuration and network are not touched. */
export function migrateProjections(store:Store):void {
  store.atomic(()=>{
    const version=store.db.pragma('user_version',{simple:true});if(version===19||version===20||version===21||version===22)return;
    if(version!==18)throw new Error('Internal conversation schema required');
    store.db.exec(`
      CREATE TABLE projection_bindings(
        id TEXT PRIMARY KEY,provider TEXT NOT NULL,workspace TEXT NOT NULL,external_id TEXT NOT NULL,
        publisher TEXT NOT NULL REFERENCES agents(id),enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),imports TEXT NOT NULL,
        UNIQUE(provider,workspace,external_id),
        FOREIGN KEY(provider,workspace,external_id) REFERENCES conversation_bindings(provider,workspace,external_id));
      CREATE TABLE projection_outbox(
        id TEXT PRIMARY KEY,binding_id TEXT NOT NULL REFERENCES projection_bindings(id),message_id TEXT NOT NULL REFERENCES message_identities(id),
        source_revision TEXT NOT NULL,text TEXT NOT NULL,anchor INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL CHECK(state IN ('pending','held','sending','unknown','sent','failed')),
        reason TEXT,wire TEXT,request_hash TEXT,receipt TEXT,retry_at INTEGER NOT NULL DEFAULT 0,drift TEXT,
        UNIQUE(binding_id,message_id));
      CREATE INDEX projection_pending ON projection_outbox(state,binding_id);
      CREATE TRIGGER projection_binding_identity BEFORE UPDATE OF provider,workspace,external_id,publisher ON projection_bindings
        WHEN NEW.provider IS NOT OLD.provider OR NEW.workspace IS NOT OLD.workspace OR NEW.external_id IS NOT OLD.external_id OR NEW.publisher IS NOT OLD.publisher
        BEGIN SELECT RAISE(ABORT,'Projection binding identity is immutable'); END;
      CREATE TRIGGER projection_intent_identity BEFORE UPDATE OF binding_id,message_id,source_revision,text,anchor ON projection_outbox
        WHEN NEW.binding_id IS NOT OLD.binding_id OR NEW.message_id IS NOT OLD.message_id OR NEW.source_revision IS NOT OLD.source_revision OR NEW.text IS NOT OLD.text OR NEW.anchor IS NOT OLD.anchor
        BEGIN SELECT RAISE(ABORT,'Projection intent is immutable'); END;
      CREATE TRIGGER projection_wire_identity BEFORE UPDATE OF wire,request_hash ON projection_outbox
        WHEN OLD.wire IS NOT NULL AND (NEW.wire IS NOT OLD.wire OR NEW.request_hash IS NOT OLD.request_hash)
        BEGIN SELECT RAISE(ABORT,'Projection wire is immutable'); END;
      PRAGMA user_version=19;
    `);
  });
}
