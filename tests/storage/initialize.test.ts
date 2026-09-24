import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { UnsupportedDatabaseError, openCurrentDatabase } from "../../src/storage/initialize.js";

const roots: string[] = [];

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), "mate-format-"));
  roots.push(root);
  return root;
}

/** Every byte in the directory, so a rejected open is proven to touch nothing at all. */
function directoryState(directory: string): { file: string; bytes: string }[] {
  return readdirSync(directory)
    .sort()
    .map((file) => ({ file, bytes: readFileSync(join(directory, file)).toString("base64") }));
}

function rejected(path: string): Error {
  try {
    openCurrentDatabase(path).close();
  } catch (error) {
    return error as Error;
  }
  throw new Error(`Expected the open entry to reject ${path}`);
}

/** The structures the first release persists: messages, members, deliveries, tasks, reminders, sessions, usage, drafts and operation results. */
const requiredTables = [
  "actions",
  "admin_replies",
  "agent_checkpoints",
  "agents",
  "attention_presented",
  "attention_seen",
  "attention_state",
  "attention_views",
  "audit",
  "channel_access",
  "channel_watches",
  "conversation_bindings",
  "conversation_events",
  "conversation_identities",
  "deliveries",
  "delivery_context",
  "delivery_work",
  "drafts",
  "entries",
  "inbox_reads",
  "ingress",
  "internal_dm_pairs",
  "internal_members",
  "internal_sequence",
  "local_inputs",
  "message_bindings",
  "message_identities",
  "message_observations",
  "message_revisions",
  "message_visibility",
  "message_work",
  "messages",
  "model_usage",
  "operational_facts",
  "outbox",
  "output_work",
  "projection_bindings",
  "projection_imports",
  "projection_outbox",
  "reminder_event_baselines",
  "reminder_events",
  "reminder_firings",
  "review_seats",
  "run_context",
  "runs",
  "runtime_meta",
  "schedules",
  "session_resets",
  "sessions",
  "slack_cursors",
  "snapshots",
  "system_projections",
  "system_requests",
  "task_event_baselines",
  "task_events",
  "task_intents",
  "task_projections",
  "tasks",
  "thread_watches",
  "work_runs",
  "works",
];
const requiredIndexes = [
  "action_activity",
  "action_activity_actor",
  "action_missing_activity_time",
  "action_uncertain_status",
  "canonical_message_task",
  "conversation_event_target",
  "draft_output_lookup",
  "intent_conversation",
  "message_history_conversation",
  "message_history_thread",
  "model_usage_agent",
  "model_usage_work",
  "one_active_run",
  "one_pending_reset",
  "one_primary_conversation_binding",
  "operational_fact_activity",
  "operational_fact_actor_activity",
  "operational_fact_actor_kind_activity",
  "operational_fact_kind_activity",
  "operational_fact_source_activity",
  "operational_fact_source_actor_activity",
  "outbox_scope",
  "output_activity",
  "output_activity_actor",
  "output_held_status",
  "output_missing_activity_time",
  "output_unknown_status",
  "projection_import_pending",
  "projection_pending",
  "reminder_activity",
  "reminder_activity_actor",
  "reminder_activity_actor_kind",
  "reminder_activity_kind",
  "reminder_baseline_gaps",
  "reminder_events_page",
  "reminder_firing_activity",
  "reminder_firing_activity_actor",
  "reminder_firings_page",
  "run_activity",
  "run_activity_actor",
  "schedule_conversation",
  "schedule_due_status",
  "system_requests_pending",
  "task_activity",
  "task_activity_actor",
  "task_activity_actor_kind",
  "task_activity_kind",
  "task_baseline_gaps",
  "task_conversation",
  "task_events_page",
  "task_list_assigned",
  "task_list_available",
  "task_list_conversation",
  "task_list_owner",
  "task_list_status",
  "task_list_thread",
  "task_message_lookup",
  "work_conversation",
];
const requiredTriggers = [
  "outbox_target_immutable",
  "outbox_target_required",
  "projection_binding_identity",
  "projection_intent_identity",
  "projection_wire_identity",
];

function names(db: import("better-sqlite3").Database, type: string): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type=? AND name NOT LIKE 'sqlite_%'")
      .all(type) as { name: string }[]
  )
    .map((row) => row.name)
    .sort();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("creates the current format in one step", () => {
  const path = join(temporary(), "mate.sqlite"),
    db = openCurrentDatabase(path);
  try {
    expect(names(db, "table")).toEqual([...requiredTables].sort());
    expect(names(db, "index")).toEqual([...requiredIndexes].sort());
    expect(names(db, "trigger")).toEqual([...requiredTriggers].sort());
    // The file identifies itself as this release's format, not an earlier or later schema.
    expect(db.pragma("application_id", { simple: true })).toBe(1296127045);
    expect(db.pragma("user_version", { simple: true })).toBe(25);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    // Structures the first release needs immediately, not only after a later open.
    expect(db.prepare("SELECT value FROM internal_sequence WHERE id=1").get()).toEqual({
      value: 0,
    });
    expect(
      db.prepare("SELECT value FROM runtime_meta WHERE key='conversation_format'").get() as {
        value: string;
      },
    ).toEqual({ value: "mate.conversations.v2" });
  } finally {
    db.close();
  }
});

