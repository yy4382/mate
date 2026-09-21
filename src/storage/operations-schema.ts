import type {Store} from './store.js';

/** Additive owner-operations migration. It never invents timestamps or facts for old rows. */
export function migrateOperationsView(store:Store):void {
  store.atomic(()=>{
    const version=Number(store.db.pragma('user_version',{simple:true}));
    if(version===23)return;
    if(version!==22)throw new Error('Coordination recovery migration required');
    const now=Date.now();
    store.db.exec(`
      ALTER TABLE actions ADD COLUMN created_at INTEGER;
      ALTER TABLE outbox ADD COLUMN created_at INTEGER;
      ALTER TABLE reminder_events ADD COLUMN actor_id TEXT REFERENCES agents(id);
      ALTER TABLE reminder_firings ADD COLUMN actor_id TEXT REFERENCES agents(id);
      UPDATE reminder_events SET actor_id=(SELECT agent_id FROM schedules WHERE schedules.id=reminder_events.reminder_id);
      UPDATE reminder_firings SET actor_id=(SELECT agent_id FROM schedules WHERE schedules.id=reminder_firings.reminder_id);
      CREATE TABLE reminder_event_baselines(
        reminder_id TEXT PRIMARY KEY REFERENCES schedules(id),
        historical_complete INTEGER NOT NULL CHECK(historical_complete IN (0,1)),
        migrated_at INTEGER NOT NULL
      );
      CREATE INDEX action_activity ON actions(created_at DESC,id DESC) WHERE created_at IS NOT NULL;
      CREATE INDEX output_activity ON outbox(created_at DESC,id DESC) WHERE created_at IS NOT NULL;
      CREATE INDEX run_activity ON runs(created_at DESC,id DESC);
      CREATE INDEX run_activity_actor ON runs(agent_id,created_at DESC,id DESC);
      CREATE INDEX action_activity_actor ON actions(agent_id,created_at DESC,id DESC) WHERE created_at IS NOT NULL;
      CREATE INDEX output_activity_actor ON outbox(agent_id,created_at DESC,id DESC) WHERE created_at IS NOT NULL;
      CREATE INDEX action_uncertain_status ON actions(id DESC) WHERE state IN ('executing','unknown');
      CREATE INDEX output_unknown_status ON outbox(id DESC) WHERE state='unknown';
      CREATE INDEX output_held_status ON outbox(id DESC) WHERE state='held';
      CREATE INDEX action_missing_activity_time ON actions(id) WHERE created_at IS NULL;
      CREATE INDEX output_missing_activity_time ON outbox(id) WHERE created_at IS NULL;
      CREATE INDEX draft_output_lookup ON drafts(outbox_id,id DESC);
      CREATE INDEX schedule_due_status ON schedules(active,next_at,id);
      CREATE TABLE operational_facts(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('runtime','internal_dm')),
        source_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('run_completed','run_failed','run_interrupted','internal_dm_created')),
        actor_id TEXT REFERENCES agents(id),
        subject_type TEXT NOT NULL CHECK(subject_type IN ('run','internal_dm')),
        subject_id TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        counts TEXT NOT NULL DEFAULT '{}',
        CHECK(
          source='runtime' AND kind IN ('run_completed','run_failed','run_interrupted') AND actor_id IS NOT NULL
            AND subject_type='run' AND target_type IS NULL AND target_id IS NULL AND counts='{}'
          OR source='internal_dm' AND kind='internal_dm_created' AND actor_id IS NOT NULL
            AND subject_type='internal_dm' AND target_type IS NULL AND target_id IS NULL
            AND json_valid(counts) AND json_type(counts,'$.members')='integer' AND json_extract(counts,'$.members')=2
            AND json_remove(counts,'$.members')='{}'
        ),
        UNIQUE(source,source_id)
      );
      CREATE INDEX operational_fact_activity ON operational_facts(at DESC,seq DESC);
      CREATE INDEX operational_fact_source_activity ON operational_facts(source,at DESC,seq DESC);
      CREATE INDEX operational_fact_actor_activity ON operational_facts(actor_id,at DESC,seq DESC);
      CREATE INDEX operational_fact_source_actor_activity ON operational_facts(source,actor_id,at DESC,seq DESC);
      CREATE INDEX operational_fact_kind_activity ON operational_facts(source,kind,at DESC,seq DESC);
      CREATE INDEX operational_fact_actor_kind_activity ON operational_facts(source,actor_id,kind,at DESC,seq DESC);
      CREATE INDEX reminder_activity ON reminder_events(at DESC,seq DESC);
      CREATE INDEX reminder_activity_actor ON reminder_events(actor_id,at DESC,seq DESC);
      CREATE INDEX reminder_activity_kind ON reminder_events(kind,at DESC,seq DESC);
      CREATE INDEX reminder_activity_actor_kind ON reminder_events(actor_id,kind,at DESC,seq DESC);
      CREATE INDEX reminder_firing_activity ON reminder_firings(due_at DESC,id DESC);
      CREATE INDEX reminder_firing_activity_actor ON reminder_firings(actor_id,due_at DESC,id DESC);
      CREATE INDEX task_activity ON task_events(at DESC,id DESC);
      CREATE INDEX task_activity_actor ON task_events(COALESCE(json_extract(body,'$.actor'),json_extract(body,'$.agentId')),at DESC,id DESC);
      CREATE INDEX task_activity_kind ON task_events(('task.'||json_extract(body,'$.action')),at DESC,id DESC);
      CREATE INDEX task_activity_actor_kind ON task_events(COALESCE(json_extract(body,'$.actor'),json_extract(body,'$.agentId')),('task.'||json_extract(body,'$.action')),at DESC,id DESC);
      CREATE INDEX task_baseline_gaps ON task_event_baselines(task_id) WHERE historical_complete=0;
      CREATE INDEX reminder_baseline_gaps ON reminder_event_baselines(reminder_id) WHERE historical_complete=0;
      PRAGMA user_version=23;
    `);
    store.db.prepare("INSERT INTO reminder_event_baselines SELECT id,CASE WHEN EXISTS(SELECT 1 FROM reminder_events e WHERE e.reminder_id=schedules.id AND e.kind='legacy_migrated') THEN 0 ELSE 1 END,? FROM schedules").run(now);
    store.db.prepare("INSERT INTO runtime_meta(key,value) VALUES('operations_view_since',?) ON CONFLICT(key) DO NOTHING").run(String(now));
    store.db.prepare("INSERT INTO audit(at,kind,body) VALUES(?,'operations_view_migration',?)").run(now,JSON.stringify({policy:'old actions and outputs keep unknown time; operational facts begin now; no synthetic history'}));
  });
}
