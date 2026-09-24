/**
 * Why one run of an Agent's single main channel stopped.
 *
 * These are the conditions that must stay separately recognizable, because each one has a
 * different next step. `turn_budget` and `external_wait` are both normal yields — the run gave up
 * its execution slot with work still outstanding — but they are not the same condition: one run
 * stopped because the model loop reached its own turn budget, and the other because a tool
 * deliberately released the slot to await something outside this Agent. A `model_failure` is a
 * fault the failure policy decides about; `interrupted` is a stop this process must never undo on
 * its own — either the owner's pause or the work item being stopped; `complete` means the delivery
 * this run carried is finished.
 *
 * The reason is recorded on the run row rather than only in memory, so a resumption and the
 * owner-facing views read the same fact the scheduler acted on. `Store.finish` maps each reason
 * to its persisted run state and delivery outcome; that mapping is the only place the scheduler's
 * decision is interpreted.
 */
export const runStopReasons = [
  "complete",
  "turn_budget",
  "external_wait",
  "model_failure",
  "owner_pause",
  "work_stopped",
  "interrupted",
] as const;
export type RunStopReason = (typeof runStopReasons)[number];

/** A yield: the run kept its unfinished delivery durable and the next run of this channel resumes it. */
export function isYield(reason: RunStopReason | null | undefined): boolean {
  return reason === "turn_budget" || reason === "external_wait";
}

/**
 * The persisted run state each reason ends in. This is the one place a stop reason is interpreted,
 * so a reason can never be stored next to a state that contradicts it: a failure is always
 * `failed`, an owner or work stop is always `interrupted`, and both kinds of yield are `yielded`.
 */
export const runStateForStopReason: Readonly<
  Record<RunStopReason, "complete" | "failed" | "interrupted" | "yielded">
> = Object.freeze({
  complete: "complete",
  turn_budget: "yielded",
  external_wait: "yielded",
  model_failure: "failed",
  owner_pause: "interrupted",
  work_stopped: "interrupted",
  interrupted: "interrupted",
});