it("enforces the constraints that guard atomic local state", () => {
  const db = openCurrentDatabase(join(temporary(), "mate.sqlite"));
  try {
    db.exec(`
      INSERT INTO agents(id,session_id) VALUES('alice','session-1');
      INSERT INTO sessions(id,agent_id,config_version) VALUES('session-1','alice','v1');
      INSERT INTO conversation_identities(id,kind,authority) VALUES('room','channel','internal');
      INSERT INTO messages(key,channel,ts,revision,body,deleted) VALUES('room:1','room','1','r1','{}',0);
      INSERT INTO messages(key,channel,ts,revision,body,deleted) VALUES('room:2','room','2','r1','{}',0);
      INSERT INTO message_revisions(key,revision,body) VALUES('room:1','r1','{}');
    `);
    // Foreign keys: a delivery cannot name an Agent that does not exist.
    expect(() =>
      db
        .prepare(
          "INSERT INTO deliveries(id,agent_id,dedupe,payload,priority,created_at) VALUES('d1','ghost','x','{}',0,0)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    // Uniqueness: one pending delivery per Agent and dedupe key.
    db.prepare(
      "INSERT INTO deliveries(id,agent_id,dedupe,payload,priority,created_at) VALUES('d1','alice','x','{}',0,0)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO deliveries(id,agent_id,dedupe,payload,priority,created_at) VALUES('d2','alice','x','{}',0,0)",
        )
        .run(),
    ).toThrow(/UNIQUE/);
    // Check constraints: delivery and run states stay in the supported set.
    expect(() =>
      db
        .prepare(
          "INSERT INTO deliveries(id,agent_id,dedupe,payload,priority,created_at,status) VALUES('d3','alice','y','{}',0,0,'bogus')",
        )
        .run(),
    ).toThrow(/CHECK/);
    db.exec(`
      INSERT INTO deliveries(id,agent_id,dedupe,payload,priority,created_at) VALUES('d4','alice','z','{}',0,0);
      INSERT INTO runs(id,agent_id,session_id,generation,delivery_id,state,created_at) VALUES('r1','alice','session-1',1,'d4','active',0);
    `);
    // One active run per Agent even under competing writers.
    expect(() =>
      db
        .prepare(
          "INSERT INTO runs(id,agent_id,session_id,generation,delivery_id,state,created_at) VALUES('r2','alice','session-1',2,'d4','active',0)",
        )
        .run(),
    ).toThrow(/UNIQUE/);
    // Composite foreign key: a visibility row must reference a stored revision.
    expect(() =>
      db
        .prepare(
          "INSERT INTO message_visibility(agent_id,key,revision,body) VALUES('alice','room:2','r1','{}')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    db.prepare(
      "INSERT INTO message_visibility(agent_id,key,revision,body) VALUES('alice','room:1','r1','{}')",
    ).run();
    // Triggers: an output cannot exist without canonical routing.
    expect(() =>
      db
        .prepare(
          "INSERT INTO outbox(id,agent_id,request_hash,request,state) VALUES('o1','alice','h','{}','pending')",
        )
        .run(),
    ).toThrow(/Canonical output routing required/);
    // Cross-column check: operation facts keep one supported shape.
    expect(() =>
      db
        .prepare(
          "INSERT INTO operational_facts(at,source,source_id,kind,actor_id,subject_type,subject_id,counts) VALUES(0,'runtime','r1:complete','run_completed','alice','internal_dm','x','{\"members\":2}')",
        )
        .run(),
    ).toThrow(/CHECK/);
  } finally {
    db.close();
  }
});

it("keeps existing data when the same format is opened again", () => {
  const directory = temporary(),
    path = join(directory, "mate.sqlite"),
    created = openCurrentDatabase(path);
  created.exec(`
    INSERT INTO agents(id,session_id) VALUES('alice','session-1');
    INSERT INTO sessions(id,agent_id,config_version) VALUES('session-1','alice','v1');
    INSERT INTO entries(session_id,seq,key,message) VALUES('session-1',1,'initial:0','{"role":"system"}');
    INSERT INTO snapshots(session_id,watermark,body,hash) VALUES('session-1',1,'[]','hash');
    INSERT INTO conversation_identities(id,kind,authority) VALUES('room','channel','internal');
    INSERT INTO messages(key,channel,ts,revision,body,deleted) VALUES('room:1','room','1','r1','{"text":"first"}',0);
    INSERT INTO messages(key,channel,ts,revision,body,deleted) VALUES('room:2','room','2','r1','{"text":"second"}',0);
    INSERT INTO message_revisions(key,revision,body) VALUES('room:1','r1','{"text":"first"}');
    INSERT INTO message_visibility(agent_id,key,revision,body) VALUES('alice','room:1','r1','{"text":"first"}');
    INSERT INTO channel_access(agent_id,channel,active) VALUES('alice','room',1);
    INSERT INTO internal_members(conversation_id,kind,principal_id) VALUES('room','agent','alice');
    INSERT INTO works(id,origin,target,state) VALUES('work-1','origin-1','{}','active');
    INSERT INTO deliveries(id,agent_id,dedupe,payload,priority,created_at,status) VALUES('d1','alice','dedupe-1','{"text":"do"}',0,0,'pending');
    INSERT INTO delivery_work(delivery_id,work_id) VALUES('d1','work-1');
    INSERT INTO runs(id,agent_id,session_id,generation,delivery_id,state,created_at) VALUES('run-1','alice','session-1',1,'d1','complete',0);
    INSERT INTO tasks(id,work_id,target,title,status,created_by,message_key,legacy) VALUES('t1','work-1','{"conversationId":"room"}','Do it','todo','alice','room:1',0);
    INSERT INTO task_events(task_id,at,body) VALUES('t1',1,'{"action":"create"}');
    INSERT INTO task_event_baselines(task_id,complete_after_version,historical_complete,migrated_at) VALUES('t1',0,1,0);
    INSERT INTO schedules(id,agent_id,work_id,target,next_at,timezone,content,projection) VALUES('s1','alice','work-1','{"conversationId":"room"}',123,'UTC','Follow up','private');
    INSERT INTO reminder_events(reminder_id,version,kind,at,payload,actor_id) VALUES('s1',1,'created',1,'{}','alice');
    INSERT INTO reminder_firings(id,reminder_id,due_at,version,delivery_id,actor_id) VALUES('f1','s1',123,1,'d1','alice');
    INSERT INTO model_usage(run_id,call_index,agent_id,work_id,provider,model_id,state,source) VALUES('run-1',0,'alice','work-1','test','test-model','unknown','runtime');
    INSERT INTO outbox(id,agent_id,request_hash,request,state,target,created_at) VALUES('o1','alice','request-hash','{"text":"hi"}','pending','{"conversationId":"room"}',0);
    INSERT INTO drafts(id,agent_id,outbox_id,revision,reason) VALUES('dr1','alice','o1',2,'freshness');
    INSERT INTO actions(id,agent_id,run_id,request_hash,request,state,created_at) VALUES('a1','alice','run-1','request-hash','{}','executing',0);
    INSERT INTO system_requests(id,agent_id,work_id,request_hash,request,expires,status) VALUES('sr1','alice','work-1','request-hash','{}',999,'pending');
    INSERT INTO operational_facts(at,source,source_id,kind,actor_id,subject_type,subject_id,counts) VALUES(0,'runtime','run-1:complete','run_completed','alice','run','run-1','{}');
    UPDATE internal_sequence SET value=7;
    INSERT INTO runtime_meta(key,value) VALUES('test_marker','kept');
  `);
  created.close();
  const seeded = directoryState(directory);

  const reopened = openCurrentDatabase(path);
  try {
    expect(reopened.pragma("application_id", { simple: true })).toBe(1296127045);
    expect(reopened.pragma("user_version", { simple: true })).toBe(25);
    expect(reopened.pragma("foreign_keys", { simple: true })).toBe(1);
    for (const [table, count] of Object.entries({
      agents: 1,
      sessions: 1,
      entries: 1,
      snapshots: 1,
      conversation_identities: 1,
      messages: 2,
      message_revisions: 1,
      message_visibility: 1,
      channel_access: 1,
      internal_members: 1,
      works: 1,
      deliveries: 1,
      delivery_work: 1,
      runs: 1,
      tasks: 1,
      task_events: 1,
      task_event_baselines: 1,
      schedules: 1,
      reminder_events: 1,
      reminder_firings: 1,
      model_usage: 1,
      outbox: 1,
      drafts: 1,
      actions: 1,
      system_requests: 1,
      operational_facts: 1,
      runtime_meta: 2,
    }))
      expect([
        table,
        (reopened.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n,
      ]).toEqual([table, count]);
    // Existing rows survive verbatim, including the draft revision and the sequence the app advances.
    expect(reopened.prepare("SELECT status,version FROM tasks WHERE id='t1'").get()).toEqual({
      status: "todo",
      version: 0,
    });
    expect(reopened.prepare("SELECT revision,reason FROM drafts WHERE id='dr1'").get()).toEqual({
      revision: 2,
      reason: "freshness",
    });
    expect(reopened.prepare("SELECT value FROM internal_sequence WHERE id=1").get()).toEqual({
      value: 7,
    });
    expect(
      reopened.prepare("SELECT value FROM runtime_meta WHERE key='test_marker'").get(),
    ).toEqual({ value: "kept" });
    // A reopened file is the same file: no backup copy, no second database, no wipe.
    reopened.close();
    expect(directoryState(directory)).toEqual(seeded);
  } finally {
    if (reopened.open) reopened.close();
  }
});

it("rejects an older Mate database, an unknown revision and unreadable files without touching them", () => {
  const directory = temporary();
  const cases: { file: string; prepare: (path: string) => void; message: RegExp }[] = [
    {
      // A database from the migration chain that this release replaced.
      file: "old.sqlite",
      prepare: (path) => {
        const db = new Database(path);
        db.exec(
          "PRAGMA user_version = 16; CREATE TABLE agents(id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE); CREATE TABLE sessions(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL);",
        );
        db.close();
      },
      message:
        /is not a Mate first-release database .*application id 0, schema revision 16.*does not migrate earlier databases/s,
    },
    {
      // The migration chain's terminal revision, which never carried this release's identity.
      file: "chain-head.sqlite",
      prepare: (path) => {
        const db = new Database(path);
        db.exec(
          "PRAGMA user_version = 25; CREATE TABLE agents(id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE); CREATE TABLE runtime_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        );
        db.close();
      },
      message:
        /is not a Mate first-release database .*application id 0, schema revision 25.*does not migrate earlier databases/s,
    },
    {
      // Another application's SQLite database must not be adopted or emptied.
      file: "foreign.sqlite",
      prepare: (path) => {
        const db = new Database(path);
        db.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL);");
        db.prepare("INSERT INTO notes(id,body) VALUES(1,'keep me')").run();
        db.close();
      },
      message: /is not a Mate first-release database .*application id 0, schema revision 0/s,
    },
    {
      // A future or foreign revision of this application's format.
      file: "future.sqlite",
      prepare: (path) => {
        const db = new Database(path);
        db.exec("PRAGMA application_id = 1296127045; PRAGMA user_version = 26;");
        db.close();
      },
      message: /uses Mate schema revision 26; this release uses revision 25/s,
    },
    {
      // The right identity but an incomplete file: never read as current, never repaired silently.
      file: "incomplete.sqlite",
      prepare: (path) => {
        const db = new Database(path);
        db.exec(
          "PRAGMA application_id = 1296127045; PRAGMA user_version = 25; CREATE TABLE agents(id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE);",
        );
        db.close();
      },
      message:
        /claims Mate schema revision 25 but is missing table sessions, table entries.*Refusing to modify it/s,
    },
    {
      // A complete-looking file that lost the uniqueness index guarding one active run per Agent.
      file: "partial-invariants.sqlite",
      prepare: (path) => {
        openCurrentDatabase(path).close();
        const db = new Database(path);
        db.exec("DROP INDEX one_active_run;");
        db.close();
      },
      message: /claims Mate schema revision 25 but is missing index one_active_run/,
    },
    {
      // Not a database at all.
      file: "garbage.sqlite",
      prepare: (path) => writeFileSync(path, "this is not a sqlite database\n"),
      message: /cannot be read as a SQLite database .*does not migrate earlier databases/s,
    },
  ];
  for (const { file, prepare, message } of cases) {
    const path = join(directory, file);
    prepare(path);
    const before = directoryState(directory);
    const error = rejected(path);
    expect([file, error instanceof UnsupportedDatabaseError]).toEqual([file, true]);
    expect([file, error.message]).toEqual([file, expect.stringMatching(message)]);
    // Normal startup reports the problem; it does not clear or rewrite the directory.
    expect([file, directoryState(directory)]).toEqual([file, before]);
  }
});

it("reopens a copy made through the backup path used by checkpoints", async () => {
  const directory = temporary(),
    path = join(directory, "mate.sqlite"),
    copyPath = join(directory, "checkpoint.sqlite"),
    created = openCurrentDatabase(path);
  created
    .prepare("INSERT INTO agents(id,session_id,generation) VALUES(?,?,?)")
    .run("alice", "session-1", 4);
  await created.backup(copyPath);
  created.close();

  const copy = openCurrentDatabase(copyPath);
  try {
    expect(copy.prepare("SELECT session_id,generation FROM agents").all()).toEqual([
      { session_id: "session-1", generation: 4 },
    ]);
  } finally {
    copy.close();
  }
});
