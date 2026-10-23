import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { ChatApp } from "@mate/chat";
import { AccountNames } from "@mate/chat";
import type { Clock } from "@mate/clock";
import { z } from "zod";
import { HttpError } from "./http.ts";

/** How long a session lasts from login. It is not extended by use. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** What a human may do: an admin manages Agents, providers, nodes and other humans; a member only chats. */
export const Role = z.enum(["admin", "member"]);
export type Role = z.output<typeof Role>;

/** The chat account the first human is created under. Fixed, so a start that crashed half way converges on restart. */
export const INITIAL_HUMAN = "human:initial";
/** The handle of the first human when `initialHandle` is not given. */
export const DEFAULT_INITIAL_HANDLE = "admin";
/** The shortest password a human may have, in bytes. */
export const MIN_PASSWORD_BYTES = 12;

/**
 * Password checks running at once. Each scrypt check takes tens of milliseconds and 32 MiB, so no more than this many
 * run together; the rest wait their turn in `CheckQueue`.
 */
const MAX_CONCURRENT_CHECKS = 2;
/** Checks waiting for a turn. Past this the login answers 429 at once: the process is being flooded. */
const MAX_WAITING_CHECKS = 64;
/** A check that has waited this long for a turn is not made: the login answers 429. */
const MAX_WAIT_MS = 10_000;

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } satisfies ScryptOptions;
const KEY_BYTES = 32;

/**
 * A hash of a password nobody knows. A login for a handle that names no active human still checks against it, so the
 * answer takes as long as for a real human with a wrong password.
 */
const DUMMY_HASH = "scrypt:oBhY8eRP_H3ga2dcBlNgWg:rxetZ-PjvJuN56wMI9S38L8O48JZC5HUUf4wKDaFUIo";

/** A logged-in human: the token the cookie carries, when it stops working, and who it is. */
export type Session = {
  readonly token: string;
  readonly expiresAt: number;
  /** The chat account's external ID the human is linked to. */
  readonly externalId: string;
  readonly role: Role;
};

/**
 * Admits password checks, at most `MAX_CONCURRENT_CHECKS` at a time, and hands turns to the waiting ones in arrival
 * order. There is no lockout and no per-client count, so repeated wrong passwords never keep a human out. The line is
 * bounded: enough concurrent clients to keep it full can still turn one attempt away with 429, which a retry gets past.
 */
class CheckQueue {
  readonly #clock: Clock;
  #running = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /**
   * Run `check` when it has a turn; `undefined` when the line is full or the wait ran out. A finished check hands its
   * turn straight to the first waiting one, so nobody arriving later can pass the line.
   */
  async run<T>(check: () => Promise<T>): Promise<T | undefined> {
    if (this.#running < MAX_CONCURRENT_CHECKS) this.#running++;
    else if (!(await this.#wait())) return undefined;
    try {
      return await check();
    } finally {
      const next = this.#waiting.shift();
      if (next === undefined) this.#running--;
      else next();
    }
  }

  /** Whether a turn came before the line was full or the deadline passed. */
  async #wait(): Promise<boolean> {
    if (this.#waiting.length >= MAX_WAITING_CHECKS) return false;
    const deadline = new AbortController();
    const turn = new Promise<boolean>((resolve) => {
      const wake = () => resolve(true);
      this.#waiting.push(wake);
      void this.#clock.sleep(MAX_WAIT_MS, deadline.signal).then(() => {
        const at = this.#waiting.indexOf(wake);
        if (at < 0) return;
        this.#waiting.splice(at, 1);
        resolve(false);
      });
    });
    const arrived = await turn;
    deadline.abort();
    return arrived;
  }
}

export type LoginResult =
  { status: "ok"; session: Session } | { status: "wrong" } | { status: "limited" };

/** A human as the shell knows them: the role and whether they may still log in. Names live in the chat account. */
export type HumanRecord = {
  readonly externalId: string;
  readonly role: Role;
  readonly active: boolean;
};

const HumanRow = z
  .object({ external_id: z.string(), role: Role, active: z.number() })
  .transform((row): HumanRecord => ({
    externalId: row.external_id,
    role: row.role,
    active: row.active === 1,
  }));
const SecretRow = z.object({ password_hash: z.string(), active: z.number(), role: Role });
const SessionRow = z.object({ expires_at: z.number(), external_id: z.string(), role: Role });
const CountRow = z.object({ n: z.number() });

/** A password as the API takes it: at least `MIN_PASSWORD_BYTES` bytes, at most 1024 characters. */
export const NewPassword = z
  .string()
  .max(1024)
  .refine((password) => Buffer.byteLength(password) >= MIN_PASSWORD_BYTES, {
    message: `a password is at least ${MIN_PASSWORD_BYTES} bytes`,
  });

/**
 * Who may log in and what they may do, and their sessions. Humans are keyed by the external ID of their chat account,
 * which owns their names. Only hashes are stored: an scrypt hash of each password, and a SHA-256 hash of each session
 * token, so reading the control store gives no way in. There is always at least one active admin.
 */
export class Humans {
  readonly #db: DatabaseSync;
  readonly #clock: Clock;
  readonly #checks: CheckQueue;

