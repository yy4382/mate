import type {Store} from './store.js';
import {beginCanonicalSchema,finishCanonicalSchema} from './canonical-schema.js';

/** Empty local bootstrap never attempts to reinterpret another adapter's historical data. */
export function initializeCanonicalStore(store:Store):void {
  store.atomic(()=>{
    const marker=store.db.prepare("SELECT value FROM runtime_meta WHERE key='conversation_format'").get() as {value:string}|undefined;
    if(marker){if(marker.value!=='mate.conversations.v2')throw new Error('Unsupported conversation format');return;}
    if(store.db.pragma('user_version',{simple:true})!==16)throw new Error('Unsupported bootstrap schema');
    // Only a newly-created store is eligible; even a queued action can contain legacy references.
    for(const row of store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]){
      if(store.db.prepare(`SELECT 1 FROM "${row.name.replaceAll('"','""')}" LIMIT 1`).get())throw new Error('Local bootstrap requires an empty store');
    }
    beginCanonicalSchema(store);finishCanonicalSchema(store);store.db.exec('DROP TABLE canonical_targets');
    store.db.prepare("INSERT INTO runtime_meta VALUES('conversation_format','mate.conversations.v2')").run();
    store.db.pragma('user_version=17');
  });
}
/** Caller owns the offline lock/backup for an existing deployment. */
export function migrateInternalConversations(store:Store):void {
  store.atomic(()=>{
    const version=store.db.pragma('user_version',{simple:true});
    if(version===18)return;
    const marker=store.db.prepare("SELECT value FROM runtime_meta WHERE key='conversation_format'").get() as {value:string}|undefined;
    if(version!==17||marker?.value!=='mate.conversations.v2')throw new Error('Canonical schema required');
    store.db.exec(`
      CREATE TABLE internal_dm_pairs(pair TEXT PRIMARY KEY,conversation_id TEXT NOT NULL UNIQUE REFERENCES conversation_identities(id));
      CREATE TABLE internal_members(conversation_id TEXT NOT NULL REFERENCES conversation_identities(id),kind TEXT NOT NULL CHECK(kind IN ('agent','human')),principal_id TEXT NOT NULL,PRIMARY KEY(conversation_id,kind,principal_id));
      CREATE TABLE internal_sequence(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL);
      INSERT INTO internal_sequence VALUES(1,0);
      CREATE TABLE local_inputs(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES message_identities(id));
      PRAGMA user_version=18;
    `);
  });
}
