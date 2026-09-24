import {
  filterReason,
  workerFaultSchema,
  type FaultDisposition,
  type FaultStage,
  type WorkerFault,
} from "../runtime/fault.js";
import type { SlackInstallationReadiness, SlackReadiness } from "../slack/readiness.js";

/**
 * The scoped, actionable fault diagnosis an owner reads.
 *
 * Every entry names the one thing it is about — an Agent's run channel, one Slack installation or
 * target, one recorded operation — because "something failed" is not actionable. The vocabulary is
 * deliberately small: the shared retry disposition from the worker boundary is the only source of
 * the classification, and this module is the single place it becomes the owner's words.
 *
 * The diagnosis is a view over durable state. Nothing here writes, and nothing here is cached in
 * memory, so a restart reproduces the same answer from the same records.
 */

/** The daemon-process fact, reported apart from every other fact about the deployment. */
export type ServiceState =
  "active" | "inactive" | "activating" | "deactivating" | "failed" | "reloading" | "unknown";

/**
 * What an owner has to do about one condition. `automatic_wait` is the only one nobody acts on:
 * the runtime retries it by itself at the stated instant.
 */
export type DiagnosisNeed =
  "automatic_wait" | "configuration_fix" | "verify_unknown_effect" | "failure_review";

/**
 * The owner's readings, in the order they matter: an unresolved external effect first, because it
 * cannot be repeated, and an automatic wait last, because nobody has to act on it.
 */
export const diagnosisNeeds = [
  "verify_unknown_effect",
  "configuration_fix",
  "failure_review",
  "automatic_wait",
] as const;

/**
 * The one place the shared retry disposition becomes the owner's words. Classification, the next
 * action and the statement used when no fault was recorded live in one row per disposition, so a
 * disposition cannot get a need without the action and the wording that belong to it.
 */
const ownerReadings: Record<
  FaultDisposition,
  { need: DiagnosisNeed; action: string | null; statement: string }
> = {
  retry_backoff: {
    need: "automatic_wait",
    action: null,
    statement: "The last attempt failed transiently; the next attempt is scheduled",
  },
  human_action: {
    need: "configuration_fix",
    action: "Fix this Agent's model credential or configuration, then agent-resume it.",
    statement: "The Agent is held after a credential or configuration failure",
  },
  verify_effect: {
    need: "verify_unknown_effect",
    action:
      "This Agent stopped with an unresolved execution result; check its activity, then agent-resume it.",
    statement: "The Agent stopped with an unresolved external execution result",
  },
  no_retry: {
    need: "failure_review",
    action:
      "This Agent stopped after a failure that is not safe to retry; check its activity, then agent-resume it once the cause is resolved.",
    statement: "The Agent stopped after a failure that is not safe to retry",
  },
};

/** The owner's classification of one disposition. */
export function diagnosisNeed(disposition: FaultDisposition): DiagnosisNeed {
  return ownerReadings[disposition].need;
}

/**
 * Which Agent, connection, target, operation or process a condition is about. A condition without
 * its scope cannot be acted on, so the scope is part of the entry rather than of its rendering.
 */
export type DiagnosisScope =
  | { kind: "daemon" }
  | { kind: "agent"; agentId: string }
  | { kind: "slack_installation"; agentId: string }
  | { kind: "slack_target"; agentId: string; channel: string; conversationId: string }
  | { kind: "action"; agentId: string; actionId: string; runId: string }
  | { kind: "output"; agentId: string; outputId: string }
  | { kind: "system_request"; agentId: string; requestId: string };

export const diagnosisSources = ["daemon", "slack", "agents", "execution"] as const;
export type DiagnosisSource = (typeof diagnosisSources)[number];
/** Whether one source answered. `unavailable` is a failure of that source alone. */
export type SourceReading = "read" | "unavailable";

export interface DiagnosisCondition {
  source: DiagnosisSource;
  scope: DiagnosisScope;
  /**
   * The boundary that raised it: the stage of the recorded fault, or the stage whose external
   * effect is unresolved. `null` when the condition is not a worker-boundary fault.
   */
  stage: FaultStage | null;
  need: DiagnosisNeed;
  /** Short, filtered statement of the condition — never an exception text, SQL, credential or memory body. */
  reason: string;
  /** The next step a person can take, or `null` when the runtime handles it by itself. */
  action: string | null;
  /** When the scheduled automatic attempt is due; `null` when nothing is scheduled. */
  nextAttemptAt: number | null;
}

export interface DiagnosisReport {
  at: number;
  /** Whether each source answered. A failed source is named here and hides no other source. */
  sources: Record<DiagnosisSource, SourceReading>;
  /** The daemon-process fact, or `null` when the source that states it did not answer. */
  daemon: ServiceState | null;
  /** Slack readiness per installation and target, or `null` when that source did not answer. */
  slack: SlackReadiness | null;
  /** Scoped, actionable conditions; the ones a person must act on come first. */
  conditions: DiagnosisCondition[];
}

