import type Database from "better-sqlite3";
import type { Store } from "../storage/store.js";

/**
 * Connection readiness of the external Slack installations, reported separately from the daemon
 * process running. The daemon schedules internal work as soon as its own startup finishes; an
 * installation that is not ready only stops the work that genuinely needs Slack.
 */
export type SlackInstallationState = "connecting" | "ready" | "waiting" | "needs-human";
export interface SlackInstallationReadiness {
  agentId: string;
  state: SlackInstallationState;
  /** Stable reason for the current state, e.g. `connected` or `missing_scope`. */
  reason: string;
  /** The concrete human action, present only when the state needs one. */
  action?: string;
  /** When the next automatic attempt is due; absent when nothing is scheduled. */
  nextAttemptAt?: number;
  attempts: number;
  changedAt: number;
}
export interface SlackReadiness {
  updatedAt: number;
  installations: SlackInstallationReadiness[];
}
/**
 * One installation is usable only when its own connection, permission and history are ready.
 * Readiness this process never published (an embedded application, a harness) reports nothing to
 * wait for; only an installation this runtime has an opinion about can hold work back.
 */
export function slackReady(readiness: SlackReadiness | undefined, agentId: string): boolean {
  if (!readiness) return true;
  return readiness.installations.find((entry) => entry.agentId === agentId)?.state === "ready";
}
/** Why Slack-dependent work waits, or undefined when nothing waits. Never carries credentials. */
export function slackWaitReason(
  readiness: SlackReadiness | undefined,
  agentId: string,
): string | undefined {
  if (!readiness) return undefined;
  const entry = readiness.installations.find((item) => item.agentId === agentId);
  if (!entry || entry.state === "ready") return undefined;
  const opening =
    entry.state === "needs-human"
      ? `Slack installation ${agentId} needs an operator`
      : entry.state === "connecting"
        ? `Slack installation ${agentId} is still connecting`
        : `Slack installation ${agentId} is waiting to recover`;
  return `${opening} (${entry.reason})${entry.action ? `: ${entry.action}` : "; Mate retries automatically"}`;
}
/** Slack error codes that no automatic attempt can fix, with the action each one needs. */
const credentialCodes = new Set([
  "account_inactive",
  "invalid_auth",
  "invalid_refresh_token",
  "not_authed",
  "token_expired",
  "token_revoked",
  "user_token_revoked",
]);
const permissionCodes = new Set([
  "ekm_access_denied",
  "enterprise_is_restricted",
  "missing_scope",
  "no_permission",
  "not_allowed_token_type",
  "restricted_action",
]);
export interface SlackFailure {
  state: "waiting" | "needs-human";
  reason: string;
  action?: string;
  /** A platform-supplied delay before the next attempt, when the error states one. */
  retryAfterMs?: number;
}
/**
 * Classify a failed connection, verification, membership or catch-up step. Credential and
 * permission problems name the human action; everything else is a temporary condition that the
 * runtime retries by itself.
 */
export function classifySlackFailure(error: unknown, agentId: string): SlackFailure {
  const failure = error as { code?: string; data?: { error?: string }; retryAfter?: number };
  const code = failure?.data?.error;
  if (typeof failure?.retryAfter === "number" && Number.isFinite(failure.retryAfter))
    return {
      state: "waiting",
      reason: code ?? "rate_limited",
      retryAfterMs: Math.max(1000, failure.retryAfter * 1000),
    };
  if (code && credentialCodes.has(code))
    return {
      state: "needs-human",
      reason: code,
      action: `Replace the Slack tokens of ${agentId} in the Mate service environment, then restart Mate.`,
    };
  if (code && permissionCodes.has(code))
    return {
      state: "needs-human",
      reason: code,
      action: `Grant the Slack app of ${agentId} the missing scopes and install it again, then restart Mate.`,
    };
  return { state: "waiting", reason: code ?? "connection_unavailable" };
}
/** A local problem the operator must fix before this installation can connect at all. */
export function missingCredentialFailure(
  agentId: string,
  references: readonly string[],
): SlackFailure {
  return {
    state: "needs-human",
    reason: "missing_credentials",
    action: `Set ${references.join(", ")} for ${agentId} in the Mate service environment, then restart Mate.`,
  };
}
/** Raised when the reason a connection cannot start is already known not to be temporary. */
export class SlackOperatorActionError extends Error {
  constructor(readonly failure: SlackFailure) {
    super(`Slack needs an operator: ${failure.reason}`);
    this.name = "SlackOperatorActionError";
  }
}
export const slackReadinessKey = "slack_readiness_v1";
/** Persist the current readiness so an owner view can report it without constructing Slack. */
export function recordSlackReadiness(store: Store, readiness: SlackReadiness): void {
  store.db
    .prepare(
      "INSERT INTO runtime_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(slackReadinessKey, JSON.stringify(readiness));
}
/** Read the persisted readiness; an unreadable record reports nothing instead of failing a view. */
export function readSlackReadiness(source: { db: Database.Database }): SlackReadiness | null {
  let raw: { value: string } | undefined;
  try {
    raw = source.db.prepare("SELECT value FROM runtime_meta WHERE key=?").get(slackReadinessKey) as
      { value: string } | undefined;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.value) as SlackReadiness;
    if (
      !parsed ||
      typeof parsed.updatedAt !== "number" ||
      !Array.isArray(parsed.installations) ||
      parsed.installations.some(
        (entry) =>
          !entry ||
          typeof entry.agentId !== "string" ||
          typeof entry.reason !== "string" ||
          !["connecting", "ready", "waiting", "needs-human"].includes(entry.state),
      )
    )
      return null;
    return { updatedAt: parsed.updatedAt, installations: parsed.installations };
  } catch {
    return null;
  }
}