  constructor(db: DatabaseSync, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
    this.#checks = new CheckQueue(clock);
  }

  /** Whether no human has ever been added: the control plane is on its first start. */
  isEmpty(): boolean {
    return this.#count("SELECT COUNT(*) AS n FROM humans") === 0;
  }

  /** Every human, deactivated ones included. */
  list(): HumanRecord[] {
    return this.#db
      .prepare("SELECT external_id, role, active FROM humans ORDER BY rowid")
      .all()
      .map((row) => HumanRow.parse(row));
  }

  get(externalId: string): HumanRecord | undefined {
    const row = this.#db
      .prepare("SELECT external_id, role, active FROM humans WHERE external_id = ?")
      .get(externalId);
    return row === undefined ? undefined : HumanRow.parse(row);
  }

  /** Add the human for `externalId` unless there already is one. Repeating it changes nothing. */
  async add(externalId: string, role: Role, password: string): Promise<void> {
    const hash = await hashPassword(password);
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO humans (external_id, role, password_hash, active) VALUES (?, ?, ?, 1)",
      )
      .run(externalId, role, hash);
  }

  /**
   * Check the password of the human `externalId` and, if it is right, start a session. `undefined` for a handle that
   * names no active human: it is checked against a dummy hash all the same and answers like a wrong password. Checks
   * run two at a time, the rest in arrival order; `limited` is for a check that found the line full or waited too
   * long, and it was not made.
   */
  async logIn(externalId: string | undefined, password: string): Promise<LoginResult> {
    const secret = externalId === undefined ? undefined : this.#secret(externalId);
    const human = secret?.active === 1 ? secret : undefined;
    const right = await this.#checks.run(() =>
      verifyPassword(password, human?.password_hash ?? DUMMY_HASH),
    );
    if (right === undefined) return { status: "limited" };
    if (!right || human === undefined || externalId === undefined) return { status: "wrong" };
    const now = this.#clock.now();
    this.#db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + SESSION_TTL_MS;
    // The wait for a turn can outlast a password change, a role change or a deactivation, so the session is only
    // started for the human as they still are: active, with the very hash and role that were checked.
    const started = this.#db
      .prepare(
        `INSERT INTO sessions (token_hash, external_id, expires_at)
         SELECT ?, external_id, ? FROM humans
          WHERE external_id = ? AND active = 1 AND password_hash = ? AND role = ?`,
      )
      .run(hashToken(token), expiresAt, externalId, human.password_hash, human.role);
    if (started.changes === 0) return { status: "wrong" };
    return { status: "ok", session: { token, expiresAt, externalId, role: human.role } };
  }

  /** The live session `token` belongs to, if any, and only while its human is active. */
  session(token: string | undefined): Session | undefined {
    if (token === undefined) return undefined;
    const row = this.#db
      .prepare(
        `SELECT sessions.expires_at, sessions.external_id, humans.role
           FROM sessions JOIN humans ON humans.external_id = sessions.external_id
          WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND humans.active = 1`,
      )
      .get(hashToken(token), this.#clock.now());
    if (row === undefined) return undefined;
    const found = SessionRow.parse(row);
    return { token, expiresAt: found.expires_at, externalId: found.external_id, role: found.role };
  }

  /** End the session at once: the token stops working for every request and stream. */
  logOut(token: string): void {
    this.#db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  }

  /**
   * Change the human's own password after checking the current one. Their other sessions end; the one on `keepToken`
   * goes on. `limited` is for a check that found the line full or waited too long.
   */
  async changeOwnPassword(
    externalId: string,
    current: string,
    next: string,
    keepToken: string,
  ): Promise<"changed" | "wrong" | "limited"> {
    const stored = this.#secret(externalId);
    const right = await this.#checks.run(() =>
      verifyPassword(current, stored?.password_hash ?? DUMMY_HASH),
    );
    if (right === undefined) return "limited";
    if (!right || stored === undefined) return "wrong";
    await this.setPassword(externalId, next, keepToken);
    return "changed";
  }

  /** Replace the human's password and end their sessions, except the one on `keepToken`. */
  async setPassword(externalId: string, password: string, keepToken?: string): Promise<void> {
    this.#require(externalId);
    const hash = await hashPassword(password);
    this.#db
      .prepare("UPDATE humans SET password_hash = ? WHERE external_id = ?")
      .run(hash, externalId);
    this.#db
      .prepare("DELETE FROM sessions WHERE external_id = ? AND token_hash IS NOT ?")
      .run(externalId, keepToken === undefined ? null : hashToken(keepToken));
  }

  /**
   * A session is a snapshot of the human's access, so a changed role ends every session of theirs: they log in again
   * and get the new access, and what they had open (an admin stream) ends with it. Setting the role they already have
   * changes nothing. Refused with `last-admin` when it would leave no active admin.
   */
  setRole(externalId: string, role: Role): void {
    const human = this.#require(externalId);
    if (human.role === role) return;
    if (human.role === "admin" && human.active) this.#requireOtherAdmin(externalId);
    this.#db.prepare("UPDATE humans SET role = ? WHERE external_id = ?").run(role, externalId);
    this.#db.prepare("DELETE FROM sessions WHERE external_id = ?").run(externalId);
  }

  /**
   * The human can no longer log in, and every session of theirs ends. Permanent, like a chat account's deactivation.
   * Repeating it changes nothing. Refused with `last-admin` when they are the last active admin.
   */
  deactivate(externalId: string): void {
    const human = this.#require(externalId);
    if (!human.active) return;
    if (human.role === "admin") this.#requireOtherAdmin(externalId);
    this.#db.prepare("UPDATE humans SET active = 0 WHERE external_id = ?").run(externalId);
    this.#db.prepare("DELETE FROM sessions WHERE external_id = ?").run(externalId);
  }

  #requireOtherAdmin(externalId: string): void {
    const others = this.#count(
      "SELECT COUNT(*) AS n FROM humans WHERE role = 'admin' AND active = 1 AND external_id != ?",
      externalId,
    );
    if (others === 0)
      throw new HttpError(409, "last-admin", "there must always be one active admin");
  }

  #require(externalId: string): HumanRecord {
    const human = this.get(externalId);
    if (human === undefined) throw new HttpError(404, "unknown-account", "no such human");
    return human;
  }

  #secret(externalId: string): z.output<typeof SecretRow> | undefined {
    const row = this.#db
      .prepare("SELECT password_hash, active, role FROM humans WHERE external_id = ?")
      .get(externalId);
    return row === undefined ? undefined : SecretRow.parse(row);
  }

  #count(sql: string, ...parameters: string[]): number {
    return CountRow.parse(this.#db.prepare(sql).get(...parameters)).n;
  }
}

