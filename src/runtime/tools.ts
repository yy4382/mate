import { z } from "zod";
import { createHash } from "node:crypto";
import { ConversationHistory, type HistorySource } from "../conversations/history.js";
import { SessionLifecycle } from "./sessions.js";
import { buildBaseline } from "./prompt.js";
import { MessageTasks } from "../coordination/messages.js";
import { CanonicalFreshnessGate as FreshnessGate } from "../conversations/freshness.js";
import type { RunToken } from "../storage/store.js";
import type { Collaboration } from "../collaboration/service.js";
import type { Broker } from "../policy/broker.js";
import type { ConversationDirectory } from "../conversations/directory.js";
import type { ToolReply } from "./engine.js";
import { conversationHistoryModule } from "./tool-modules/conversation-history.js";
import { coordinationRemindersModule } from "./tool-modules/coordination-reminders.js";
import { sessionStatusModule } from "./tool-modules/session-status.js";
import { capabilitiesModule } from "./tool-modules/capabilities.js";
import {
  id,
  type AdditionalTools,
  type ToolExecutionContext,
  type ToolHandlerResult,
  type ToolModule,
  type ToolSpec,
} from "./tool-contract.js";
export type {
  AdditionalTools,
  ReplayScope,
  EffectPolicy,
  ReplayPolicy,
  SeatPolicy,
  ToolModule,
  ToolSpec,
} from "./tool-contract.js";

const discoverySchemas = {
  "tools.list": z.object({}).strict(),
  "tools.describe": z.object({ name: id }).strict(),
  "tools.call": z.object({ name: id, input: z.unknown() }).strict(),
};
export const builtInToolModules: readonly ToolModule[] = Object.freeze([
  conversationHistoryModule,
  coordinationRemindersModule,
  sessionStatusModule,
  capabilitiesModule,
]);

function buildRegistry(modules: readonly ToolModule[]): Map<string, ToolSpec> {
  const registry = new Map<string, ToolSpec>(),
    domains = new Set<string>();
  const replayScope = new Set(["work", "session"]),
    seat = new Set(["deny", "redacted-read", "clean-workspace", "held-send"]),
    effect = new Set(["pure-read", "atomic-recorded", "broker-recorded", "adapter-recorded"]),
    replay = new Set(["immutable", "refreshable", "boundary-owned"]);
  for (const module of modules) {
    if (!module.domain || !module.specs?.length || domains.has(module.domain))
      throw new Error("Invalid or duplicate tool module");
    domains.add(module.domain);
    for (const entry of module.specs) {
      if (
        !/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(entry.name) ||
        entry.name.startsWith("tools.") ||
        registry.has(entry.name)
      )
        throw new Error("Invalid, reserved or duplicate tool spec");
      if (
        typeof entry.schema?.parse !== "function" ||
        !entry.description.trim() ||
        !replayScope.has(entry.replayScope) ||
        !seat.has(entry.seatPolicy) ||
        !effect.has(entry.effectPolicy) ||
        !replay.has(entry.replayPolicy) ||
        typeof entry.authorize !== "function" ||
        typeof entry.handler !== "function"
      )
        throw new Error("Incomplete or unknown tool spec policy");
      if ((entry.effectPolicy === "atomic-recorded") !== (entry.replayPolicy !== "boundary-owned"))
        throw new Error("Invalid effect and replay policy combination");
      // Which object a call names, and therefore which work item it belongs to, is interpreted by
      // the owning tool module's `authorize`; the registry can only check the policies that stay
      // declarative here. These two combinations keep a broker-recorded or held-send operation
      // from claiming session-only replay identity.
      if (
        entry.seatPolicy === "clean-workspace" &&
        (entry.effectPolicy !== "broker-recorded" || entry.replayScope !== "work")
      )
        throw new Error("Invalid clean-workspace policy combination");
      if (
        entry.seatPolicy === "held-send" &&
        (entry.replayScope !== "work" || entry.effectPolicy !== "atomic-recorded")
      )
        throw new Error("Invalid held-send policy combination");
      if (
        entry.seatPolicy === "redacted-read" &&
        (entry.effectPolicy === "broker-recorded" || entry.effectPolicy === "adapter-recorded")
      )
        throw new Error("Invalid redacted-read policy combination");
      registry.set(entry.name, Object.freeze({ ...entry }));
    }
  }
  return registry;
}