/** The facts one source contributes once it has answered. */
export interface DiagnosisReadings {
  daemon: ServiceState | null;
  slack: SlackReadiness | null;
  agents: DiagnosisCondition[];
  execution: DiagnosisCondition[];
}

/**
 * Read every source in its own attempt. A source that throws is recorded as unavailable and
 * contributes nothing, so one failing probe never erases another source's result. The failure
 * itself stays opaque: an exception can carry paths, SQL, credentials or private memory.
 */
export function collectDiagnosis(
  readings: { [K in DiagnosisSource]: () => DiagnosisReadings[K] },
  at = Date.now(),
): DiagnosisReport {
  const sources = {} as Record<DiagnosisSource, SourceReading>;
  const read = <K extends DiagnosisSource>(source: K, fallback: DiagnosisReadings[K]) => {
    try {
      const value = readings[source]();
      sources[source] = "read";
      return value;
    } catch {
      sources[source] = "unavailable";
      return fallback;
    }
  };
  const daemon = read("daemon", null),
    slack = read("slack", null),
    agents = read("agents", [] as DiagnosisCondition[]),
    execution = read("execution", [] as DiagnosisCondition[]);
  return {
    at,
    sources,
    daemon,
    slack,
    // The daemon and Slack facts are classified here too, so every report an owner reads is
    // complete and no caller can omit a source's conditions.
    conditions: orderConditions([
      ...daemonConditions(daemon),
      ...slackConditions(slack),
      ...agents,
      ...execution,
    ]),
  };
}

/** A person's work comes before an automatic wait, and a stable scope keeps the order readable. */
function orderConditions(conditions: readonly DiagnosisCondition[]): DiagnosisCondition[] {
  return [...conditions].sort(compareConditions);
}

/**
 * One Agent's durable recovery state: the disposition its channel is held by, the filtered fault
 * the failed attempt was recorded with, and the instant the next automatic attempt is due.
 */
export interface AgentDiagnosisInput {
  agentId: string;
  hold: FaultDisposition | null;
  fault: WorkerFault | null;
  nextAttemptAt: number;
}

/** The scoped condition of every Agent whose channel is waiting or held, and nothing else. */
export function agentConditions(agents: readonly AgentDiagnosisInput[]): DiagnosisCondition[] {
  return agents.flatMap((agent) =>
    agent.hold
      ? [
          {
            source: "agents" as const,
            scope: { kind: "agent" as const, agentId: agent.agentId },
            stage: agent.fault?.stage ?? null,
            need: diagnosisNeed(agent.hold),
            reason: ownerReason(agent.fault, agent.hold),
            action: resumeInstruction(agent.hold),
            nextAttemptAt: agent.hold === "retry_backoff" ? agent.nextAttemptAt || null : null,
          },
        ]
      : [],
  );
}

/**
 * The execution results an owner has to verify. An action in `executing` or `unknown`, an output in
 * `unknown` and a privileged request in `executing` or `unknown` have crossed the external boundary
 * without a confirmed result: none of them may be reported as a refusal, and none may be repeated
 * before its result is checked. Each keeps its own scope, because the three are recorded, retried
 * and released differently.
 */
export function executionConditions(input: {
  actions: readonly { id: string; agentId: string; runId: string }[];
  outputs: readonly { id: string; agentId: string }[];
  requests: readonly { id: string; agentId: string }[];
}): DiagnosisCondition[] {
  return [
    ...input.actions.map((action) => ({
      source: "execution" as const,
      scope: {
        kind: "action" as const,
        agentId: action.agentId,
        actionId: action.id,
        runId: action.runId,
      },
      stage: "execution" as const,
      need: "verify_unknown_effect" as const,
      reason: "This operation crossed the external boundary without a confirmed result",
      action: "Check this operation's recorded result in the Agent's activity; do not repeat it.",
      nextAttemptAt: null,
    })),
    ...input.outputs.map((output) => ({
      source: "execution" as const,
      scope: { kind: "output" as const, agentId: output.agentId, outputId: output.id },
      stage: "execution" as const,
      need: "verify_unknown_effect" as const,
      reason: "This outbound message crossed the external boundary without a confirmed result",
      action: "Check whether this message reached its target before sending it again.",
      nextAttemptAt: null,
    })),
    ...input.requests.map((request) => ({
      source: "execution" as const,
      scope: {
        kind: "system_request" as const,
        agentId: request.agentId,
        requestId: request.id,
      },
      stage: "execution" as const,
      need: "verify_unknown_effect" as const,
      reason: "This privileged command crossed the external boundary without a confirmed result",
      action: "Check this request's recorded result before it is approved again.",
      nextAttemptAt: null,
    })),
  ];
}

