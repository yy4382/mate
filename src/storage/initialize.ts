import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";

const CONTROL_PLANE_APPLICATION_ID = 0x4d43504c;
// Revision 29 moves the node's Linux account onto the node and drops the stored Agent readiness.
const CONTROL_PLANE_FORMAT_REVISION = 29;

const moveAside =
  "Mate does not migrate or erase a database it does not recognise: if this file was not created by this release, move it aside and point controlPlaneDataDir at a new, empty directory.";
const repair =
  "Refusing to modify it: restore the database from a checkpoint, or start with a new data directory.";

/** A file that is not this release's database format. The file is reported, never deleted. */
export class UnsupportedDatabaseError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "UnsupportedDatabaseError";
  }
}

/** Open a separate private node-side operation ledger through the storage boundary. */
export function openNodeProcessDatabase(path: string): Database.Database {
  const db = openWritable(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = DELETE");
  db.pragma("synchronous = FULL");
  return db;
}

/** Open the private control-plane database through the same writable SQLite boundary. */
export function openControlPlaneDatabase(path: string, schema: string): Database.Database {
  const empty = !existsSync(path) || statSync(path).size === 0,
    db = openWritable(path);
  try {
    if (empty) createControlPlaneFormat(db, path, schema);
    else acceptControlPlaneFormat(db, path, schema);
  } catch (error) {
    db.close();
    throw error;
  }
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  return db;
}

function createControlPlaneFormat(db: Database.Database, path: string, schema: string): void {
  try {
    db.transaction(() => {
      db.exec(schema);
      db.pragma(`application_id = ${CONTROL_PLANE_APPLICATION_ID}`);
      db.pragma(`user_version = ${CONTROL_PLANE_FORMAT_REVISION}`);
    }).immediate();
  } catch (error) {
    // Another startup may have created this database between the empty check and write.
    try {
      if (controlPlaneVerdict(db, schema).kind === "current") return;
    } catch {
      // Keep the original creation error when the competing database is unreadable.
    }
    throw error instanceof Error
      ? new Error(`Cannot initialize Mate control-plane database at ${path}: ${error.message}`)
      : error;
  }
}

function acceptControlPlaneFormat(db: Database.Database, path: string, schema: string): void {
  let found: Verdict;
  try {
    found = controlPlaneVerdict(db, schema);
  } catch (cause) {
    throw unreadable(path, cause);
  }
  switch (found.kind) {
    case "current":
      return;
    case "foreign":
      throw new UnsupportedDatabaseError(
        path,
        `${path} is not a Mate control-plane database (application id ${found.applicationId}, schema revision ${found.revision}). ${moveAside}`,
      );
    case "revision":
      throw new UnsupportedDatabaseError(
        path,
        `${path} uses control-plane schema revision ${found.revision}; this release uses revision ${CONTROL_PLANE_FORMAT_REVISION}. ${moveAside}`,
      );
    case "incomplete":
      throw new UnsupportedDatabaseError(
        path,
        `${path} claims control-plane schema revision ${CONTROL_PLANE_FORMAT_REVISION} but is missing ${found.missing.join(", ")}. ${repair}`,
      );
  }
}

function controlPlaneVerdict(db: Database.Database, schema: string): Verdict {
  const template = new Database(":memory:");
  try {
    template.exec(schema);
    const expected = databaseObjects(template);
    if (!expected.size) throw new Error("Control-plane schema declares no structures");
    const applicationId = Number(db.pragma("application_id", { simple: true })),
      revision = Number(db.pragma("user_version", { simple: true })),
      objects = databaseObjects(db);
    if (applicationId !== CONTROL_PLANE_APPLICATION_ID)
      return { kind: "foreign", applicationId, revision };
    if (revision !== CONTROL_PLANE_FORMAT_REVISION) return { kind: "revision", revision };
    const missing = [...expected]
      .filter((object) => !objects.has(object))
      .map((object) => object.replace(":", " "));
    const usageColumn = db
      .prepare(
        "SELECT hidden FROM pragma_table_xinfo('owner_agent_session_records') WHERE name='usage_json'",
      )
      .get() as { hidden: number } | undefined;
    // SQLite table_xinfo marks a STORED generated column with hidden=3.
    if (usageColumn?.hidden !== 3)
      missing.push("generated column owner_agent_session_records.usage_json");
    return missing.length ? { kind: "incomplete", missing } : { kind: "current" };
  } finally {
    template.close();
  }
}

function databaseObjects(db: Database.Database): Set<string> {
  const objects = db
    .prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all() as { type: string; name: string }[];
  return new Set(objects.map((row) => `${row.type}:${row.name}`));
}

function openWritable(path: string): Database.Database {
  let db: Database.Database;
  try {
    db = new Database(path);
  } catch (cause) {
    const { code, detail } = describe(cause);
    throw new Error(
      `Cannot open Mate database at ${path} (${code || "unknown error"}: ${detail}). Check that the directory exists and that the Mate user can read and write it, then start Mate again.`,
    );
  }
  // Wait for a competing writer before classifying, not only before writing.
  db.pragma("busy_timeout = 5000");
  return db;
}

type Verdict =
  | { kind: "current" }
  | { kind: "foreign"; applicationId: number; revision: number }
  | { kind: "revision"; revision: number }
  | { kind: "incomplete"; missing: string[] };

function describe(cause: unknown): { code: string; detail: string } {
  return {
    code: (cause as { code?: string } | null)?.code ?? "",
    detail: cause instanceof Error ? cause.message : String(cause),
  };
}

function unreadable(path: string, cause: unknown): UnsupportedDatabaseError {
  const { code, detail } = describe(cause);
  // "Cannot read this" and "this is not ours" need different next actions, and neither is "throw the file away".
  return code === "SQLITE_NOTADB"
    ? new UnsupportedDatabaseError(
        path,
        `${path} is not a SQLite database (${detail}). Mate does not modify or delete it: if it was not created by this release, move it aside or point runtime.dataDir at a new, empty directory.`,
      )
    : new UnsupportedDatabaseError(
        path,
        `${path} could not be read (${code || "unknown error"}: ${detail}). Mate does not delete it: check that the Mate user can read the file and that no other process holds it, then start Mate again.`,
      );
}
