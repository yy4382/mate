import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { OwnerAuth } from "../../src/owner-auth.js";
import { preparingStages } from "../../src/agents/directory.js";
import { controlPlaneSchema } from "../../src/schema.js";

const dataDirectories: string[] = [];
const applicationId = 0x4d43504c;

afterEach(() => {
  for (const directory of dataDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "mate-control-plane-database-"));
  dataDirectories.push(dataDir);
  return { dataDir, path: join(dataDir, "control-plane.sqlite") };
}

function makeDatabase(path: string, id: number, revision: number): Database.Database {
  const database = new Database(path);
  database.pragma(`application_id = ${id}`);
  database.pragma(`user_version = ${revision}`);
  return database;
}

function tableNames(database: Database.Database): string[] {
  return (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function columnNames(database: Database.Database, table: string): string[] {
  return (database.pragma(`table_xinfo(${table})`) as Array<{ name: string; hidden: number }>)
    .filter((column) => column.hidden !== 1)
    .map((column) => column.name);
}

function columnCount(database: Database.Database): number {
  return tableNames(database).reduce(
    (total, table) => total + columnNames(database, table).length,
    0,
  );
}

function indexNames(database: Database.Database): string[] {
  return (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function columnNamesForIndex(database: Database.Database, index: string): string[] {
  return (database.pragma(`index_info(${index})`) as Array<{ seqno: number; name: string | null }>)
    .sort((left, right) => left.seqno - right.seqno)
    .map((column) => column.name ?? "");
}

function indexCount(database: Database.Database): number {
  return (
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'",
      )
      .get() as { count: number }
  ).count;
}

it("a new data directory gets the complete format without the Push service", () => {
  const f = fixture();
  const auth = new OwnerAuth({ dataDir: f.dataDir });
  try {
    expect(tableNames(auth.db)).toHaveLength(37);
    expect(columnCount(auth.db)).toBe(247);
    expect(indexCount(auth.db)).toBe(25);
    expect(columnNames(auth.db, "owner_push_deliveries")).toEqual([
      "event_key",
      "endpoint",
      "state",
      "updated_at",
      "attempts",
      "next_attempt_at",
    ]);
    expect(columnNames(auth.db, "owner_sessions")).toEqual([
      "token_hash",
      "created_at",
      "expires_at",
    ]);
    expect(columnNames(auth.db, "owner_messages")).toEqual([
      "id",
      "channel_id",
      "order_seq",
      "text",
      "created_at",
      "author_kind",
      "author_id",
      "root_id",
      "quote_id",
      "internal_kind",
    ]);
    expect(columnNames(auth.db, "owner_agents")).toEqual([
      "id",
      "node_id",
      "name",
      "role",
      "description",
      "provider",
      "model_id",
      "initial_channel_id",
      "request_hash",
      "provision_request_id",
      "stage",
      "error",
      "home",
      "home_marker",
      "created_at",
      "updated_at",
    ]);
    // Readiness is derived from the preparation stage plus the provider's current credential row,
    // and the Linux account belongs to the node, so this table stores neither a second state copy.
    expect(columnNames(auth.db, "owner_agents")).not.toContain("status");
    expect(columnNames(auth.db, "owner_agents")).not.toContain("model_ready");
    expect(columnNames(auth.db, "owner_agents")).not.toContain("request_json");
    expect(columnNames(auth.db, "owner_agent_sessions")).toEqual(["id", "agent_id", "created_at"]);
    expect(columnNames(auth.db, "nodes")).toEqual([
      "id",
      "public_key",
      "paired_at",
      "last_connected_at",
      "linux_username",
      "uid",
      "gid",
    ]);
    expect(columnNamesForIndex(auth.db, "owner_agents_stage")).toEqual([
      "stage",
      "updated_at",
      "id",
    ]);
    expect(indexNames(auth.db)).not.toContain("owner_agents_status");
    expect(columnNames(auth.db, "owner_agent_runs")).toEqual([
      "id",
      "agent_id",
      "node_id",
      "delivery_id",
      "input_end_seq",
      "context_history_end_seq",
      "state",
      "error_code",
      "retry_at",
      "started_at",
      "completed_at",
    ]);
    expect(columnNames(auth.db, "owner_agent_process_operations")).toEqual([
      "operation_id",
      "run_id",
      "agent_id",
      "node_id",
      "request_hash",
      "request_json",
      "state",
      "receipt_json",
      "created_at",
      "updated_at",
      "node_receipt_confirmed",
      "node_receipt_revision",
    ]);
    expect(columnNames(auth.db, "owner_tasks")).toEqual([
      "id",
      "message_id",
      "title",
      "status",
      "owner_agent_id",
      "version",
      "created_at",
      "updated_at",
    ]);
    expect(columnNames(auth.db, "owner_agent_stop_intents")).toEqual([
      "operation_id",
      "agent_id",
      "node_id",
      "state",
      "receipt_json",
      "created_at",
      "updated_at",
      "node_receipt_revision",
    ]);
  } finally {
    auth.close();
  }
});

it("declares a preparation stage the owner_agents CHECK constraint and the guarded updates agree on", () => {
  const database = new Database(":memory:");
  database.exec(controlPlaneSchema);
  try {
    const declaration = (
      database
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='owner_agents'")
        .get() as { sql: string }
    ).sql;
    const declared = declaration
      .match(/stage TEXT NOT NULL CHECK\(stage IN \(([^)]*)\)\)/)![1]!
      .split(",")
      .map((stage) => stage.trim().replaceAll("'", ""));
    // A stage the table accepts but the guarded updates do not name would leave a node report
    // silently moving nothing.
    expect(declared.filter((stage) => stage !== "complete" && stage !== "failed")).toEqual([
      ...preparingStages,
    ]);
  } finally {
    database.close();
  }
});

it("reopens the format it just created with the same tables and revision", () => {
  const f = fixture();
  const created = new OwnerAuth({ dataDir: f.dataDir });
  const before = tableNames(created.db);
  created.close();

  const reopened = new OwnerAuth({ dataDir: f.dataDir });
  try {
    expect(tableNames(reopened.db)).toEqual(before);
    expect(reopened.db.pragma("user_version", { simple: true })).toBe(31);
  } finally {
    reopened.close();
  }
});

it("declares the current tables directly instead of rebuilding or extending them", () => {
  expect(controlPlaneSchema).not.toMatch(/\bALTER TABLE\b/i);
  expect(controlPlaneSchema).not.toMatch(/\bDROP TABLE\b/i);
  expect(controlPlaneSchema).not.toMatch(/\bRENAME TO\b/i);
  expect(controlPlaneSchema).not.toMatch(/owner_agents_v24/);
  expect(controlPlaneSchema).not.toMatch(/owner_privileged_approvals/);
});

it("keeps the constraints of the columns it declares directly", () => {
  const database = new Database(":memory:");
  database.exec(controlPlaneSchema);
  try {
    const requestHash = "a".repeat(64);
    database
      .prepare(
        "INSERT INTO owner_channels(id,name,description,visibility,created_at,updated_at) VALUES('channel','频道','','public',1,1)",
      )
      .run();
    database
      .prepare(
        "INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,joined_at) VALUES('channel','human','owner',1)",
      )
      .run();
    database
      .prepare(
        "INSERT INTO owner_messages(id,channel_id,order_seq,text,created_at) VALUES('message','channel',1,'文本',1)",
      )
      .run();
    database
      .prepare(
        "INSERT INTO owner_message_deliveries(id,message_id,channel_id,recipient_kind,recipient_id,created_at) VALUES('delivery','message','channel','human','owner',1)",
      )
      .run();
    expect(() =>
      database
        .prepare(
          "INSERT INTO owner_messages(id,channel_id,order_seq,text,created_at,author_kind) VALUES('message-2','channel',2,'文本',1,'robot')",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    // UNIQUE(channel_id,order_seq) alone keeps channel order unique; no duplicate explicit index.
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='owner_messages_channel_order'",
        )
        .all(),
    ).toEqual([]);
    expect(() =>
      database
        .prepare(
          "INSERT INTO owner_messages(id,channel_id,order_seq,text,created_at) VALUES('message-3','channel',1,'重复顺序',1)",
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/);

    database
      .prepare("INSERT INTO nodes(id,public_key,paired_at) VALUES('node','public-key',1)")
      .run();
    const insertAgent = database.prepare(
      `INSERT INTO owner_agents(
         id,node_id,name,role,description,provider,model_id,request_hash,
         provision_request_id,stage,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,1,1)`,
    );
    insertAgent.run(
      "agent",
      "node",
      "名字",
      "角色",
      "描述",
      "openai",
      "gpt-4.1",
      requestHash,
      "request",
      "queued",
    );
    expect(() =>
      insertAgent.run(
        "agent-2",
        "node",
        "名字",
        "角色",
        "描述",
        "openai",
        "gpt-4.1",
        requestHash,
        "request-2",
        "creating_account",
      ),
    ).toThrow(/CHECK constraint failed/);
    expect(
      database.prepare("SELECT stage,home,home_marker FROM owner_agents WHERE id='agent'").get(),
    ).toEqual({ stage: "queued", home: null, home_marker: null });
    // The node account columns stay empty until the first successful preparation records them.
    expect(database.prepare("SELECT uid,gid FROM nodes WHERE id='node'").get()).toEqual({
      uid: null,
      gid: null,
    });

    database
      .prepare(
        "INSERT INTO owner_agent_runs(id,agent_id,node_id,delivery_id,state,started_at) VALUES('run','agent','node','delivery','running',1)",
      )
      .run();
    expect(() =>
      database
        .prepare(
          `INSERT INTO owner_agent_process_operations(
             operation_id,run_id,agent_id,node_id,request_hash,
             request_json,state,created_at,updated_at,node_receipt_confirmed
           ) VALUES('operation','run','agent','node',?,'{}','executing',1,1,2)`,
        )
        .run(requestHash),
    ).toThrow(/CHECK constraint failed/);

    expect(() =>
      database
        .prepare(
          `INSERT INTO owner_agent_stop_intents(
             operation_id,agent_id,node_id,state,created_at,updated_at,node_receipt_revision
           ) VALUES('stop','agent','node','executing',1,1,0)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);

    database
      .prepare(
        "INSERT INTO owner_push_events(event_key,title,url,created_at) VALUES('event','标题','/app?channel=channel',1)",
      )
      .run();
    database
      .prepare(
        "INSERT INTO owner_push_deliveries(event_key,endpoint,state,updated_at) VALUES('event','https://push.example.test/1','pending',1)",
      )
      .run();
    expect(
      database.prepare("SELECT attempts,next_attempt_at FROM owner_push_deliveries").get(),
    ).toEqual({ attempts: 0, next_attempt_at: 0 });
    expect(() =>
      database
        .prepare(
          "INSERT INTO owner_push_deliveries(event_key,endpoint,state,updated_at,attempts) VALUES('event','https://push.example.test/2','pending',1,NULL)",
        )
        .run(),
    ).toThrow(/NOT NULL constraint failed/);
  } finally {
    database.close();
  }
});

it("a new control-plane database carries no privileged approval state", () => {
  const f = fixture();
  const auth = new OwnerAuth({ dataDir: f.dataDir });
  try {
    expect(
      auth.db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE name IN ('owner_privileged_approvals','owner_privileged_approval_keys')`,
        )
        .all(),
    ).toEqual([]);
    expect(auth.db.pragma("user_version", { simple: true })).toBe(31);
  } finally {
    auth.close();
  }
});

it("the owner-auth service entry rejects a foreign application id without modifying its database", () => {
  const f = fixture(),
    database = makeDatabase(f.path, 1, 22);
  database.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('keep me')");
  database.close();

  expect(() => new OwnerAuth({ dataDir: f.dataDir })).toThrow(/not a Mate control-plane database/);

  const inspect = new Database(f.path, { readonly: true });
  expect(inspect.prepare("SELECT value FROM unrelated").get()).toEqual({ value: "keep me" });
  inspect.close();
});

it("rejects a corrupt database without replacing or deleting its bytes", () => {
  const f = fixture(),
    corrupt = Buffer.from("not a SQLite database\0mate");
  writeFileSync(f.path, corrupt, { mode: 0o600 });

  expect(() => new OwnerAuth({ dataDir: f.dataDir })).toThrow(
    /could not be read|not a SQLite database/,
  );
  expect(readFileSync(f.path)).toEqual(corrupt);
});

it("rejects an unknown control-plane revision instead of opening it as current", () => {
  const f = fixture(),
    database = makeDatabase(f.path, applicationId, 999);
  database.exec("CREATE TABLE unrelated(value TEXT)");
  database.close();

  expect(() => new OwnerAuth({ dataDir: f.dataDir })).toThrow(/control-plane schema revision 999/);
});

it.each([27, 28, 29, 30])("rejects the superseded control-plane revision %i", (revision) => {
  const f = fixture(),
    database = makeDatabase(f.path, applicationId, revision);
  database.exec("CREATE TABLE unrelated(value TEXT)");
  database.close();

  expect(() => new OwnerAuth({ dataDir: f.dataDir })).toThrow(
    new RegExp(`uses control-plane schema revision ${revision}; this release uses revision 31`),
  );
});

it("rejects a current revision that is missing declared schema structures", () => {
  const f = fixture(),
    database = makeDatabase(f.path, applicationId, 31);
  database.exec("CREATE TABLE unrelated(value TEXT)");
  database.close();

  expect(() => new OwnerAuth({ dataDir: f.dataDir })).toThrow(
    /claims control-plane schema revision 31 but is missing/,
  );
});

it.each(["absent", "ordinary"])(
  "rejects revision 31 when the usage projection column is %s",
  (column) => {
    const f = fixture();
    const auth = new OwnerAuth({ dataDir: f.dataDir });
    auth.close();
    const database = new Database(f.path);
    database.exec(`
    DROP INDEX owner_agent_session_records_usage;
    ALTER TABLE owner_agent_session_records DROP COLUMN usage_json;
  `);
    if (column === "ordinary")
      database.exec("ALTER TABLE owner_agent_session_records ADD COLUMN usage_json TEXT");
    database.exec(
      "CREATE INDEX owner_agent_session_records_usage ON owner_agent_session_records(agent_id,seq)",
    );
    database.close();

    expect(() => new OwnerAuth({ dataDir: f.dataDir })).toThrow(
      /claims control-plane schema revision 31 but is missing .*usage_json/,
    );
  },
);
