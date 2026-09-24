import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { z } from "zod";

/**
 * The one failure result shared by both sides of the worker-process boundary.
 *
 * A run crosses a process boundary: the caller owns the application database, the tool brokers
 * and the credential environment, while the worker owns the model loop. An error raised on
 * either side therefore has to survive `JSON.stringify` and still tell the caller what failed,
 * where it failed, and whether trying again is safe. Neither an `Error` nor its message
 * survives that, so this module is the single definition both sides classify into.
 *
 * `reason` and `detail` are already filtered here. They never carry credentials, private Agent
 * memory, raw SQL or an unfiltered third-party exception. `retryDisposition` turns the category
 * into the recovery decision the run module needs.
 */
export const faultStages = [
  "model",
  "tool",
  "execution",
  "persistence",
  "recovery",
  "worker",
  "unknown",
] as const;
export type FaultStage = (typeof faultStages)[number];

/**
 * `transient_model` and `credential_config` are model-boundary outcomes, `definite_tool_refusal`
 * is a refusal decided before any side effect, `unknown_effect` means an external write may have
 * happened and must be verified rather than repeated, and `shared_persistence` means the durable
 * record itself is unavailable.
 */
export const faultCategories = [
  "transient_model",
  "credential_config",
  "definite_tool_refusal",
  "unknown_effect",
  "shared_persistence",
  "aborted",
] as const;
export type FaultCategory = (typeof faultCategories)[number];

export interface WorkerFault {
  stage: FaultStage;
  category: FaultCategory;
  /** Short, filtered, stable reason. Never an unfiltered exception message. */
  reason: string;
  /** Optional bounded, allow-listed facts that are safe to print, such as a driver code. */
  detail?: string | undefined;
}

/** What the caller should do about a fault. Recovery reads this, not the error text. */
export type FaultDisposition = "retry_backoff" | "human_action" | "verify_effect" | "no_retry";

export const workerFaultSchema = z
  .object({
    stage: z.enum(faultStages),
    category: z.enum(faultCategories),
    reason: z.string().min(1).max(200),
    detail: z.string().max(80).optional(),
  })
  .strict();

const MAX_REASON = 200;
const MAX_DETAIL = 80;
const MARKER = Symbol.for("mate.worker-fault");

interface Marked {
  [MARKER]?: WorkerFault;
}

/** A failure the raising code has already placed on this boundary's shared vocabulary. */
export class FaultError extends Error {
  readonly fault: WorkerFault;
  constructor(fault: WorkerFault) {
    super(fault.reason);
    this.name = "FaultError";
    this.fault = fault;
  }
}

/** A refusal decided before any side effect; retrying the identical call cannot help. */
export class RefusalError extends FaultError {
  constructor(message: string, detail?: string | undefined, reason?: string | undefined) {
    super(
      optionalDetail(
        {
          stage: "tool",
          category: "definite_tool_refusal",
          reason: bounded(reason ?? message, "the operation was refused"),
        },
        detail,
      ),
    );
    this.name = "RefusalError";
  }
}

function optionalDetail(fault: WorkerFault, detail: string | undefined): WorkerFault {
  return detail ? { ...fault, detail: safeDetail(detail) } : fault;
}

export const refusal = (message: string, detail?: string, reason?: string): RefusalError =>
  new RefusalError(message, detail, reason);

/** The stage each worker RPC belongs to, so caller-side failures keep the stage that owns them. */
export function classifyRpcStage(kind: string): FaultStage {
  switch (kind) {
    case "tool":
      return "tool";
    case "refreshRecovery":
      return "recovery";
    case "journal":
    case "usageBegin":
    case "usageComplete":
      return "persistence";
    default:
      return "worker";
  }
}

/** The fault already carried by an error, if any. Survives the process boundary. */
export function faultOf(error: unknown): WorkerFault | undefined {
  if (!error || typeof error !== "object") return undefined;
  return (error as Marked)[MARKER] ?? (error instanceof FaultError ? error.fault : undefined);
}

/** The category an error crossed the boundary with, or `undefined` if it carries none. */
export function faultCategory(error: unknown): FaultCategory | undefined {
  return faultOf(error)?.category;
}

/**
 * Attach a fault to an error raised where the stage is known locally, returning the same object
 * so existing `catch`/`rethrow` call sites keep working.
 */
export function classified<T>(error: T, fault: WorkerFault): T {
  if (error && typeof error === "object") Object.defineProperty(error, MARKER, { value: fault });
  return error;
}

/** Give every error crossing the boundary one shape. An already-classified error keeps its own
 * stage and category, so a caller-side refusal is not relabelled as a model failure merely
 * because the model loop is what finally threw it. */
export function toWorkerFault(
  error: unknown,
  stage: FaultStage,
  options: { reason?: string } = {},
): WorkerFault {
  const existing = faultOf(error);
  if (existing) return existing;
  const failure = error as { name?: unknown; message?: unknown; code?: unknown } | undefined;
  const message =
    typeof failure?.message === "string"
      ? failure.message
      : typeof error === "string"
        ? error
        : String(error ?? "");
  const driver = driverCode(failure);
  // Nothing throwable crossed this boundary: the caller stated the reason itself.
  if (!message)
    return {
      stage,
      category: stage === "model" ? "credential_config" : "shared_persistence",
      reason: bounded(options.reason, "the operation failed"),
    };
  if (stage === "model") return modelFault(message, options.reason);
  if (stage === "tool") return new RefusalError(options.reason ?? message).fault;
  if (stage === "execution")
    return fault(
      "execution",
      "unknown_effect",
      options.reason ?? message,
      driver,
      "the external effect could not be confirmed",
    );
  return persistenceFault(options.reason ?? message, driver);
}

