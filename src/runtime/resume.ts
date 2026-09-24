import {
  describeFault,
  retryDisposition,
  type FaultDisposition,
  type WorkerFault,
} from "./fault.js";

/**
 * What one Agent's single run channel does about a failed attempt.
 *
 * Only a genuinely transient model failure — a provider timeout, rate limit or connection error —
 * is tried again by the runtime itself. The wait grows with every consecutive failure and stops
 * growing at a cap, so a short outage recovers quickly while a long one costs one attempt per
 * capped interval per Agent instead of a hot loop. The interval is computed from the attempt count
 * the database already holds, so a restart reproduces the same next attempt time rather than
 * restarting the interval, and a person's pause, stop or cancel is never undone by it.
 *
 * Every other failure keeps the disposition the shared fault definition decided, and a hold is what
 * pauses the Agent: the person who has to act can see it, and the work it depends on stays stopped
 * until they do. A stop that a person or this process already asked for adds no hold of its own —
 * the pause, the work stop or the shutdown that caused it is what governs that channel.
 */
const BASE_DELAY_MS = 1_000;
const CAP_DELAY_MS = 60_000;
/** Doubling past this exponent overflows the cap anyway; the clamp keeps the arithmetic finite. */
const MAX_EXPONENT = 32;

/** How long to wait before the next attempt after `attempt` consecutive transient failures. */
export function resumeDelayMs(attempt: number): number {
  const counted =
    Number.isSafeInteger(attempt) && attempt > 0 ? Math.min(attempt, MAX_EXPONENT) : 1;
  return Math.min(CAP_DELAY_MS, BASE_DELAY_MS * 2 ** (counted - 1));
}

/** A disposition only a person can release; `retry_backoff` is the one the runtime releases. */
export type HumanHold = Exclude<FaultDisposition, "retry_backoff">;

export type ResumeAction =
  /** Try the same delivery again, but not before `nextAt`. */
  | { kind: "retry"; attempt: number; nextAt: number; reason: string }
  /** Hold the channel, with the reason a person has to act on. The Agent stays paused. */
  | { kind: "hold"; hold: HumanHold; reason: string }
  /** Add nothing: the run stopped for a reason the pause, work stop or shutdown already governs. */
  | { kind: "none"; reason: string };

/**
 * The one decision about a failed attempt, taken from the shared fault category rather than from
 * error text. `previousAttempt` is the attempt count already persisted for this Agent; `now` is the
 * instant the attempt failed.
 */
export function resumeAction(
  fault: WorkerFault,
  previousAttempt: number,
  now: number,
): ResumeAction {
  const reason = describeFault(fault),
    disposition: FaultDisposition = retryDisposition(fault);
  if (disposition !== "retry_backoff") {
    // An aborted attempt is how a person's stop, a work stop, or this process shutting down reaches
    // the run module. Holding the channel for a human would make that stop permanent, so the
    // attempt simply ends and its delivery stays for the next run of the same channel.
    if (fault.category === "aborted") return { kind: "none", reason };
    return { kind: "hold", hold: disposition, reason };
  }
  const attempt =
    (Number.isSafeInteger(previousAttempt) && previousAttempt > 0 ? previousAttempt : 0) + 1;
  return { kind: "retry", attempt, nextAt: now + resumeDelayMs(attempt), reason };
}
