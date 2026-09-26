import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import { FORMAT_APPLICATION_ID, FORMAT_REVISION, currentFormatSchema } from "./current-schema.js";

const CONTROL_PLANE_APPLICATION_ID = 0x4d43504c;
const CONTROL_PLANE_FORMAT_REVISION = 20;

const moveAside =
  "Mate does not migrate or erase a database it does not recognise: if this file was not created by this release, move it aside and point runtime.dataDir at a new, empty directory.";
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

/**
 * The one entry that opens the current-format database.
 *
 * A new file (absent, or zero bytes and therefore holding nothing) is created
 * with the single current schema in one transaction. An existing file is
 * accepted only when it carries this release's identity, its revision and every
 * structure the format declares; anything else - an older Mate database, a
 * database from another application, a corrupt or incomplete file - raises
 * {@link UnsupportedDatabaseError}. Structures an earlier build of this
 * revision left behind are inert: they are tolerated and left untouched, so
 * upgrading the program in place keeps every row of the same format.
 *
 * Opening a database that an interrupted writer left mid-transaction runs
 * SQLite's own recovery, so a rejected file can lose an uncommitted transaction
 * or leftover write-ahead files. Nothing else about it is rewritten: no table
 * is dropped, no committed row is touched, and no file is ever deleted, so
 * startup never clears a directory the operator may still want.
 */
export function openCurrentDatabase(path: string): Database.Database {
  const empty = !existsSync(path) || statSync(path).size === 0,
    db = openWritable(path);
  try {
    if (empty) createCurrentFormat(db, path);
    else accept(db, path);
  } catch (error) {
    db.close();
    throw error;
  }
  // Constraints only apply per connection, so the entry that opens the file owns them.
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  return db;
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
export interface ControlPlaneFormatMigration {
  fromRevision: number;
  toRevision: number;
  previousSchema: string;
  nextSchema: string;
  migrationSchema: string;
}

export function openControlPlaneDatabase(
  path: string,
  schema: string,
  migrations: readonly ControlPlaneFormatMigration[] = [],
): Database.Database {
  const empty = !existsSync(path) || statSync(path).size === 0,
    db = openWritable(path);
  try {
    if (empty) createControlPlaneFormat(db, path, schema);
    else acceptControlPlaneFormat(db, path, schema, migrations);
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

function acceptControlPlaneFormat(
  db: Database.Database,
  path: string,
  schema: string,
  migrations: readonly ControlPlaneFormatMigration[],
): void {
  let found: Verdict;
  try {
    found = controlPlaneVerdict(db, schema);
  } catch (cause) {
    throw unreadable(path, cause);
  }
  while (found.kind === "revision") {
    const revision = found.revision,
      migration = migrations.find((candidate) => candidate.fromRevision === revision);
    if (!migration) break;
    migrateControlPlaneFormat(db, path, migration);
    found = controlPlaneVerdict(db, schema);
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

function migrateControlPlaneFormat(
  db: Database.Database,
  path: string,
  migration: ControlPlaneFormatMigration,
): void {
  if (migration.fromRevision + 1 !== migration.toRevision)
    throw new Error("Control-plane format migrations must advance exactly one revision");

  const previousTemplate = new Database(":memory:");
  let previousObjects: Set<string>;
  try {
    previousTemplate.exec(migration.previousSchema);
    previousObjects = databaseObjects(previousTemplate);
  } finally {
    previousTemplate.close();
  }

  const objects = databaseObjects(db),
    missing = [...previousObjects].filter((object) => !objects.has(object));
  if (missing.length) {
    throw new UnsupportedDatabaseError(
      path,
      `${path} claims control-plane schema revision ${migration.fromRevision} but is missing ${missing.map((object) => object.replace(":", " ")).join(", ")}. ${repair}`,
    );
  }

  const currentTemplate = new Database(":memory:");
  let additions: string[];
  try {
    currentTemplate.exec(migration.nextSchema);
    additions = [...databaseObjects(currentTemplate)].filter(
      (object) => !previousObjects.has(object),
    );
  } finally {
    currentTemplate.close();
  }
  if (additions.some((object) => objects.has(object))) {
    throw new UnsupportedDatabaseError(
      path,
      `${path} contains current-format structures with schema revision ${migration.fromRevision}. ${repair}`,
    );
  }

  try {
    db.transaction(() => {
      db.exec(migration.migrationSchema);
      db.pragma(`user_version = ${migration.toRevision}`);
    }).immediate();
  } catch (cause) {
    throw new Error(
      `Cannot upgrade Mate control-plane database at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
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

function createCurrentFormat(db: Database.Database, path: string): void {
  try {
    db.transaction(() => db.exec(currentFormatSchema)).immediate();
  } catch (error) {
    // A second entry may classify the same new file at the same time; the loser
    // accepts the database the winner created instead of reporting a collision.
    try {
      if (verdict(db, formatObjects()).kind === "current") return;
    } catch {
      // An unreadable file keeps its own, more useful, error below.
    }
    throw error;
  }
}

function accept(db: Database.Database, path: string): void {
  // The expected structures come from the schema itself: a failure to build that
  // list is this program's bug, not a fact about the operator's file.
  const expected = formatObjects();
  let found: Verdict;
  try {
    found = verdict(db, expected);
  } catch (cause) {
    throw unreadable(path, cause);
  }
  switch (found.kind) {
    case "current":
      return;
    case "foreign":
      throw new UnsupportedDatabaseError(
        path,
        `${path} is not a Mate first-release database (application id ${found.applicationId}, schema revision ${found.revision}). ${moveAside}`,
      );
    case "revision":
      throw new UnsupportedDatabaseError(
        path,
        `${path} uses Mate schema revision ${found.revision}; this release uses revision ${FORMAT_REVISION}. ${moveAside}`,
      );
    case "incomplete":
      throw new UnsupportedDatabaseError(
        path,
        `${path} claims Mate schema revision ${FORMAT_REVISION} but is missing ${found.missing.join(", ")}. ${repair}`,
      );
  }
}

type Verdict =
  | { kind: "current" }
  | { kind: "foreign"; applicationId: number; revision: number }
  | { kind: "revision"; revision: number }
  | { kind: "incomplete"; missing: string[] };

function verdict(db: Database.Database, expected: Set<string>): Verdict {
  const applicationId = Number(db.pragma("application_id", { simple: true })),
    revision = Number(db.pragma("user_version", { simple: true })),
    objects = new Set(
      (
        db.prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as {
          type: string;
          name: string;
        }[]
      ).map((row) => `${row.type}:${row.name}`),
    );
  if (applicationId !== FORMAT_APPLICATION_ID) return { kind: "foreign", applicationId, revision };
  if (revision !== FORMAT_REVISION) return { kind: "revision", revision };
  // The revision identifies the format; this check catches a file that claims the
  // revision but lost structures (uniqueness indexes and triggers carry invariants).
  const missing = [...expected]
    .filter((object) => !objects.has(object))
    .map((object) => object.replace(":", " "));
  return missing.length ? { kind: "incomplete", missing } : { kind: "current" };
}

/** Structure names of the current format, read from a database the format itself created. */
let formatStructure: Set<string> | undefined;
function formatObjects(): Set<string> {
  if (formatStructure) return formatStructure;
  const template = new Database(":memory:");
  try {
    template.exec(currentFormatSchema);
    const objects = template
      .prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all() as { type: string; name: string }[];
    if (!objects.length) throw new Error("Current format declares no structures");
    return (formatStructure = new Set(objects.map((row) => `${row.type}:${row.name}`)));
  } finally {
    template.close();
  }
}

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
