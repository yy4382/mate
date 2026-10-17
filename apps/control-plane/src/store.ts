import type { DatabaseSync } from "node:sqlite";
import { openControlTables } from "@mate/control-store";

/**
 * The Web shell's own tables in the control store: the owner's password hash, the hashes of live session tokens, and
 * the VAPID key pair that signs Web Push requests. The single-row tables hold at most one row each.
 */
export function openShellTables(dataDirectory: string): DatabaseSync {
  return openControlTables(dataDirectory, {
    module: "shell",
    version: 1,
    ddl: `
CREATE TABLE owner_password (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hash TEXT NOT NULL
) STRICT;
CREATE TABLE owner_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE vapid_keys (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL
) STRICT;
`,
  });
}
