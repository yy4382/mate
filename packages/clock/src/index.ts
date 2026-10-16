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

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = ms === undefined ? undefined : setTimeout(done, Math.max(0, ms));
      signal.addEventListener("abort", done, { once: true });
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
    }),
};
