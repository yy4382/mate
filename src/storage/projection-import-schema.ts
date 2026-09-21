import type {Store} from './store.js';
export function migrateProjectionImports(store:Store):void {
  store.atomic(()=>{
    const version=store.db.pragma('user_version',{simple:true});if(version===20||version===21)return;
    if(version!==19)throw new Error('Projection schema required');
    store.db.exec(`
      ALTER TABLE projection_bindings ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE projection_imports(
        binding_id TEXT NOT NULL REFERENCES projection_bindings(id),external_id TEXT NOT NULL,
        external_revision TEXT NOT NULL,root_external TEXT NOT NULL,body TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending_dependency','applied','rejected')),reason TEXT,
        message_id TEXT REFERENCES message_identities(id),PRIMARY KEY(binding_id,external_id));
      CREATE INDEX projection_import_pending ON projection_imports(status,binding_id);
      PRAGMA user_version=20;
    `);
    store.db.prepare('UPDATE projection_bindings SET created_at=?').run(Date.now());
  });
}
