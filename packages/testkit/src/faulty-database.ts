import type {
  SqliteDatabase,
  SqliteExecutor,
  SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

type Mode =
  | { readonly kind: "normal" }
  | { readonly kind: "frozen" }
  | { readonly kind: "failing"; remaining: number };

/**
 * Wraps the SQLite facade Durable writes through, so a test can stop the world at a chosen point.
 *
 * `freeze()` makes every later write hang forever, which is what a crashed process looks like to its storage: nothing
 * after that point is ever committed. A test then opens the same file again with a fresh runtime, exactly as a restart
 * would. `failNextWrites(n)` makes the next `n` writes (`exec`, `run`, `transaction`) reject instead.
 */
export class FaultyDatabase implements SqliteDatabase {
  #mode: Mode = { kind: "normal" };
  readonly #inner: SqliteDatabase;

  constructor(inner: SqliteDatabase) {
    this.#inner = inner;
  }

  get frozen(): boolean {
    return this.#mode.kind === "frozen";
  }

  freeze(): void {
    this.#mode = { kind: "frozen" };
  }

  failNextWrites(count: number): void {
    this.#mode = { kind: "failing", remaining: count };
  }

  exec(sql: string): Promise<void> {
    return this.#gate(() => this.#inner.exec(sql));
  }

  run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.#gate(() => this.#inner.run(sql, ...params));
  }

  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.#inner.get<T>(sql, ...params);
  }

  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.#inner.all<T>(sql, ...params);
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.#gate(() => this.#inner.transaction(callback));
  }

  close(): Promise<void> {
    return this.#mode.kind === "frozen" ? Promise.resolve() : this.#inner.close();
  }

  #gate<T>(operation: () => Promise<T>): Promise<T> {
    const mode = this.#mode;
    if (mode.kind === "frozen") return new Promise<T>(() => {});
    if (mode.kind === "failing") {
      mode.remaining -= 1;
      if (mode.remaining <= 0) this.#mode = { kind: "normal" };
      return Promise.reject(new Error("injected storage failure"));
    }
    return operation();
  }
}