const builtInRegistry = buildRegistry(builtInToolModules);
export const builtInToolSpecs: readonly ToolSpec[] = Object.freeze([...builtInRegistry.values()]);
export function validateToolModules(modules: readonly ToolModule[]): readonly ToolSpec[] {
  return Object.freeze([...buildRegistry(modules).values()]);
}
export function fingerprintToolSpecs(specs: readonly ToolSpec[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        format: "mate.tool-contract.v1",
        operations: specs.map(
          ({ name, description, replayScope, seatPolicy, effectPolicy, replayPolicy, schema }) => ({
            name,
            description,
            replayScope,
            seatPolicy,
            effectPolicy,
            replayPolicy,
            inputSchema: z.toJSONSchema(schema),
          }),
        ),
        discovery: Object.entries(discoverySchemas).map(([name, schema]) => ({
          name,
          inputSchema: z.toJSONSchema(schema),
        })),
      }),
    )
    .digest("hex");
}
export const operationContractFingerprint = fingerprintToolSpecs(builtInToolSpecs);
export const operationDocumentation =
  `Use tools.list to discover capabilities and tools.describe with {name} for exact schemas. Call the named operation directly, or tools.call with {name,input}. Tool contract: ${operationContractFingerprint}. Available: ${builtInToolSpecs.map((entry) => entry.name).join(", ")}.\n` +
  Object.entries(discoverySchemas)
    .map(([name, schema]) => `${name}: ${JSON.stringify(z.toJSONSchema(schema))}`)
    .join("\n");

function isPromise(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as Promise<unknown>).then === "function";
}

