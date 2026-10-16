import type { Clock } from "@mate/clock";

type Sleeper = { readonly at: number; readonly wake: () => void };

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
    });
  }

  /** Move time forward and wake every sleeper that is now due. */
  advance(ms: number): void {
    this.#now += ms;
    for (const sleeper of this.#sleepers.filter((each) => each.at <= this.#now)) sleeper.wake();
  }
}
