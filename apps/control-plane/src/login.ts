import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "@mate/clock";
import { z } from "zod";

/** How long a session lasts from login. It is not extended by use. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Password checks running at once. Each scrypt check takes tens of milliseconds and 32 MiB, so an attacker hammering the
 * login is turned away with 429 instead of starving the process; there is no lockout, so the owner can always get in
 * once the burst passes.
 */
const MAX_CONCURRENT_CHECKS = 2;

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } satisfies ScryptOptions;
const KEY_BYTES = 32;

/** A logged-in owner: the token the cookie carries, and when it stops working. */
export type Session = { readonly token: string; readonly expiresAt: number };

export type LoginResult =
  { status: "ok"; session: Session } | { status: "wrong" } | { status: "limited" };

const PasswordRow = z.object({ hash: z.string() }).optional();
const SessionRow = z.object({ expires_at: z.number() }).optional();

/**
 * The single owner's password and sessions. Only hashes are stored: an scrypt hash of the password, and a SHA-256 hash
 * of each session token, so reading the control store gives no way in.
 */
export class OwnerLogin {
  readonly #db: DatabaseSync;
  readonly #clock: Clock;
  #checking = 0;

  private constructor(db: DatabaseSync, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  /**
   * The owner's login. On the first start, when no password is stored yet, the password is read from
   * `initialPasswordFile` and only its hash is kept; after that the file is never read again.
   */
  static async open(
    db: DatabaseSync,
    clock: Clock,
    initialPasswordFile: string | undefined,
  ): Promise<OwnerLogin> {
    if (storedHash(db) === undefined) {
      if (initialPasswordFile === undefined)
        throw new Error("no owner password is set: give the initial password file on first start");
      const password = readFileSync(initialPasswordFile, "utf8").replace(/\r?\n$/, "");
      if (Buffer.byteLength(password) < 12)
        throw new Error(`the initial password in ${initialPasswordFile} is shorter than 12 bytes`);
      db.prepare("INSERT INTO owner_password (id, hash) VALUES (1, ?)").run(
        await hashPassword(password),
      );
    }
    return new OwnerLogin(db, clock);
  }

  /** Check the password and, if it is right, start a session. Over the concurrency cap the check is not attempted. */
  async logIn(password: string): Promise<LoginResult> {
    if (this.#checking >= MAX_CONCURRENT_CHECKS) return { status: "limited" };
    this.#checking++;
    let right: boolean;
    try {
      right = await verifyPassword(password, storedHash(this.#db) ?? "");
    } finally {
      this.#checking--;
    }
    if (!right) return { status: "wrong" };
    const now = this.#clock.now();
    this.#db.prepare("DELETE FROM owner_sessions WHERE expires_at <= ?").run(now);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + SESSION_TTL_MS;
    this.#db
      .prepare("INSERT INTO owner_sessions (token_hash, expires_at) VALUES (?, ?)")
      .run(hashToken(token), expiresAt);
    return { status: "ok", session: { token, expiresAt } };
  }

  /** The live session `token` belongs to, if any. */
  session(token: string | undefined): Session | undefined {
    if (token === undefined) return undefined;
    const row = SessionRow.parse(
      this.#db
        .prepare("SELECT expires_at FROM owner_sessions WHERE token_hash = ? AND expires_at > ?")
        .get(hashToken(token), this.#clock.now()),
    );
    return row && { token, expiresAt: row.expires_at };
  }

  /** End the session at once: the token stops working for every request and stream. */
  logOut(token: string): void {
    this.#db.prepare("DELETE FROM owner_sessions WHERE token_hash = ?").run(hashToken(token));
  }
}

function storedHash(db: DatabaseSync): string | undefined {
  return PasswordRow.parse(db.prepare("SELECT hash FROM owner_password WHERE id = 1").get())?.hash;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEY_BYTES, SCRYPT, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt:${salt.toString("base64url")}:${key.toString("base64url")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, key] = stored.split(":");
  if (scheme !== "scrypt" || salt === undefined || key === undefined) return false;
  const expected = Buffer.from(key, "base64url");
  const actual = await derive(password, Buffer.from(salt, "base64url"));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
