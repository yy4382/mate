import type { Clock } from "@palace/clock";

type Sleeper = { readonly at: number; readonly wake: () => void };

/** A clock that only moves when the test says so. */
export class FakeClock implements Clock {
  #now: number;
  #sleepers: Sleeper[] = [];
  /** Sleeps that ended, by deadline or abort, with no new sleep since to show their loop came back to rest. */
  #awake = 0;
  #waiters: (() => void)[] = [];

  constructor(start = Date.UTC(2026, 0, 1, 9, 0, 0)) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  sleep(ms: number | undefined, signal: AbortSignal): Promise<void> {
    if (this.#awake > 0) this.#awake--;
    return new Promise((resolve) => {
      if (signal.aborted) {
        this.#awake++;
        return resolve();
      }
      const wake = () => {
        this.#sleepers = this.#sleepers.filter((item) => item !== sleeper);
        signal.removeEventListener("abort", wake);
        this.#awake++;
        resolve();
      };
      const sleeper = { at: ms === undefined ? Infinity : this.#now + Math.max(0, ms), wake };
      this.#sleepers.push(sleeper);
      signal.addEventListener("abort", wake, { once: true });
      this.#notify();
    });
  }

  /**
   * Resolve once a sleep is pending and every sleep that ended has been followed by a new one: each timer loop of the
   * code under test that the clock woke has come to rest again, however many loops there are. A test that expects
   * nothing to happen waits for this instead of for wall-clock time.
   */
  resting(): Promise<void> {
    if (this.#rested()) return Promise.resolve();
    const waiter = Promise.withResolvers<void>();
    this.#waiters.push(waiter.resolve);
    return waiter.promise;
  }

  #rested(): boolean {
    return this.#awake === 0 && this.#sleepers.length > 0;
  }

  #notify(): void {
    if (!this.#rested()) return;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Move time forward and wake every sleeper that is now due. */
  advance(ms: number): void {
    this.#now += ms;
    for (const sleeper of this.#sleepers.filter((each) => each.at <= this.#now)) sleeper.wake();
  }
}
