import argon2 from "argon2";
import type Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { openControlPlaneDatabase } from "../storage/initialize.js";

export const OWNER_SESSION_COOKIE = "__Host-mate_session";
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const passwordHashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

const schema = `
CREATE TABLE IF NOT EXISTS owner_credentials (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  password_hash TEXT NOT NULL CHECK(password_hash LIKE '$argon2id$%'),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_sessions (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK(expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS owner_sessions_expiry ON owner_sessions(expires_at);

CREATE TABLE owner_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('public','private')),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX owner_channels_order ON owner_channels(archived,created_at,id);
-- Membership writers and message delivery snapshotting share this transactional fact table.
CREATE TABLE owner_channel_memberships (
  channel_id TEXT NOT NULL REFERENCES owner_channels(id),
  principal_kind TEXT NOT NULL CHECK(principal_kind IN ('human','agent')),
  principal_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(channel_id,principal_kind,principal_id)
);
CREATE INDEX owner_channel_memberships_active ON owner_channel_memberships(channel_id,active,principal_kind,principal_id);
CREATE TABLE owner_messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES owner_channels(id),
  order_seq INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(channel_id,order_seq)
);
CREATE INDEX owner_messages_channel_order ON owner_messages(channel_id,order_seq);
CREATE TABLE owner_message_deliveries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL REFERENCES owner_messages(id),
  channel_id TEXT NOT NULL,
  recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('human','agent')),
  recipient_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','handled')),
  created_at INTEGER NOT NULL,
  handled_at INTEGER,
  UNIQUE(message_id,recipient_kind,recipient_id),
  FOREIGN KEY(channel_id,recipient_kind,recipient_id)
    REFERENCES owner_channel_memberships(channel_id,principal_kind,principal_id)
);
CREATE INDEX owner_message_deliveries_pending ON owner_message_deliveries(recipient_kind,recipient_id,state,seq);
CREATE TABLE owner_chat_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES owner_channels(id),
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export interface OwnerAuthOptions {
  dataDir: string;
  passwordFile?: string;
  now?: () => number;
  sessionTtlMs?: number;
}

interface Session {
  token: string;
  expiresAt: number;
  maxAgeSeconds: number;
}

/** Password and session persistence for the single owner of this Mate control plane. */
export class OwnerAuth {
  readonly databasePath: string;
  readonly db: Database.Database;
  private readonly now: () => number;
  private readonly sessionTtlMs: number;
  private initialization: Promise<string | null> | undefined;

  constructor(private readonly options: OwnerAuthOptions) {
    if (!isAbsolute(options.dataDir))
      throw new Error("MATE_CONTROL_PLANE_DATA_DIR must be an absolute path");
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    if (!Number.isSafeInteger(this.sessionTtlMs) || this.sessionTtlMs < 1)
      throw new Error("Owner session lifetime must be positive");

    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(options.dataDir, 0o700);
    this.databasePath = join(resolve(options.dataDir), "control-plane.sqlite");
    this.db = openControlPlaneDatabase(this.databasePath, schema);
    chmodSync(this.databasePath, 0o600);
  }

  /** Provision once from a protected file. Once the hash exists, the file is no longer needed. */
  async passwordHash(): Promise<string | null> {
    const stored = this.readPasswordHash();
    if (stored) return stored.password_hash;
    if (!this.options.passwordFile) return null;

    this.initialization ??= this.initializePassword();
    try {
      return await this.initialization;
    } finally {
      this.initialization = undefined;
    }
  }

  async verifyPassword(password: string): Promise<"unconfigured" | "valid" | "invalid"> {
    const storedHash = await this.passwordHash();
    if (!storedHash) return "unconfigured";
    return (await argon2.verify(storedHash, password)) ? "valid" : "invalid";
  }

  createSession(): Session {
    const now = this.now();
    this.deleteExpiredSessions(now);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + this.sessionTtlMs;
    this.db
      .prepare("INSERT INTO owner_sessions(token_hash,created_at,expires_at) VALUES(?,?,?)")
      .run(hashToken(token), now, expiresAt);
    return { token, expiresAt, maxAgeSeconds: Math.ceil(this.sessionTtlMs / 1000) };
  }

  hasSession(token: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS valid FROM owner_sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?",
      )
      .get(hashToken(token), this.now());
    return row !== undefined;
  }

  revokeSession(token: string): void {
    // A missing token hash is denied by hasSession just like a revoked row.
    this.db.prepare("DELETE FROM owner_sessions WHERE token_hash=?").run(hashToken(token));
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  private readPasswordHash(): { password_hash: string } | undefined {
    return this.db.prepare("SELECT password_hash FROM owner_credentials WHERE id=1").get() as
      { password_hash: string } | undefined;
  }

  private deleteExpiredSessions(now: number): void {
    this.db
      .prepare(
        "DELETE FROM owner_sessions WHERE token_hash IN (SELECT token_hash FROM owner_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)",
      )
      .run(now);
  }

  private async initializePassword(): Promise<string | null> {
    // Another request or process may have completed setup while this request was hashing.
    const existing = this.readPasswordHash();
    if (existing) return existing.password_hash;

    let password: string;
    try {
      password = readInitialPassword(this.options.passwordFile!);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (Buffer.byteLength(password, "utf8") < 12 || Buffer.byteLength(password, "utf8") > 1024)
      throw new Error("Owner password file must contain between 12 and 1024 UTF-8 bytes");

    const passwordHash = await argon2.hash(password, passwordHashOptions);
    this.db
      .prepare("INSERT OR IGNORE INTO owner_credentials(id,password_hash,created_at) VALUES(1,?,?)")
      .run(passwordHash, this.now());
    return this.readPasswordHash()?.password_hash ?? null;
  }
}

function readInitialPassword(path: string): string {
  if (!isAbsolute(path)) throw new Error("MATE_OWNER_PASSWORD_FILE must be an absolute path");
  const file = lstatSync(path);
  if (!file.isFile() || (file.mode & 0o077) !== 0)
    throw new Error("Owner password file must be a regular file readable only by its owner");
  const contents = readFileSync(path, "utf8");
  return contents.replace(/\r?\n$/, "");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
