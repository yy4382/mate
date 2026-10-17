import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import type { Clock } from "@mate/clock";
import { z } from "zod";
import { CHAT_DDL, CHAT_SCHEMA_VERSION } from "./chat-ddl.ts";

/** Raised when `chat.sqlite` was written by another schema version. Mate never migrates; it refuses to start. */
export class ChatStoreIncompatible extends Error {
  readonly file: string;

  constructor(file: string, found: string) {
    super(`chat store ${file} has ${found}, expected schema version ${CHAT_SCHEMA_VERSION}`);
    this.name = "ChatStoreIncompatible";
    this.file = file;
  }
}

const UserVersion = z.object({ user_version: z.number() });
const TableCount = z.object({ tables: z.number() });

/**
 * The chat app's single SQLite connection. Every row read is parsed through a Zod schema, so code above this layer
 * works with typed values. WAL with `synchronous=FULL`: a committed message survives power loss, not only a crash.
 */
export class ChatDatabase {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  readonly #clock: Clock;

  constructor(file: string, clock: Clock) {
    this.#clock = clock;
    mkdirSync(dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    // The live-event triggers stamp their rows with this, so retention follows the injected clock.
    this.#db.function("chat_now", () => clock.now());
    try {
      this.#db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
      );
      this.transaction("write", () => this.#ensureSchema(file));
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  /** The time to stamp on a row written now. */
  now(): number {
    return this.#clock.now();
  }

  #ensureSchema(file: string): void {
    const version = this.get(UserVersion, "PRAGMA user_version")?.user_version ?? 0;
    if (version === CHAT_SCHEMA_VERSION) return;
    const tables =
      this.get(TableCount, "SELECT count(*) AS tables FROM sqlite_schema WHERE type = 'table'")
        ?.tables ?? 0;
    if (version !== 0) throw new ChatStoreIncompatible(file, `schema version ${version}`);
    if (tables !== 0) throw new ChatStoreIncompatible(file, "unversioned tables");
    this.#db.exec(CHAT_DDL);
    this.#db.exec(`PRAGMA user_version = ${CHAT_SCHEMA_VERSION}`);
  }

  #statement(sql: string): StatementSync {
    const cached = this.#statements.get(sql);
    if (cached !== undefined) return cached;
    const prepared = this.#db.prepare(sql);
    this.#statements.set(sql, prepared);
    return prepared;
  }

  all<S extends z.ZodType>(schema: S, sql: string, ...params: SQLInputValue[]): z.output<S>[] {
    return this.#statement(sql)
      .all(...params)
      .map((row) => schema.parse(row));
  }

  get<S extends z.ZodType>(
    schema: S,
    sql: string,
    ...params: SQLInputValue[]
  ): z.output<S> | undefined {
    const row = this.#statement(sql).get(...params);
    return row === undefined ? undefined : schema.parse(row);
  }

  /** Run a statement; returns how many rows it changed. */
  run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.#statement(sql).run(...params).changes);
  }

  /** Run a statement with named parameters (`@name` in the SQL). */
  runNamed(sql: string, params: Record<string, SQLInputValue>): void {
    this.#statement(sql).run(params);
  }

  /**
   * Run `work` as one transaction. Writes take the write lock up front (`BEGIN IMMEDIATE`), so a read inside the
   * transaction can never be invalidated by another writer before the write that depends on it.
   */
  transaction<T>(mode: "read" | "write", work: () => T): T {
    this.#db.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#statements.clear();
    this.#db.close();
  }
}

/** SQLite booleans arrive as 0 or 1. */
export const SqlBoolean = z.number().transform((value) => value === 1);

/** Pass a list of IDs to SQL as one parameter, read back with `json_each(?)`. */
export const idList = (ids: readonly number[]): string => JSON.stringify(ids);
