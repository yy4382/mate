import type {
  SqliteDatabase,
  SqliteExecutor,
  SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

/**
 * One open runtime's life. It ends either by `close()` or by a storage failure, and both abort everything that is in
 * flight: model requests, tool calls, waits. A failed runtime behaves like a crashed process: every later write is
 * refused, so Durable cannot advance past what was stored, and the Agent is reopened from its file.
 */
export class Lifetime {
  readonly #controller = new AbortController();
  readonly #failed = Promise.withResolvers<unknown>();
  #failure: { readonly error: unknown } | undefined;

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get failure(): { readonly error: unknown } | undefined {
    return this.#failure;
  }

  /** Resolves with the storage error if the runtime ever fails. */
  get failed(): Promise<unknown> {
    return this.#failed.promise;
  }

  end(): void {
    this.#controller.abort(new Error("Agent runtime closed"));
  }

  /** Record the first storage failure. Returns false when the runtime had already failed. */
  fail(error: unknown): boolean {
    if (this.#failure !== undefined) return false;
    this.#failure = { error };
    this.#controller.abort(error);
    this.#failed.resolve(error);
    return true;
  }
}

/**
 * Durable can report a failed storage operation without settling the work that issued it, and a Harness in that state
 * never finishes closing. So the first failed database operation kills the runtime outright, and every later operation
 * is refused, exactly as if the process had died at that point.
 */
export function guardDatabase(
  database: SqliteDatabase,
  lifetime: Lifetime,
  died: (error: unknown) => void,
): SqliteDatabase {
  const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
    const failure = lifetime.failure;
    if (failure !== undefined) throw failure.error;
    try {
      return await operation();
    } catch (error) {
      if (lifetime.fail(error)) died(error);
      throw error;
    }
  };
  return {
    exec: (sql: string) => guarded(() => database.exec(sql)),
    run: (sql: string, ...params: SqliteValue[]) => guarded(() => database.run(sql, ...params)),
    get: <T extends object>(sql: string, ...params: SqliteValue[]) =>
      guarded(() => database.get<T>(sql, ...params)),
    all: <T extends object>(sql: string, ...params: SqliteValue[]) =>
      guarded(() => database.all<T>(sql, ...params)),
    transaction: <T>(callback: (transaction: SqliteExecutor) => Promise<T>) =>
      guarded(() => database.transaction(callback)),
    close: () => database.close(),
  };
}
