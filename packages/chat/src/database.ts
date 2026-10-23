import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import type { Clock } from "@mate/clock";
import { z } from "zod";
import { CHAT_MIGRATIONS } from "./chat-migrations.ts";

/**
 * Raised when `chat.sqlite` is at a schema version the code cannot migrate from; it refuses to start and leaves the
 * file alone.
 */
export class ChatStoreIncompatible extends Error {
  readonly file: string;

  constructor(file: string, found: string) {
    super(`chat store ${file} has ${found}, expected schema version ${CHAT_MIGRATIONS.latest}`);
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
      this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      this.#migrate(file);
      this.#db.exec("PRAGMA foreign_keys=ON");
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  /** The time to stamp on a row written now. */
  now(): number {
    return this.#clock.now();
  }

  /**
   * Bring the schema to the latest version in one write transaction. Foreign keys stay off while it runs, because
   * SQLite cannot change that setting inside a transaction and a table rebuild needs it off. Before the commit,
   * `foreign_key_check` makes sure the migration left no dangling reference.
   */
  #migrate(file: string): void {
    this.#db.exec("PRAGMA foreign_keys=OFF");
    this.transaction("write", () => {
      const version = this.get(UserVersion, "PRAGMA user_version")?.user_version ?? 0;
      const tables =
        this.get(TableCount, "SELECT count(*) AS tables FROM sqlite_schema WHERE type = 'table'")
          ?.tables ?? 0;
      if (version === 0 && tables !== 0)
        throw new ChatStoreIncompatible(file, "unversioned tables");
      const pending = CHAT_MIGRATIONS.after(version === 0 ? undefined : version);
      if (pending === undefined) throw new ChatStoreIncompatible(file, `schema version ${version}`);
      if (pending.length === 0) return;
      for (const migration of pending) this.#db.exec(migration.sql);
      this.#db.exec(`PRAGMA user_version = ${CHAT_MIGRATIONS.latest}`);
      const dangling = this.all(z.unknown(), "PRAGMA foreign_key_check");
      if (dangling.length !== 0) {
        throw new Error(
          `chat store ${file}: migration left ${dangling.length} dangling references`,
        );
      }
    });
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
