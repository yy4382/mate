import argon2 from "argon2";
import type Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { controlPlaneMigrations, controlPlaneSchema } from "./schema.js";
import { openControlPlaneDatabase } from "../storage/initialize.js";
import { assertNoRecoveryMarker } from "../deployment/coordinated-checkpoint.js";

export const OWNER_SESSION_COOKIE = "__Host-mate_session";
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const passwordHashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

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
    assertNoRecoveryMarker(options.dataDir);
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    if (!Number.isSafeInteger(this.sessionTtlMs) || this.sessionTtlMs < 1)
      throw new Error("Owner session lifetime must be positive");

    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(options.dataDir, 0o700);
    this.databasePath = join(resolve(options.dataDir), "control-plane.sqlite");
    this.db = openControlPlaneDatabase(
      this.databasePath,
      controlPlaneSchema,
      controlPlaneMigrations,
    );
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
  if (!file.isFile() || ((file.mode & 0o077) !== 0 && !isProtectedSystemdCredential(path, file)))
    throw new Error("Owner password file must be a regular file readable only by its owner");
  const contents = readFileSync(path, "utf8");
  return contents.replace(/\r?\n$/, "");
}

interface SystemdCredentialFileSystem {
  lstatSync(path: string): Stats;
  realpathSync(path: string): string;
  accessSync(path: string, mode: number): void;
}

interface SystemdCredentialCheckOptions {
  credentialDirectory?: string;
  fileSystem?: SystemdCredentialFileSystem;
}

const systemdCredentialFileSystem: SystemdCredentialFileSystem = {
  lstatSync: (path) => lstatSync(path),
  realpathSync: (path) => realpathSync(path),
  accessSync: (path, mode) => accessSync(path, mode),
};

export function isProtectedSystemdCredential(
  path: string,
  file: Stats,
  options: SystemdCredentialCheckOptions = {},
): boolean {
  const credentialDirectory = options.credentialDirectory ?? process.env.CREDENTIALS_DIRECTORY;
  if (!credentialDirectory || !isAbsolute(credentialDirectory)) return false;
  const fileSystem = options.fileSystem ?? systemdCredentialFileSystem;
  const directoryPath = resolve(credentialDirectory);
  const runtimeDirectory = "/run";
  const systemdCredentialRoot = join(runtimeDirectory, "credentials");
  const expectedDirectory = join(systemdCredentialRoot, "mate-control-plane.service");
  if (
    directoryPath !== expectedDirectory ||
    resolve(path) !== join(expectedDirectory, "owner-password")
  )
    return false;

  try {
    const runtime = fileSystem.lstatSync(runtimeDirectory);
    const credentialRoot = fileSystem.lstatSync(systemdCredentialRoot);
    const directory = fileSystem.lstatSync(directoryPath);
    if (
      !runtime.isDirectory() ||
      runtime.uid !== 0 ||
      runtime.gid !== 0 ||
      (runtime.mode & 0o022) !== 0 ||
      !credentialRoot.isDirectory() ||
      credentialRoot.uid !== 0 ||
      credentialRoot.gid !== 0 ||
      (credentialRoot.mode & 0o022) !== 0 ||
      !directory.isDirectory() ||
      !file.isFile() ||
      directory.uid !== 0 ||
      directory.gid !== 0 ||
      file.uid !== 0 ||
      file.gid !== 0 ||
      (directory.mode & 0o222) !== 0 ||
      (directory.mode & 0o007) !== 0 ||
      (file.mode & 0o7777) !== 0o440 ||
      fileSystem.realpathSync(runtimeDirectory) !== runtimeDirectory ||
      fileSystem.realpathSync(systemdCredentialRoot) !== systemdCredentialRoot ||
      fileSystem.realpathSync(directoryPath) !== directoryPath ||
      fileSystem.realpathSync(path) !== resolve(path)
    )
      return false;

    // systemd sets this directory for the unit's LoadCredential and keeps the
    // credential immutable for the service lifetime. Check the process ACL too:
    // the non-root service account must be able to read, but not replace, it.
    fileSystem.accessSync(runtimeDirectory, constants.R_OK | constants.X_OK);
    fileSystem.accessSync(systemdCredentialRoot, constants.R_OK | constants.X_OK);
    fileSystem.accessSync(directoryPath, constants.R_OK | constants.X_OK);
    fileSystem.accessSync(path, constants.R_OK);
    try {
      fileSystem.accessSync(runtimeDirectory, constants.W_OK);
      return false;
    } catch (error) {
      if (!isAccessDenied(error)) return false;
    }
    try {
      fileSystem.accessSync(systemdCredentialRoot, constants.W_OK);
      return false;
    } catch (error) {
      if (!isAccessDenied(error)) return false;
    }
    try {
      fileSystem.accessSync(directoryPath, constants.W_OK);
      return false;
    } catch (error) {
      if (!isAccessDenied(error)) return false;
    }
    try {
      fileSystem.accessSync(path, constants.W_OK);
      return false;
    } catch (error) {
      if (!isAccessDenied(error)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isAccessDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")
  );
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
