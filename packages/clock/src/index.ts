/**
 * Time as every module sees it, so tests can move it forward instead of waiting. A timer is a `sleep` with its own
 * `AbortSignal`: aborting the signal cancels the timer, so there is no handle to keep and clear.
 */
export type Clock = {
  now(): number;
  /**
   * Resolve after `ms`, or as soon as `signal` aborts; at once if it already has. Without `ms`, resolve only when
   * `signal` aborts. Never rejects.
   */
  sleep(ms: number | undefined, signal: AbortSignal): Promise<void>;
};

/** The longest delay `setTimeout` takes; it fires a longer one after about 1ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export const systemClock: Clock = {
  now: () => Date.now(),
  async sleep(ms, signal) {
    if (ms === undefined) return untilAborted(undefined, signal);
    // A delay past the timer's limit is slept in pieces, each measured against the wall clock.
    const deadline = Date.now() + ms;
    for (let left = ms; left > 0 && !signal.aborted; left = deadline - Date.now()) {
      await untilAborted(Math.min(left, MAX_TIMER_MS), signal);
    }
  },
};

function untilAborted(ms: number | undefined, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = ms === undefined ? undefined : setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
