import type { Clock } from "@palace/clock";

type Sleeper = { readonly at: number; readonly wake: () => void };

/** A clock that only moves when the test says so. */
export class FakeClock implements Clock {
  #now: number;
  #sleepers: Sleeper[] = [];
  #waiters: { readonly count: number; readonly resolve: () => void }[] = [];

  constructor(start = Date.UTC(2026, 0, 1, 9, 0, 0)) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  sleep(ms: number | undefined, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const wake = () => {
        this.#sleepers = this.#sleepers.filter((item) => item !== sleeper);
        signal.removeEventListener("abort", wake);
        resolve();
      };
      const sleeper = { at: ms === undefined ? Infinity : this.#now + Math.max(0, ms), wake };
      this.#sleepers.push(sleeper);
      signal.addEventListener("abort", wake, { once: true });
      this.#notify();
    });
  }

  /**
   * Resolve once at least `count` sleeps are pending: every timer loop of the code under test has come to rest. A test
   * that expects nothing to happen waits for this instead of for wall-clock time.
   */
  sleeping(count: number): Promise<void> {
    if (this.#sleepers.length >= count) return Promise.resolve();
    const waiter = Promise.withResolvers<void>();
    this.#waiters.push({ count, resolve: waiter.resolve });
    return waiter.promise;
  }

  #notify(): void {
    const due = this.#waiters.filter((waiter) => waiter.count <= this.#sleepers.length);
    this.#waiters = this.#waiters.filter((waiter) => !due.includes(waiter));
    for (const waiter of due) waiter.resolve();
  }

  /** Move time forward and wake every sleeper that is now due. */
  advance(ms: number): void {
    this.#now += ms;
    for (const sleeper of this.#sleepers.filter((each) => each.at <= this.#now)) sleeper.wake();
  }
}
