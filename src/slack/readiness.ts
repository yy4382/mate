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
/**
 * Platform conditions of one external target: a Slack channel or DM this installation acts on.
 * The platform channel is the unit, because membership is a fact about a channel — one internal
 * room can be projected into several channels, and each of them carries its own facts. A target
 * that is not ready holds the operations that name it, and it never revokes the installation's
 * other, already verified targets.
 */
export interface SlackTargetReadiness {
  agentId: string;
  /** The platform channel these conditions describe; the identity every boundary call names. */
  channel: string;
  /** The conversation this channel currently carries: the channel itself, or a projected room. */
  conversationId: string;
  /**
   * What the platform last stated about this Agent's membership. `unconfirmed` means no current
   * evidence exists, so a previously cached grant may not be used to cross the boundary.
   */
  permission: "unconfirmed" | "confirmed" | "denied";
  /** Whether this target's local history was caught up on the current connection. */
  history: "pending" | "complete";
  /** Stable reason for the current conditions, e.g. `membership_unconfirmed`. */
  reason: string;
  changedAt: number;
}
export interface SlackReadiness {
  updatedAt: number;
  installations: SlackInstallationReadiness[];
  /** Reported per target; absent in a record written before targets were reported. */
  targets?: SlackTargetReadiness[];
}
/** Which of a target's conditions one operation actually needs before it may cross the boundary. */
export type SlackTargetNeed = "permission" | "history";
/**
 * One installation is usable when its own connection and identity are verified. Its targets then
 * carry the permission and history conditions that hold the operations naming them. Readiness this
 * process never published (an embedded application, a harness) reports nothing to wait for; only an
 * installation this runtime has an opinion about can hold work back.
 */
export function slackReady(readiness: SlackReadiness | undefined, agentId: string): boolean {
  if (!readiness) return true;
  return readiness.installations.find((entry) => entry.agentId === agentId)?.state === "ready";
}
/**
 * Why one target's own conditions make work wait, or undefined when they do not. This answer says
 * nothing about the installation: an internal conversation is never held by a Slack fact. A target
 * this readiness never reported has no pending condition to wait for.
 */
export function slackTargetWaitReason(
  readiness: SlackReadiness | undefined,
  agentId: string,
  channel: string,
  need: SlackTargetNeed,
): string | undefined {
  if (!readiness) return undefined;
  const target = readiness.targets?.find(
    (entry) => entry.agentId === agentId && entry.channel === channel,
  );
  // Unreported conditions and a definite denial are not waits: the access check answers them.
  if (!target || target.permission === "denied") return undefined;
  if (need === "permission" && target.permission === "unconfirmed")
    return `Slack target ${channel} of ${agentId} has no confirmed permission yet (${target.reason})`;
  if (need === "history" && target.history === "pending")
    return `Slack target ${channel} of ${agentId} is still catching up on history (${target.reason}); history.fetch can still read remote pages for it`;
  return undefined;
}
/**
 * Why work naming one target waits before it crosses the platform boundary. The installation gate
 * comes first: without a connection no target condition can be established.
 */
export function slackBoundaryWaitReason(
  readiness: SlackReadiness | undefined,
  agentId: string,
  channel: string,
  need: SlackTargetNeed,
): string | undefined {
  return (
    slackWaitReason(readiness, agentId) ?? slackTargetWaitReason(readiness, agentId, channel, need)
  );
}
/** The readiness facts an adapter consults before it crosses the Slack boundary for one target. */
export interface SlackBoundaryReadiness {
  waitingFor(actor: string): Error | undefined;
  /**
   * The second argument names the target as its conversation or as its platform channel; the
   * holder resolves whichever it needs, so the gate cannot be skipped by naming one instead of
   * the other. Absent when the holder has no per-target readiness to report.
   */
  waitingForTarget?(
    actor: string,
    conversationId: string,
    need: SlackTargetNeed,
  ): Error | undefined;
}
/**
 * The one policy every boundary call applies: the installation's own condition first, then the
 * permission of the target the call names. A call that names no target waits for its installation
 * only, and readiness this process never published waits for nothing.
 */
export function slackBoundaryWait(
  readiness: SlackBoundaryReadiness | undefined,
  actor: string,
  channel?: string,
  need: SlackTargetNeed = "permission",
): Error | undefined {
  if (!readiness) return undefined;
  return (
    readiness.waitingFor(actor) ??
    (channel ? readiness.waitingForTarget?.(actor, channel, need) : undefined)
  );
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
/**
 * What the persisted readiness source states: nothing was ever published, the published record
 * cannot be read, or a readable record. A diagnostic that reports readiness needs the difference,
 * because "this installation has no readiness yet" and "the readiness record is broken" are
 * different facts with different next actions.
 */
export type SlackReadinessRecord =
  { state: "absent" } | { state: "unreadable" } | { state: "read"; readiness: SlackReadiness };
/** Read the persisted readiness record without deciding what an unreadable one means. */
export function readSlackReadinessRecord(source: { db: Database.Database }): SlackReadinessRecord {
  let raw: { value: string } | undefined;
  try {
    raw = source.db.prepare("SELECT value FROM runtime_meta WHERE key=?").get(slackReadinessKey) as
      { value: string } | undefined;
  } catch {
    return { state: "unreadable" };
  }
  if (!raw) return { state: "absent" };
  const readiness = parseSlackReadiness(raw.value);
  return readiness ? { state: "read", readiness } : { state: "unreadable" };
}
/** Read the persisted readiness; an unreadable record reports nothing instead of failing a view. */
export function readSlackReadiness(source: { db: Database.Database }): SlackReadiness | null {
  const record = readSlackReadinessRecord(source);
  return record.state === "read" ? record.readiness : null;
}
function parseSlackReadiness(value: string): SlackReadiness | null {
  try {
    const parsed = JSON.parse(value) as SlackReadiness;
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
    // A record written before targets were reported keeps its installation facts and simply
    // reports no target condition; an unreadable target list invalidates the record.
    const targets = parsed.targets ?? [];
    if (
      !Array.isArray(targets) ||
      targets.some(
        (entry) =>
          !entry ||
          typeof entry.agentId !== "string" ||
          typeof entry.channel !== "string" ||
          typeof entry.conversationId !== "string" ||
          typeof entry.reason !== "string" ||
          !["unconfirmed", "confirmed", "denied"].includes(entry.permission) ||
          !["pending", "complete"].includes(entry.history),
      )
    )
      return null;
    return {
      updatedAt: parsed.updatedAt,
      installations: parsed.installations,
      ...(parsed.targets ? { targets } : {}),
    };
  } catch {
    return null;
  }
}
