import type { Store } from "./store.js";

/** Offline additive migration for recoverable task/reminder coordination. */
export function migrateCoordinationRecovery(store: Store): void {
  store.atomic(() => {
    const version = Number(store.db.pragma("user_version", { simple: true }));
    if (version === 22 || version === 23 || version === 24 || version === 25) return;
    if (version !== 21) throw new Error("History storage migration required");
    store.db.exec(`
      ALTER TABLE tasks ADD COLUMN created_by TEXT REFERENCES agents(id);
      ALTER TABLE tasks ADD COLUMN legacy INTEGER NOT NULL DEFAULT 1 CHECK(legacy IN (0,1));
      ALTER TABLE schedules ADD COLUMN projection TEXT NOT NULL DEFAULT 'conversation_receipt'
        CHECK(projection IN ('private','conversation_receipt'));
      ALTER TABLE reminder_firings ADD COLUMN result_status TEXT
        CHECK(result_status IN ('completed','failed','deferred'));
      ALTER TABLE reminder_firings ADD COLUMN result_summary TEXT;
      ALTER TABLE reminder_firings ADD COLUMN result_at INTEGER;
      CREATE TABLE task_event_baselines(
        task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        complete_after_version INTEGER NOT NULL,
        historical_complete INTEGER NOT NULL CHECK(historical_complete IN (0,1)),
        migrated_at INTEGER NOT NULL);
      CREATE INDEX task_list_owner ON tasks(owner,id DESC);
      CREATE INDEX task_list_assigned ON tasks(assigned_to,id DESC);
      CREATE INDEX task_list_available ON tasks(id DESC,assigned_to) WHERE owner IS NULL AND status IN ('todo','review');
      CREATE INDEX task_list_status ON tasks(status,id DESC);
      CREATE INDEX task_list_conversation ON tasks(json_extract(target,'$.conversationId'),id DESC);
      CREATE INDEX task_list_thread ON tasks(json_extract(target,'$.conversationId'),json_extract(target,'$.threadId'),id DESC);
      CREATE INDEX task_events_page ON task_events(task_id,id DESC);
      CREATE INDEX reminder_events_page ON reminder_events(reminder_id,seq DESC);
      CREATE INDEX reminder_firings_page ON reminder_firings(reminder_id,due_at DESC,version DESC,id DESC);
      CREATE INDEX task_message_lookup ON tasks(message_key);
    `);
    const now = Date.now();
    const tasks = store.db.prepare("SELECT id,version,outbox_id,assigned_to FROM tasks").all() as {
      id: string;
      version: number;
      outbox_id: string | null;
      assigned_to: string | null;
    }[];
    const createActors = store.db.prepare(
      "SELECT MIN(json_extract(body,'$.agentId')) actor,COUNT(DISTINCT json_extract(body,'$.agentId')) count FROM task_events WHERE task_id=? AND json_type(body,'$.agentId')='text'",
    );
    const outboxActor = store.db.prepare("SELECT agent_id actor FROM outbox WHERE id=?");
    const knownAgent = store.db.prepare("SELECT 1 FROM agents WHERE id=?");
    const setCreator = store.db.prepare("UPDATE tasks SET created_by=? WHERE id=?");
    const baseline = store.db.prepare("INSERT INTO task_event_baselines VALUES(?,?,0,?)");
    const snapshot = store.db.prepare("INSERT INTO task_events(task_id,at,body) VALUES(?,?,?)");
    for (const task of tasks) {
      const evidence = createActors.get(task.id) as {
        actor: string | null;
        count: number;
      };
      const fromEvent =
        evidence.count === 1 && evidence.actor && knownAgent.get(evidence.actor)
          ? { actor: evidence.actor }
          : undefined;
      const fromOutbox = task.outbox_id
        ? (outboxActor.get(task.outbox_id) as { actor: string } | undefined)
        : undefined;
      const actor = fromEvent?.actor ?? fromOutbox?.actor ?? task.assigned_to;
      if (actor) setCreator.run(actor, task.id);
      baseline.run(task.id, task.version, now);
      snapshot.run(
        task.id,
        now,
        JSON.stringify({
          action: "migration_snapshot",
          version: task.version,
          historicalComplete: false,
          createdByEvidence: fromEvent
            ? "create_event"
            : fromOutbox
              ? "draft_outbox"
              : task.assigned_to
                ? "assigned_actor"
                : evidence.count > 1
                  ? "conflicting_create_events"
                  : "unknown",
        }),
      );
    }
    store.db
      .prepare("UPDATE tasks SET legacy=CASE WHEN message_key IS NULL THEN 1 ELSE 0 END")
      .run();
    store.db
      .prepare("INSERT INTO audit(at,kind,body) VALUES(?,'coordination_recovery_migration',?)")
      .run(
        now,
        JSON.stringify({
          taskHistory: "complete only after stored baseline version",
          reminderProjection: "legacy records preserve conversation_receipt",
        }),
      );
    store.db.pragma("user_version=22");
  });
}