/** Every fault is built here, so the shape that crosses the boundary is always the schema's. */
function fault(
  stage: FaultStage,
  category: FaultCategory,
  reason: unknown,
  detail: string | undefined,
  fallback: string,
): WorkerFault {
  return optionalDetail({ stage, category, reason: bounded(reason, fallback) }, detail);
}

function modelFault(message: string, reason?: string | undefined): WorkerFault {
  const text = reason ?? message;
  if (/abort/i.test(message))
    return { stage: "model", category: "aborted", reason: bounded(text, "the run was aborted") };
  if (isCredentialFailure(message))
    return {
      stage: "model",
      category: "credential_config",
      reason: bounded(text, "the model credential was rejected"),
    };
  // The provider library owns provider-failure classification; re-deriving HTTP status and
  // retry wording here would drift from the transport those rules describe.
  if (isRetryableAssistantError({ stopReason: "error", errorMessage: message } as never))
    return {
      stage: "model",
      category: "transient_model",
      reason: bounded(text, "the model provider failed transiently"),
    };
  return {
    stage: "model",
    category: "credential_config",
    reason: bounded(text, "the model call failed"),
  };
}

function persistenceFault(message: string, driver?: string): WorkerFault {
  return fault(
    "persistence",
    "shared_persistence",
    persistenceReason(message, driver),
    driver,
    persistenceDefault(driver),
  );
}

/** Rebuild a fault as a throwable error on the far side of the boundary. */
export function faultError(fault: WorkerFault): FaultError {
  // A malformed payload still fails the run; it never silently becomes a usable result. The
  // caller sees the reviewer-visible summary instead of whatever the payload claimed.
  const parsed = workerFaultSchema.safeParse(fault);
  if (!parsed.success)
    return new FaultError({
      stage: "worker",
      category: "shared_persistence",
      reason: "malformed worker fault",
    });
  if (parsed.data.category === "definite_tool_refusal")
    return new RefusalError(parsed.data.reason, parsed.data.detail);
  return new FaultError(parsed.data);
}

/** A filtered reason is safe to store and print: bounded, single-line and free of secrets. */
export function filterReason(text: unknown): string {
  if (typeof text !== "string") return "";
  return text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\b(?:select|insert|update|delete|create|alter|drop)\b[^]*/gi, "[redacted sql]")
    .replace(/\b(?:bearer|api[_-]?key|secret|password)\b\s*[:=]?\s*\S+/gi, "$1 [redacted]")
    .replace(/\b(?:sk|pk|rk|xox[baprs]|ghp|github_pat)[-_][A-Za-z0-9_-]{6,}/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .replace(/(?:\/[\w.@+-]+){2,}/g, "[path]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_REASON)
    .trim();
}

/** The single-line, bounded summary the caller records for an owner-visible failure. */
export function describeFault(fault: WorkerFault): string {
  const parts = [`${fault.stage}/${fault.category}`, fault.reason || "unknown failure"];
  if (fault.detail) parts.push(fault.detail);
  return filterReason(parts.join(": "));
}

/** Recovery reads this instead of re-deriving retry safety from error text. */
export function retryDisposition(fault: WorkerFault): FaultDisposition {
  switch (fault.category) {
    case "transient_model":
      return "retry_backoff";
    case "credential_config":
      return "human_action";
    case "unknown_effect":
      return "verify_effect";
    case "definite_tool_refusal":
    case "shared_persistence":
    case "aborted":
      return "no_retry";
  }
}

/** Driver failures that mean the shared durable record is unavailable, and their safe wording. */
const driverReasons: Readonly<Record<string, string>> = {
  SQLITE_BUSY: "durable record write failed",
  SQLITE_LOCKED: "durable record write failed",
  SQLITE_READONLY: "durable record write failed",
  SQLITE_FULL: "durable record write failed",
  SQLITE_CORRUPT: "shared store corrupted",
  SQLITE_CANTOPEN: "shared store unavailable",
  SQLITE_IOERR: "shared store unavailable",
  SQLITE_NOTADB: "shared store unavailable",
};

function driverCode(failure: { code?: unknown } | undefined): string | undefined {
  const code = failure?.code;
  return typeof code === "string" && safeDetail(code) ? code : undefined;
}

function persistenceReason(message: string, driver?: string): string {
  const code = /SQLITE_[A-Z_]+/.exec(message)?.[0];
  const named = (driver && driverReasons[driver]) ?? (code && driverReasons[code]);
  return named ?? message;
}

function persistenceDefault(driver?: string): string {
  return (driver && driverReasons[driver]) ?? "the durable record is unavailable";
}

function isCredentialFailure(message: string): boolean {
  return /api[ _-]?key|unauthori[sz]ed|authentication|credential|invalid key|\b401\b|forbidden|permission denied|no such model|model not found|unknown provider/i.test(
    message,
  );
}

function bounded(text: unknown, fallback: string): string {
  return filterReason(text) || fallback;
}

function safeDetail(text: string): string {
  return filterReason(text)
    .replace(/[^A-Za-z0-9_. =:-]/g, "")
    .slice(0, MAX_DETAIL);
}
