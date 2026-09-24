/**
 * Why one run of an Agent's single main channel stopped.
 *
 * These are the conditions that must stay separately recognizable, because each one has a
 * different next step. A `yielded` run gave up its execution slot with work still outstanding, so
 * its durable input waits for the next run of the same channel; a `model_failure` is a fault the
 * failure policy decides about; `interrupted` is a stop this process must never undo on its own —
 * either the owner's pause or the work item being stopped; `complete` means the delivery this run
 * carried is finished.
 *
 * The reason is recorded on the run row rather than only in memory, so a resumption and the
 * owner-facing views read the same fact the scheduler acted on. `Store.finish` maps each reason
 * to its persisted run state and delivery outcome; that mapping is the only place the scheduler's
 * decision is interpreted.
 */
export const runStopReasons = [
  "complete",
  "yielded",
  "model_failure",
  "owner_pause",
  "work_stopped",
  "interrupted",
] as const;
export type RunStopReason = (typeof runStopReasons)[number];
