import type { Store } from "./store.js";

/** Offline additive migration: bound canonical history ordering on low-resource hosts. */
export function migrateHistoryIndexes(store: Store): void {
  store.atomic(() => {
    const version = Number(store.db.pragma("user_version", { simple: true }));
    if (version === 21 || version === 22 || version === 23 || version === 24 || version === 25)
      return;
    if (version !== 20) throw new Error("Projection import schema required");
    store.db.exec(`
      CREATE TABLE message_visibility_next(
        agent_id TEXT NOT NULL REFERENCES agents(id),key TEXT NOT NULL REFERENCES messages(key),revision TEXT NOT NULL,body TEXT NOT NULL,
        PRIMARY KEY(agent_id,key),FOREIGN KEY(key,revision) REFERENCES message_revisions(key,revision));
      INSERT INTO message_visibility_next(agent_id,key,revision,body)
        SELECT v.agent_id,v.key,COALESCE(
          (SELECT o.revision FROM message_observations o WHERE o.agent_id=v.agent_id AND o.key=v.key
            ORDER BY length(o.revision) DESC,o.revision DESC LIMIT 1),m.revision),COALESCE(
          (SELECT r.body FROM message_observations o JOIN message_revisions r ON r.key=o.key AND r.revision=o.revision
            WHERE o.agent_id=v.agent_id AND o.key=v.key ORDER BY length(o.revision) DESC,o.revision DESC LIMIT 1),m.body)
        FROM message_visibility v JOIN messages m ON m.key=v.key;
      DROP TABLE message_visibility;
      ALTER TABLE message_visibility_next RENAME TO message_visibility;
      CREATE INDEX message_history_conversation ON messages(channel,length(ts) DESC,ts DESC,key DESC);
      CREATE INDEX message_history_thread ON messages(channel,thread,length(ts) DESC,ts DESC,key DESC);
      INSERT INTO audit(at,kind,body) VALUES(CAST(strftime('%s','now') AS INTEGER)*1000,'history_visibility_backfill',
        json_object('policy','highest actor observation snapshot; current stored snapshot when no observation exists'));
      PRAGMA user_version=21;
    `);
  });
}
