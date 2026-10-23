import type { DatabaseSync } from "node:sqlite";
import { openControlTables } from "@mate/control-store";
import { Migrations } from "@mate/migrations";

/**
 * The Web shell's own tables in the control store: who may log in and as what (`humans`), the hashes of live session
 * tokens (`sessions`), and the VAPID key pair that signs Web Push requests. `vapid_keys` holds at most one row.
 */
export function openShellTables(dataDirectory: string): DatabaseSync {
  return openControlTables(dataDirectory, {
    module: "shell",
    migrations: new Migrations([
      {
        version: 1,
        sql: `
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
      },
      {
        version: 2,
        sql: `
CREATE TABLE humans (
  external_id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
) STRICT;
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  external_id TEXT NOT NULL REFERENCES humans (external_id),
  expires_at INTEGER NOT NULL
) STRICT;
INSERT INTO humans (external_id, role, password_hash, active)
  SELECT 'owner', 'admin', hash, 1 FROM owner_password;
INSERT INTO sessions (token_hash, external_id, expires_at)
  SELECT token_hash, 'owner', expires_at FROM owner_sessions;
DROP TABLE owner_sessions;
DROP TABLE owner_password;
`,
      },
    ]),
  });
}
