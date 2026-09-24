import Database from "better-sqlite3";
import {
  FORMAT_APPLICATION_ID,
  FORMAT_REVISION,
  currentFormatIndexes,
  currentFormatSchema,
  currentFormatTables,
  currentFormatTriggers,
} from "./current-schema.js";

const nextAction =
  "Mate does not migrate earlier databases: point runtime.dataDir at a new, empty directory, or move this file aside and let Mate create a fresh one.";

/** A file that is not this release's database format. The file is reported, never modified or removed. */
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
 * A new file is created with the single current schema in one transaction. An
 * existing file is accepted only when it is this release's format and complete;
 * anything else (an older Mate database, a database from another application, a
 * corrupt file) raises {@link UnsupportedDatabaseError} and is left exactly as
 * found, so startup never discards a directory the operator may still want.
 */
export function openCurrentDatabase(path: string): Database.Database {
  let db: Database.Database;
  try {
    db = new Database(path);
  } catch (cause) {
    throw new Error(
      `Cannot open Mate database at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  try {
    if (inspect(db, path) === "empty")
      db.transaction(() => db.exec(currentFormatSchema)).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  // Constraints only apply per connection, so the entry that opens the file owns them.
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("busy_timeout = 5000");
  return db;
}

/** Classifies the file before anything is written to it. */
function inspect(db: Database.Database, path: string): "empty" | "current" {
  let applicationId: number, revision: number, objects: Set<string>;
  try {
    applicationId = Number(db.pragma("application_id", { simple: true }));
    revision = Number(db.pragma("user_version", { simple: true }));
    objects = new Set(
      (
        db.prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as {
          type: string;
          name: string;
        }[]
      ).map((row) => `${row.type}:${row.name}`),
    );
  } catch (cause) {
    throw new UnsupportedDatabaseError(
      path,
      `${path} cannot be read as a SQLite database (${cause instanceof Error ? cause.message : String(cause)}). ${nextAction}`,
    );
  }
  if (applicationId === 0 && revision === 0 && objects.size === 0) return "empty";
  if (applicationId !== FORMAT_APPLICATION_ID)
    throw new UnsupportedDatabaseError(
      path,
      `${path} is not a Mate first-release database (application id ${applicationId}, schema revision ${revision}). ${nextAction}`,
    );
  if (revision !== FORMAT_REVISION)
    throw new UnsupportedDatabaseError(
      path,
      `${path} uses Mate schema revision ${revision}; this release uses revision ${FORMAT_REVISION}. ${nextAction}`,
    );
  // Uniqueness indexes and triggers carry invariants, so a partial file is not accepted as current.
  const missing = (
    [
      ["table", currentFormatTables],
      ["index", currentFormatIndexes],
      ["trigger", currentFormatTriggers],
    ] as const
  )
    .flatMap(([type, names]) => names.map((name) => ({ type, name })))
    .filter(({ type, name }) => !objects.has(`${type}:${name}`))
    .map(({ type, name }) => `${type} ${name}`);
  if (missing.length)
    throw new UnsupportedDatabaseError(
      path,
      `${path} claims Mate schema revision ${FORMAT_REVISION} but is missing ${missing.join(", ")}. Refusing to modify it: restore the database from a checkpoint, or start with a new data directory.`,
    );
  return "current";
}
