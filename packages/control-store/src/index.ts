import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/** The control store's file name inside the data directory. */
export const CONTROL_STORE_FILE = "control.sqlite";

/** One module's tables in the control store. */
export interface ControlTables {
  /** The module's key in the store's version table. It must never change once a store holds data. */
  module: string;
  version: number;
  /**
   * Creates the module's tables. It runs only when the store has no version for the module, so it uses plain
   * `CREATE TABLE`: a name some other module already took is refused instead of silently shared.
   */
  ddl: string;
}

/** Raised when the control store holds a module's tables at another schema version. Mate never migrates. */
export class ControlStoreIncompatible extends Error {
  readonly file: string;
  readonly module: string;

  constructor(file: string, tables: ControlTables, found: string, options?: ErrorOptions) {
    super(
      `control store ${file}: ${tables.module} tables ${found}, expected schema version ${tables.version}`,
      options,
    );
    this.name = "ControlStoreIncompatible";
    this.file = file;
    this.module = tables.module;
  }
}

/**
 * Long enough to outlast another process's commit (a backup, a `sqlite3` shell). Inside the control plane no
 * connection ever waits: `node:sqlite` is synchronous, so a transaction that never awaits ends before another
 * connection in the process can start one.
 */
const BUSY_TIMEOUT_MS = 5_000;

const Version = z.object({ version: z.number() }).optional();

/**
 * Open a connection of the calling module's own to the control store in `dataDirectory`, creating the module's tables
 * at their version on first use. Every module that keeps tables in the store opens it this way and closes only its own
 * connection. Throws `ControlStoreIncompatible` when the module's tables are at another version; other modules'
 * versions are never looked at.
 */
export function openControlTables(dataDirectory: string, tables: ControlTables): DatabaseSync {
  mkdirSync(dataDirectory, { recursive: true });
  const file = join(dataDirectory, CONTROL_STORE_FILE);
  const db = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS });
  try {
    // WAL lets one module read while another commits; FULL makes a commit survive power loss.
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    db.exec("BEGIN IMMEDIATE");
    try {
      ensureTables(db, file, tables);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function ensureTables(db: DatabaseSync, file: string, tables: ControlTables): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_versions (module TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT",
  );
  const found = Version.parse(
    db.prepare("SELECT version FROM schema_versions WHERE module = ?").get(tables.module),
  )?.version;
  if (found === tables.version) return;
  if (found !== undefined) {
    throw new ControlStoreIncompatible(file, tables, `are at schema version ${found}`);
  }
  try {
    db.exec(tables.ddl);
  } catch (error) {
    throw new ControlStoreIncompatible(file, tables, "could not be created", { cause: error });
  }
  db.prepare("INSERT INTO schema_versions (module, version) VALUES (?, ?)").run(
    tables.module,
    tables.version,
  );
}
