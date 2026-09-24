import type { ActivityItem, OperationsStatus } from "./view.js";
import {
  diagnosisNeeds,
  diagnosisSources,
  type DiagnosisNeed,
  type DiagnosisReport,
  type ServiceState,
} from "./diagnosis.js";
export type RecoveryState = {
  restore: null | { phase: string; databaseComplete: boolean; completedAgents: number };
  linuxUpgrade?: null | { phase: "pending" };
  invalid: boolean;
};
/** The needs a person has to act on; an automatic wait is not one of them. */
const humanNeeds = diagnosisNeeds.filter((need) => need !== "automatic_wait");
/** An allowlist projection, never a regex scrub of potentially confidential strings. */
export function diagnosticStatus(
  operations: OperationsStatus | null,
  service: ServiceState | null,
  recovery: RecoveryState,
  diagnosis: DiagnosisReport | null = operations?.diagnosis ?? null,
) {
  const invalid =
    recovery.invalid ||
    !!(recovery.restore && !["planned", "decided"].includes(recovery.restore.phase));
  const pending = !!(recovery.restore || recovery.linuxUpgrade);
  // Which of the owner's three readings each source reported, as counts only: this projection
  // still carries no identifier, reason or exception text.
  const conditions = diagnosis?.conditions ?? [],
    needs = Object.fromEntries(
      diagnosisNeeds.map((need) => [need, conditions.filter((item) => item.need === need).length]),
    ) as Record<DiagnosisNeed, number>,
    // A source that did not answer is not an all-clear: the report is incomplete, and only the
    // owner can decide what to do about that.
    unavailableSources = diagnosis
      ? diagnosisSources.filter((source) => diagnosis.sources[source] === "unavailable").length
      : 0;
  return {
    service,
    health: invalid
      ? "recovery-unreadable"
      : pending
        ? "recovery-pending"
        : // Nobody established whether the daemon runs, so no state can be reported for it.
          service === null
          ? "attention-required"
          : service !== "active"
            ? "service-not-active"
            : !operations
              ? "operations-unavailable"
              : operations.agents.some((a) => !a.registered || a.paused) ||
                  operations.uncertainActions.atLeast > 0 ||
                  operations.uncertainOutputs.atLeast > 0 ||
                  operations.uncertainSystemRequests.atLeast > 0 ||
                  humanNeeds.some((need) => needs[need] > 0) ||
                  unavailableSources > 0
                ? "attention-required"
                : "running",
    /** Automatic waits are the runtime's own work; the other three are a person's. */
    needs: {
      ...needs,
      awaitingPerson: humanNeeds.reduce((total, need) => total + needs[need], 0),
      unavailableSources,
    },
    recovery: invalid
      ? { invalid: true }
      : {
          restore: recovery.restore
            ? {
                phase: recovery.restore.phase,
                databaseComplete: recovery.restore.databaseComplete,
                completedAgents: recovery.restore.completedAgents,
              }
            : null,
          ...(recovery.linuxUpgrade ? { linuxUpgrade: recovery.linuxUpgrade } : {}),
        },
    operations: operations
      ? {
          agents: operations.agents.length,
          unregisteredAgents: operations.agents.filter((a) => !a.registered).length,
          pausedAgents: operations.agents.filter((a) => a.paused).length,
          activeRuns: operations.agents.filter((a) => a.activeRun).length,
          uncertainActions: operations.uncertainActions.atLeast,
          uncertainOutputs: operations.uncertainOutputs.atLeast,
          uncertainSystemRequests: operations.uncertainSystemRequests.atLeast,
          heldDrafts: operations.heldDrafts.atLeast,
          dueReminders: operations.dueReminders.atLeast,
          countsTruncated: [
            operations.uncertainActions,
            operations.uncertainOutputs,
            operations.uncertainSystemRequests,
            operations.heldDrafts,
            operations.dueReminders,
          ].some((p) => p.truncated),
        }
      : null,
  };
}
export const diagnosticLogLimit = 100;
export const diagnosticLogWindowMs = 24 * 60 * 60 * 1000;
/** Only runtime facts have a closed operational vocabulary. IDs, actor names and payloads never leave this boundary. */
export function diagnosticLogs(items: readonly ActivityItem[], now = Date.now()) {
  const kinds = [
    "runtime.run_completed",
    "runtime.run_failed",
    "runtime.run_yielded",
    "runtime.run_interrupted",
    "internal_dm.internal_dm_created",
  ];
  const eligible = items.filter(
    (i) =>
      ["runtime", "internal_dm"].includes(i.source) &&
      kinds.includes(i.kind) &&
      Number.isSafeInteger(i.at) &&
      i.at >= now - diagnosticLogWindowMs &&
      i.at <= now,
  );
  return {
    since: now - diagnosticLogWindowMs,
    until: now,
    limit: diagnosticLogLimit,
    events: eligible.slice(0, diagnosticLogLimit).map((i) => ({ at: i.at, event: i.kind })),
    content: "structured-operational-events-only" as const,
  };
}
