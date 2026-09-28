import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { OwnerAuth } from "../../src/control-plane/owner-auth.js";

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
    expect(auth.db.pragma("user_version", { simple: true })).toBe(27);
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

it("rejects the previous experimental control-plane revision", () => {
  const f = fixture(),
    database = makeDatabase(f.path, applicationId, 26);
  database.exec("CREATE TABLE unrelated(value TEXT)");
  database.close();

  expect(() => new OwnerAuth({ dataDir: f.dataDir })).toThrow(
    /uses control-plane schema revision 26; this release uses revision 27/,
  );
});

it("rejects a current revision that is missing declared schema structures", () => {
  const f = fixture(),
    database = makeDatabase(f.path, applicationId, 27);
  database.exec("CREATE TABLE unrelated(value TEXT)");
  database.close();

  expect(() => new OwnerAuth({ dataDir: f.dataDir })).toThrow(
    /claims control-plane schema revision 27 but is missing/,
  );
});

it.each(["absent", "ordinary"])(
  "rejects revision 27 when the usage projection column is %s",
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
      /claims control-plane schema revision 27 but is missing .*usage_json/,
    );
  },
);
