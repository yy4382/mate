import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Migrations } from "@mate/migrations";
import { z } from "zod";

/** The control store's file name inside the data directory. */
export const CONTROL_STORE_FILE = "control.sqlite";

/** One module's tables in the control store. */
export interface ControlTables {
  /** The module's key in the store's version table. It must never change once a store holds data. */
  module: string;
  /**
   * The module's schema. A store without the module runs the whole list and one at an earlier listed version runs the
   * rest. The first migration uses plain `CREATE TABLE`: a name some other module already took is refused instead of
   * silently shared.
   */
  migrations: Migrations;
}

/** Raised when the control store holds a module's tables at a version it cannot migrate from, or a migration fails. */
export class ControlStoreIncompatible extends Error {
  readonly file: string;
  readonly module: string;

  constructor(file: string, tables: ControlTables, found: string, options?: ErrorOptions) {
    super(
      `control store ${file}: ${tables.module} tables ${found}, expected schema version ${tables.migrations.latest}`,
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
 * Open a connection of the calling module's own to the control store in `dataDirectory`, bringing the module's tables
 * to their latest version, in one transaction, on first use or after an upgrade. Every module that keeps tables in the
 * store opens it this way and closes only its own connection. Throws `ControlStoreIncompatible` when the module's
 * tables are newer than its code or at an unlisted version, or when a migration fails (the store then stays at its old
 * version); other modules' versions are never looked at.
 */
export function openControlTables(dataDirectory: string, tables: ControlTables): DatabaseSync {
  mkdirSync(dataDirectory, { recursive: true });
  const file = join(dataDirectory, CONTROL_STORE_FILE);
  createPrivately(file);
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

/**
 * The store holds the owner's password hash, sessions and API keys, so only the account Mate runs as may read it.
 * The file is created empty with mode 0600 before SQLite opens it; SQLite gives its -wal and -shm files the main file's
 * mode.
 */
function createPrivately(file: string): void {
  try {
    writeFileSync(file, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
}

function ensureTables(db: DatabaseSync, file: string, tables: ControlTables): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_versions (module TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT",
  );
  const found = Version.parse(
    db.prepare("SELECT version FROM schema_versions WHERE module = ?").get(tables.module),
  )?.version;
  const pending = tables.migrations.after(found);
  if (pending === undefined) {
    throw new ControlStoreIncompatible(file, tables, `are at schema version ${found}`);
  }
  if (pending.length === 0) return;
  try {
    for (const migration of pending) db.exec(migration.sql);
  } catch (error) {
    throw new ControlStoreIncompatible(file, tables, "could not be migrated", { cause: error });
  }
  db.prepare(
    "INSERT INTO schema_versions (module, version) VALUES (?, ?) ON CONFLICT (module) DO UPDATE SET version = excluded.version",
  ).run(tables.module, tables.migrations.latest);
}
