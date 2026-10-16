import type { Clock } from "@mate/clock";

type Sleeper = { readonly at: number; readonly resolve: () => void };

/** A clock that only moves when the test says so. */
export class FakeClock implements Clock {
  #now: number;
  #sleepers: Sleeper[] = [];

  constructor(start = Date.UTC(2026, 0, 1, 9, 0, 0)) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const sleeper = { at: this.#now + Math.max(0, ms), resolve };
      this.#sleepers.push(sleeper);
      signal.addEventListener(
        "abort",
        () => {
          this.#sleepers = this.#sleepers.filter((item) => item !== sleeper);
          resolve();
        },
        { once: true },
      );
    });
  }

  /** Move time forward and wake every sleeper that is now due. */
  advance(ms: number): void {
    this.#now += ms;
    const due = this.#sleepers.filter((sleeper) => sleeper.at <= this.#now);
    this.#sleepers = this.#sleepers.filter((sleeper) => sleeper.at > this.#now);
    for (const sleeper of due) sleeper.resolve();
  }
}