export class ToolRouter {
  readonly gate: FreshnessGate;
  readonly coordination: MessageTasks;
  readonly history: ConversationHistory;
  readonly sessions: SessionLifecycle;
  private readonly specs: ReadonlyMap<string, ToolSpec>;
  constructor(
    readonly collaboration: Collaboration,
    readonly broker: Broker,
    readonly additional?: AdditionalTools,
    readonly directory?: ConversationDirectory,
    readonly normalizeInput: (value: unknown) => unknown = (value) => value,
    historySource?: HistorySource,
  ) {
    this.specs = buildRegistry(builtInToolModules);
    this.history = new ConversationHistory(collaboration.messages, historySource);
    this.sessions = new SessionLifecycle(collaboration, (agent) =>
      buildBaseline(agent, operationDocumentation),
    );
    this.coordination = new MessageTasks(collaboration);
    // The application assembly wires one gate onto the output before this router exists; a
    // router built on its own keeps an equivalent gate for its own held-send policy instead
    // of reaching back and installing a collaborator onto another object.
    this.gate =
      collaboration.output.gate ??
      new FreshnessGate(collaboration.messages, collaboration.attention);
  }
  async call(
    run: RunToken,
    workId: string,
    callId: string,
    operation: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<ToolReply> {
    const c = this.collaboration;
    c.store.assertRun(run);
    signal.throwIfAborted();
    if (operation === "tools.call") {
      const request = discoverySchemas["tools.call"].parse(input);
      operation = request.name;
      input = request.input;
      if (operation.startsWith("tools.")) throw new Error("Unknown operation");
    }
    if (operation === "tools.list") {
      discoverySchemas["tools.list"].parse(input);
      const seat = c.seats.active(run.agentId);
      return {
        value: [...this.specs.values()]
          .filter((entry) => !seat || entry.seatPolicy !== "deny")
          .map(({ name, description }) => ({ name, description })),
      };
    }
    if (operation === "tools.describe") {
      const request = discoverySchemas["tools.describe"].parse(input),
        entry = this.specs.get(request.name);
      if (!entry) throw new Error("Unknown operation");
      this.authorizeSeat(entry, run);
      return {
        value: {
          name: entry.name,
          description: entry.description,
          inputSchema: z.toJSONSchema(entry.schema),
        },
      };
    }
    const entry = this.specs.get(operation);
    if (!entry) throw new Error("Unknown operation");
    this.authorizeSeat(entry, run);
    const args = entry.schema.parse(this.normalizeInput(input)) as Record<string, any>,
      selected = c.currentWork(run, workId);
    // The owning tool module names the work item this call belongs to; the router never reads a
    // field name to decide that. The pre-flight call is re-made after any await below.
    const bound = entry.authorize(
      this.context(run, selected, callId, operation, signal, selected),
      args,
    );
    const context = this.context(run, bound, callId, operation, signal, selected);
    if (entry.effectPolicy === "atomic-recorded") return this.atomic(entry, context, args);
    const result = await entry.handler(context, args);
    // Re-make the owning module's check now the await is over: a run fenced, a work item paused or
    // a membership withdrawn while the call was in flight must not produce a usable result.
    entry.authorize(context, args);
    this.authorizeSeat(entry, run);
    const safe = this.seatResult(entry, context, result);
    return { value: safe.value, ...(safe.wait ? { wait: true } : {}) };
  }
  private context(
    run: RunToken,
    workId: string,
    callId: string,
    operation: string,
    signal: AbortSignal,
    requestWorkId: string,
  ): ToolExecutionContext {
    return {
      operation,
      run,
      workId,
      requestWorkId,
      actionId: `${run.sessionId}:${callId}`,
      signal,
      collaboration: this.collaboration,
      broker: this.broker,
      ...(this.additional ? { additional: this.additional } : {}),
      ...(this.directory ? { directory: this.directory } : {}),
      history: this.history,
      sessions: this.sessions,
      coordination: this.coordination,
      gate: this.gate,
    };
  }
  private atomic(
    entry: ToolSpec,
    context: ToolExecutionContext,
    args: Record<string, any>,
  ): ToolReply {
    const c = this.collaboration,
      s = c.store,
      request =
        entry.replayScope === "session"
          ? { operation: entry.name, args }
          : { workId: context.requestWorkId, operation: entry.name, args };
    return s.atomic(() => {
      const existing = c.messages.writes.prepareAction(context.run, context.actionId, request);
      if (existing.state === "succeeded" && entry.replayPolicy === "immutable")
        return JSON.parse(existing.receipt!) as ToolReply;
      if (existing.state === "succeeded" && entry.replayPolicy === "refreshable") {
        s.db
          .prepare("UPDATE actions SET state='prepared',run_id=? WHERE id=?")
          .run(context.run.id, context.actionId);
        existing.state = "prepared";
      }
      if (existing.state !== "prepared") throw new Error("Uncertain tool action");
      s.startAction(context.run, context.actionId);
      const result = entry.handler(context, args);
      if (isPromise(result)) throw new Error("Atomic tool handler returned a promise");
      const safe = this.seatResult(entry, context, result),
        reply = { value: safe.value, wait: Boolean(safe.wait) };
      s.settleAction(context.run, context.actionId, "succeeded", reply);
      return reply;
    });
  }
  private authorizeSeat(entry: ToolSpec, run: RunToken): void {
    if (!this.collaboration.seats.active(run.agentId)) return;
    switch (entry.seatPolicy) {
      case "deny":
        throw new Error("Independent review seat isolates this input path");
      case "redacted-read":
      case "clean-workspace":
      case "held-send":
        return;
    }
  }
  private seatResult(
    entry: ToolSpec,
    context: ToolExecutionContext,
    result: ToolHandlerResult,
  ): ToolHandlerResult {
    if (!this.collaboration.seats.active(context.run.agentId) || entry.seatPolicy !== "held-send")
      return result;
    const draftId = (result.value as { draftId?: unknown } | null)?.draftId;
    if (typeof draftId !== "string") throw new Error("Review-seat submission lacks an owned draft");
    return { ...result, value: context.gate.describe(context.run.agentId, draftId) };
  }
}
