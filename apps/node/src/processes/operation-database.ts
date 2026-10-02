import { systemErrorCode } from "../system-error.js";
import Database from "better-sqlite3";

/** Open the node's durable operation ledger without changing its existing format. */
export function openNodeProcessDatabase(path: string): Database.Database {
  let db: Database.Database;
  try {
    db = new Database(path);
  } catch (cause) {
    const code = systemErrorCode(cause) ?? "",
      detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Cannot open Mate database at ${path} (${code || "unknown error"}: ${detail}). Check that the directory exists and that the Mate user can read and write it, then start Mate again.`,
    );
  }
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = DELETE");
  db.pragma("synchronous = FULL");
  return db;
}
