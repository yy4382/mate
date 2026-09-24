import { z } from "zod";
import type { ConversationHistory } from "../conversations/history.js";
import type { SessionLifecycle } from "./sessions.js";
import type { MessageTasks } from "../coordination/messages.js";
import type { CanonicalFreshnessGate } from "../conversations/freshness.js";
import type { RunToken } from "../storage/store.js";
import type { Collaboration } from "../collaboration/service.js";
import type { Broker } from "../policy/broker.js";
import type { SystemOperations } from "../policy/system-operations.js";
import type { ConversationDirectory } from "../conversations/directory.js";

export type SeatPolicy = "deny" | "redacted-read" | "clean-workspace" | "held-send";
export type EffectPolicy = "pure-read" | "atomic-recorded" | "broker-recorded" | "adapter-recorded";
export type ReplayPolicy = "immutable" | "refreshable" | "boundary-owned";
/**
 * Replay identity, owned by the shared router. A "work" call is recorded together with the work
 * item selected when it arrived, plus the operation name and arguments. A "session" call is
 * recorded without that selection, for the operation that changes it itself.
 */
export type ReplayScope = "work" | "session";

export interface AdditionalTools {
  environment?(run: RunToken, workId: string): unknown;
  /** Process control answers through a cancellable wait; a slow host must not stall the daemon. */
  processes?: {
    list(agentId: string, signal?: AbortSignal): unknown;
    stop(agentId: string, unit: string, signal?: AbortSignal): unknown;
  };
  system?: SystemOperations;
  attachment?(
    run: RunToken,
    workId: string,
    actionId: string,
    args: import("../capabilities/artifacts.js").AttachmentArgs,
    signal: AbortSignal,
  ): Promise<unknown>;
  publish(
    run: RunToken,
    workId: string,
    actionId: string,
    args: import("../capabilities/artifacts.js").PublishArgs,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface ToolExecutionContext {
  operation: string;
  run: RunToken;
  /** Work item the action is attributed to; the owning module decides this from its own input. */
  workId: string;
  requestWorkId: string;
  actionId: string;
  signal: AbortSignal;
  collaboration: Collaboration;
  broker: Broker;
  additional?: AdditionalTools;
  directory?: ConversationDirectory;
  history: ConversationHistory;
  sessions: SessionLifecycle;
  coordination: MessageTasks;
  gate: CanonicalFreshnessGate;
}
export interface ToolHandlerResult {
  value: unknown;
  wait?: boolean;
}

/** Arguments of one operation, taken from the same schema the router validates that call with. */
export type ToolArguments<Schema extends z.ZodType> = z.output<Schema>;

/**
 * The owning tool module interprets one operation's own object references: actor identity,
 * current visibility, and the work item the action belongs to. It returns that work item.
 * The router calls it before execution and again once the operation's await is over, so a run that
 * was fenced, a work item that was paused or a membership that was withdrawn while the call was in
 * flight is refused before its result is used. The work item itself is fixed for the call.
 */
export type ToolAuthorize<Schema extends z.ZodType> = (
  context: ToolExecutionContext,
  args: ToolArguments<Schema>,
) => string;

/** Handler parameters are derived from the operation's input schema, never declared separately. */
export type ToolHandler<Schema extends z.ZodType> = (
  context: ToolExecutionContext,
  args: ToolArguments<Schema>,
) => ToolHandlerResult | Promise<ToolHandlerResult>;

/** One operation as a tool module declares it, before the registry freezes its policies. */
export interface ToolSpecInput<Schema extends z.ZodType> {
  name: string;
  schema: Schema;
  description: string;
  replayScope: ReplayScope;
  seatPolicy: SeatPolicy;
  effectPolicy: EffectPolicy;
  replayPolicy: ReplayPolicy;
  authorize: ToolAuthorize<Schema>;
  handler: ToolHandler<Schema>;
}

interface ToolSpecBase {
  name: string;
  schema: z.ZodType;
  description: string;
  replayScope: ReplayScope;
  seatPolicy: SeatPolicy;
  effectPolicy: EffectPolicy;
  replayPolicy: ReplayPolicy;
  authorize: (context: ToolExecutionContext, args: any) => string;
}
export interface AtomicToolSpec extends ToolSpecBase {
  effectPolicy: "atomic-recorded";
  replayPolicy: "immutable" | "refreshable";
  handler: (context: ToolExecutionContext, args: any) => ToolHandlerResult;
}
export interface BoundaryToolSpec extends ToolSpecBase {
  effectPolicy: "pure-read" | "broker-recorded" | "adapter-recorded";
  replayPolicy: "boundary-owned";
  handler: (
    context: ToolExecutionContext,
    args: any,
  ) => ToolHandlerResult | Promise<ToolHandlerResult>;
}
export type ToolSpec = AtomicToolSpec | BoundaryToolSpec;
export interface ToolModule {
  domain: string;
  specs: readonly ToolSpec[];
}

export const id = z.string().min(1).max(500),
  text = z.string().max(35000);
export const messageRef = z.object({ messageId: id }).strict();

/** Run eligibility and cancellation: a fenced run gains no new work and no new side effect. */
export function fence(context: ToolExecutionContext): void {
  context.collaboration.store.assertRun(context.run);
  context.signal.throwIfAborted();
}

/** Fence the run for an operation that names no object of its own. */
export function selectedWork(context: ToolExecutionContext): string {
  fence(context);
  return context.workId;
}

/**
 * Fence the run and require the acting Agent's current access to the conversation the operation
 * names. A module passes the conversation id out of its own validated input, so the shared
 * router never has to recognise a field name.
 */
export function targetWork(
  context: ToolExecutionContext,
  conversationId: string | undefined,
): string {
  fence(context);
  if (conversationId)
    context.collaboration.messages.requireAccess(context.run.agentId, conversationId);
  return context.workId;
}

/** Fence the run and require the attributed work item to be active for this Agent. */
export function activeWork(context: ToolExecutionContext, workId: string = context.workId): string {
  context.collaboration.assertActionWork(context.run, workId);
  context.signal.throwIfAborted();
  return workId;
}

export function spec<Schema extends z.ZodType>(input: ToolSpecInput<Schema>): ToolSpec {
  return Object.freeze(input) as unknown as ToolSpec;
}
