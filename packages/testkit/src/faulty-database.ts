import type {
  SqliteDatabase,
  SqliteExecutor,
  SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

type Statement = (sql: string, params: readonly SqliteValue[]) => boolean;

type Mode =
  | { readonly kind: "normal" }
  | { readonly kind: "frozen" }
  | { readonly kind: "failing"; remaining: number }
  | { readonly kind: "freezing"; readonly after: Statement; readonly frozen: () => void };

/**
 * Wraps the SQLite facade Durable writes through, so a test can stop the world at a chosen point.
 *
 * `freeze()` makes every later write hang forever, which is what a crashed process looks like to its storage: nothing
 * after that point is ever committed. A test then opens the same file again with a fresh runtime, exactly as a restart
 * would. `freezeAfter(statement)` freezes right after the first write holding a matching statement commits, so the
 * process dies between that commit and the next. `failNextWrites(n)` makes the next `n` writes (`exec`, `run`,
 * `transaction`) reject instead.
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

  /** Freeze once a write with a statement `after` matches has committed. Resolves when frozen. */
  freezeAfter(after: Statement): Promise<void> {
    const frozen = Promise.withResolvers<void>();
    this.#mode = { kind: "freezing", after, frozen: frozen.resolve };
    return frozen.promise;
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
    const mode = this.#mode;
    if (mode.kind !== "freezing") return this.#gate(() => this.#inner.transaction(callback));
    let matched = false;
    return this.#inner
      .transaction((inner) =>
        callback({
          exec: (sql) => inner.exec(sql),
          run: (sql, ...params) => {
            matched ||= mode.after(sql, params);
            return inner.run(sql, ...params);
          },
          get: (sql, ...params) => inner.get(sql, ...params),
          all: (sql, ...params) => inner.all(sql, ...params),
        }),
      )
      .then((result) => {
        if (matched && this.#mode === mode) {
          this.#mode = { kind: "frozen" };
          mode.frozen();
        }
        return result;
      });
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