/**
 * Slack readiness per installation and target, classified for the owner. A connection that is
 * still coming up is a wait; a credential or permission problem is a configuration fix. A target
 * whose access the platform has definitely denied is left out: the access check answers it, and a
 * definite refusal is reported by the operation that hit it.
 */
export function slackConditions(slack: SlackReadiness | null): DiagnosisCondition[] {
  if (!slack) return [];
  const conditions: DiagnosisCondition[] = slack.installations.flatMap(
    (installation: SlackInstallationReadiness) =>
      installation.state === "ready"
        ? []
        : [
            {
              source: "slack" as const,
              scope: { kind: "slack_installation" as const, agentId: installation.agentId },
              stage: null,
              need:
                installation.state === "needs-human"
                  ? ("configuration_fix" as const)
                  : ("automatic_wait" as const),
              // The reason is a platform string, so it is filtered like a worker fault's. The
              // action is this module's own wording and names the configuration reference the
              // operator has to change; filtering it would redact the one actionable name.
              reason: filterReason(installation.reason) || "Slack installation is not ready",
              action: installation.action ?? null,
              nextAttemptAt:
                installation.state === "needs-human" ? null : (installation.nextAttemptAt ?? null),
            },
          ],
  );
  for (const target of slack.targets ?? []) {
    if (target.permission !== "unconfirmed" && target.history !== "pending") continue;
    conditions.push({
      source: "slack",
      scope: {
        kind: "slack_target",
        agentId: target.agentId,
        channel: target.channel,
        conversationId: target.conversationId,
      },
      stage: null,
      need: "automatic_wait",
      reason: filterReason(target.reason) || "Slack target is not ready",
      action: null,
      nextAttemptAt: null,
    });
  }
  return conditions;
}

/** The daemon-process fact as a condition, and nothing while it is simply running. */
export function daemonConditions(service: ServiceState | null): DiagnosisCondition[] {
  if (service === null || service === "active") return [];
  if (service === "activating" || service === "reloading" || service === "deactivating")
    return [
      {
        source: "daemon",
        scope: { kind: "daemon" },
        stage: null,
        need: "automatic_wait",
        reason: `mate.service is ${service}`,
        action: null,
        nextAttemptAt: null,
      },
    ];
  // "unknown" is the service manager not answering, which is not the same fact as a stopped
  // service: telling the owner to start a service that may already run would be wrong.
  if (service === "unknown")
    return [
      {
        source: "daemon",
        scope: { kind: "daemon" },
        stage: null,
        need: "failure_review",
        reason: "The service manager did not report the state of mate.service",
        action: "Check mate.service with systemctl and the Mate service journal.",
        nextAttemptAt: null,
      },
    ];
  return [
    {
      source: "daemon",
      scope: { kind: "daemon" },
      stage: null,
      need: "configuration_fix",
      reason: `mate.service is ${service}`,
      action: "Start mate.service and check its status.",
      nextAttemptAt: null,
    },
  ];
}

/**
 * The next step a person can take, from the shared retry disposition alone: a scheduled automatic
 * attempt needs nobody, while a held Agent names the action that releases it. Owner output stays an
 * allowlist projection, so this is a fixed instruction per disposition, in the owner's own
 * vocabulary (`activity`, `agent-resume`), and never run text.
 */
export function resumeInstruction(hold: FaultDisposition): string | null {
  return ownerReadings[hold].action;
}

/**
 * A reason read back from a durable record is filtered again here. The writer already filtered it,
 * but this view is the last boundary before owner output, so a record written by another path
 * still cannot carry a credential, a SQL statement or a private body into it.
 */
function ownerReason(fault: WorkerFault | null, hold: FaultDisposition): string {
  const written = fault && workerFaultSchema.safeParse(fault);
  const filtered = written?.success ? filterReason(written.data.reason) : "";
  return filtered || ownerReadings[hold].statement;
}

/** A person's work comes before an automatic wait, and a stable scope keeps the order readable. */
function compareConditions(a: DiagnosisCondition, b: DiagnosisCondition): number {
  const urgency = diagnosisNeeds.indexOf(a.need) - diagnosisNeeds.indexOf(b.need);
  if (urgency) return urgency;
  return scopeKey(a.scope).localeCompare(scopeKey(b.scope));
}

function scopeKey(scope: DiagnosisScope): string {
  switch (scope.kind) {
    case "daemon":
      return "daemon";
    case "agent":
      return `agent:${scope.agentId}`;
    case "slack_installation":
      return `slack:${scope.agentId}`;
    case "slack_target":
      return `slack:${scope.agentId}:${scope.channel}`;
    case "action":
      return `action:${scope.agentId}:${scope.actionId}`;
    case "output":
      return `output:${scope.agentId}:${scope.outputId}`;
    case "system_request":
      return `request:${scope.agentId}:${scope.requestId}`;
  }
}