/**
 * On the first start, when there is no human yet, create the first one: an admin whose chat account has the handle
 * `initialHandle` (default `admin`) and whose password is read from `initialPasswordFile`. The chat account comes first
 * and both are keyed by `INITIAL_HUMAN`, so a start that stopped between the two finishes on the next one. After the
 * first human exists the file is never read again.
 */
export async function bootstrapHumans(
  humans: Humans,
  chat: ChatApp,
  options: { initialPasswordFile: string | undefined; initialHandle: string | undefined },
): Promise<void> {
  if (!humans.isEmpty()) return;
  const { initialPasswordFile } = options;
  if (initialPasswordFile === undefined)
    throw new Error("no human exists yet: give the initial password file on first start");
  const handle = AccountNames.shape.handle.safeParse(
    options.initialHandle ?? DEFAULT_INITIAL_HANDLE,
  );
  if (!handle.success)
    throw new Error(`the initial handle is not allowed: ${z.prettifyError(handle.error)}`);
  const password = readFileSync(initialPasswordFile, "utf8").replace(/\r?\n$/, "");
  if (Buffer.byteLength(password) < MIN_PASSWORD_BYTES)
    throw new Error(
      `the initial password in ${initialPasswordFile} is shorter than ${MIN_PASSWORD_BYTES} bytes`,
    );
  chat.ensureAccount({
    externalId: INITIAL_HUMAN,
    kind: "human",
    handle: handle.data,
    displayName: handle.data,
  });
  await humans.add(INITIAL_HUMAN, "admin", password);
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
