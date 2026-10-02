import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import { respond, type ProviderRequest } from "./agent-loop.js";
import { conversationToolDefinitions } from "../../src/conversations/tool-contracts.js";
import { workspaceToolDefinitions } from "../../src/workspaces/tool-contracts.js";
import { attachmentToolDefinitions } from "../../src/attachments/tool-contracts.js";
import { readScriptedToolResult } from "./scripted-tool-results.js";
import type { PreparedScenarioAgent } from "./scenario-environment.js";

const failureCodeSchema = z.enum([
  "response_timeout",
  "unexpected_cancellation",
  "unexpected_request",
  "script_exhausted",
  "step_failed",
  "step_timeout",
  "step_cancelled",
  "wait_timeout",
  "late_request",
  "provider_closed",
]);
export class ScriptedProviderError extends Error {
  constructor(
    readonly code: z.output<typeof failureCodeSchema>,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
const requestSchema = z.looseObject({ input: z.array(z.unknown()), model: z.string() });
const toolDefinitions = {
  ...conversationToolDefinitions,
  ...workspaceToolDefinitions,
  ...attachmentToolDefinitions,
  "process.exec": { schema: z.object({ command: z.string(), cwd: z.string().optional() }) },
};
type ToolName = keyof typeof toolDefinitions;
export type ScriptedToolCall = {
  name: "tools.list" | "tools.describe" | "tools.call";
  input: unknown;
};
const outcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("responded") }),
  z.object({ kind: z.literal("cancelled"), reason: z.string() }),
  z.object({ kind: z.literal("closed") }),
  z.object({ kind: z.literal("timeout") }),
  z.object({ kind: z.literal("failed") }),
]);
export type ScriptedOutcome = z.output<typeof outcomeSchema>;
export type ScriptedRequest = ReturnType<typeof createRequest>;
export type ModelStep = (request: ScriptedRequest) => void | Promise<void>;

function createRequest(
  payload: z.output<typeof requestSchema>,
  response: ServerResponse,
  agent: PreparedScenarioAgent,
  step: string,
  timeoutMs: number,
  fail: (error: ScriptedProviderError) => void,
) {
  let state = z
    .enum(["pending", "responded", "cancelled", "closed", "timeout", "failed"])
    .parse("pending");
  let expectedCancellation: string | undefined;
  let stepFinished = false;
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const controller = new AbortController();
  let resolveOutcome!: (result: ScriptedOutcome) => void;
  const outcome = new Promise<ScriptedOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const timer = setTimeout(() => {
    fail(
      new ScriptedProviderError(
        state === "responded" ? "step_timeout" : "response_timeout",
        `Scripted provider timed out: Agent ${agent.summary.name} (${agent.summary.id}), step ${step}, request ${JSON.stringify(payload)}`,
      ),
    );
    finish({ kind: "timeout" });
    controller.abort(new Error(`Model step timed out: ${step}`));
    response.destroy();
  }, timeoutMs);
  function finish(result: ScriptedOutcome) {
    if (state !== "pending") return;
    state = result.kind;
    if (stepFinished || result.kind !== "responded") clearTimeout(timer);
    resolveOutcome(result);
    if (result.kind !== "responded")
      controller.abort(new Error(`Model request ${result.kind}: ${step}`));
  }
  function send(content: string | ScriptedToolCall[], prefix?: string, inputTokens?: number) {
    if (state !== "pending") return "late";
    respond(response, content, prefix, inputTokens, randomUUID());
    finish({ kind: "responded" });
    return "responded";
  }
  response.once("close", () => {
    if (state !== "pending") return;
    if (expectedCancellation) finish({ kind: "cancelled", reason: expectedCancellation });
    else {
      fail(
        new ScriptedProviderError(
          "unexpected_cancellation",
          `Unexpected client cancellation: Agent ${agent.summary.name} (${agent.summary.id}), step ${step}, request ${JSON.stringify(payload)}`,
        ),
      );
      finish({ kind: "failed" });
    }
  });
  return {
    agentId: agent.summary.id,
    sessionId: agent.summary.sessionId,
    kind: payload.input.some((item) => {
      const system = z.object({ role: z.literal("system"), content: z.string() }).safeParse(item);
      return (
        system.success && system.data.content.includes("You are a context summarization assistant")
      );
    })
      ? "summary"
      : "normal",
    step,
    payload,
    outcome,
    finished,
    get stepFinished() {
      return stepFinished;
    },
    finishStep() {
      stepFinished = true;
      if (state !== "pending") clearTimeout(timer);
      resolveFinished();
    },
    signal: controller.signal,
    get state() {
      return state;
    },
    result<S extends z.core.$ZodType>(name: string, schema: S) {
      return readScriptedToolResult(payload.input, name, schema);
    },
    text(text: string, options: { inputTokens?: number } = {}) {
      return send(text, undefined, options.inputTokens);
    },
    tools(calls: ScriptedToolCall[], options: { prefix?: string; inputTokens?: number } = {}) {
      return send(calls, options.prefix, options.inputTokens);
    },
    call<N extends ToolName>(
      name: N,
      input: z.input<(typeof toolDefinitions)[N]["schema"]>,
      options: { prefix?: string; inputTokens?: number } = {},
    ) {
      return send(
        [{ name: "tools.call", input: { name, input } }],
        options.prefix,
        options.inputTokens,
      );
    },
    expectCancellation(reason: string) {
      if (state !== "pending")
        throw new Error("Cancellation expectation must precede request completion");
      expectedCancellation = z.string().min(1).parse(reason);
    },
    reject() {
      finish({ kind: "failed" });
      response.destroy();
    },
    close() {
      if (state === "responded" && !stepFinished && !controller.signal.aborted)
        fail(
          new ScriptedProviderError(
            "step_cancelled",
            `Closed unfinished model step: Agent ${agent.summary.name} (${agent.summary.id}), session ${agent.summary.sessionId}, step ${step}, request ${JSON.stringify(payload)}`,
          ),
        );
      finish({ kind: "closed" });
      controller.abort(new Error(`Model step closed: ${step}`));
      clearTimeout(timer);
      response.destroy();
    },
  };
}

/** Only the model output is scripted; the caller supplies real HTTP requests from Pi. */
export function createScriptedProvider(options: { timeoutMs?: number } = {}) {
  const scripts = new Map<string, { agent: PreparedScenarioAgent; steps: ModelStep[] }>();
  const requests: ScriptedRequest[] = [];
  const errors: ScriptedProviderError[] = [];
  const changes = new Set<() => void>();
  const timeoutMs = z
    .number()
    .int()
    .positive()
    .parse(options.timeoutMs ?? 5000);
  let closed = false;
  const fail = (error: ScriptedProviderError) => {
    errors.push(error);
    for (const change of [...changes]) change();
  };
  return {
    requests,
    errors,
    forAgent(agent: PreparedScenarioAgent, steps: ModelStep[]) {
      if (closed) throw new Error("Scripted provider is closed");
      if (new Set(steps.map((step) => step.name)).size !== steps.length)
        throw new Error("Model step names must be unique within an Agent script");
      if (scripts.has(agent.summary.sessionId)) throw new Error("Agent script already registered");
      if (steps.some((step) => !step.name)) throw new Error("Model steps must be named functions");
      scripts.set(agent.summary.sessionId, { agent, steps: [...steps] });
    },
    async handle(input: ProviderRequest, response: ServerResponse) {
      const sessionId = response.req.url?.match(/\/session\/([^/]+)\//)?.[1];
      const script = sessionId ? scripts.get(sessionId) : undefined;
      const description = `Agent ${script ? `${script.agent.summary.name} (${script.agent.summary.id})` : "<unregistered>"}, session ${sessionId ?? "<missing>"}`;
      const rejectRequest = (code: z.output<typeof failureCodeSchema>, step: string) => {
        const error = new ScriptedProviderError(
          code,
          `${code}: ${description}, step ${step}, request ${JSON.stringify(input)}`,
        );
        fail(error);
        response.destroy();
        return error;
      };
      if (closed) throw rejectRequest("late_request", "<closed>");
      if (!script || input.model !== script.agent.summary.model.id)
        throw rejectRequest("unexpected_request", script?.steps[0]?.name ?? "<unregistered>");
      if (
        requests.some((request) => request.sessionId === sessionId && request.state === "pending")
      )
        throw rejectRequest("unexpected_request", script.steps[0]?.name ?? "<pending>");
      const step = script.steps.shift();
      if (!step) throw rejectRequest("script_exhausted", "<exhausted>");
      const request = createRequest(
        requestSchema.parse(input),
        response,
        script.agent,
        step.name,
        timeoutMs,
        fail,
      );
      requests.push(request);
      for (const change of [...changes]) change();
      let resolveAbort!: () => void;
      const aborted = new Promise<void>((resolve) => {
        resolveAbort = resolve;
      });
      request.signal.addEventListener("abort", resolveAbort, { once: true });
      const execution = Promise.resolve()
        .then(() => step(request))
        .catch((error: unknown) => {
          if (request.signal.aborted && error === request.signal.reason) return;
          fail(
            new ScriptedProviderError(
              "step_failed",
              `${description}, step ${step.name}: ${String(error)}; request ${JSON.stringify(input)}`,
              { cause: error },
            ),
          );
          request.reject();
        });
      try {
        await Promise.race([execution, aborted]);
      } finally {
        request.signal.removeEventListener("abort", resolveAbort);
        request.finishStep();
      }
    },
    waitFor(agentId: string, step: string, waitMs = timeoutMs): Promise<ScriptedRequest> {
      z.number().int().positive().parse(waitMs);
      return new Promise((resolve, reject) => {
        const check = () => {
          const request = requests.find((item) => item.agentId === agentId && item.step === step);
          if (request || errors[0] || closed) {
            clearTimeout(timer);
            changes.delete(check);
            if (request) resolve(request);
            else
              reject(
                errors[0] ??
                  new ScriptedProviderError(
                    "provider_closed",
                    `Provider closed while waiting for Agent ${agentId}, step ${step}`,
                  ),
              );
          }
        };
        const timer = setTimeout(() => {
          changes.delete(check);
          const error = new ScriptedProviderError(
            "wait_timeout",
            `Timed out waiting for Agent ${agentId}, step ${step}; actual request ${JSON.stringify(requests.filter((item) => item.agentId === agentId).at(-1)?.payload ?? null)}`,
          );
          fail(error);
          reject(error);
        }, waitMs);
        changes.add(check);
        check();
      });
    },
    async assertComplete() {
      let observed = -1;
      while (observed !== requests.length) {
        observed = requests.length;
        await Promise.all(requests.map((request) => request.finished));
      }
      if (errors[0]) throw errors[0];
      if (
        requests.some((request) => request.state === "pending") ||
        [...scripts.values()].some((script) => script.steps.length)
      )
        throw new Error("Scripted provider has unfinished steps or requests");
    },
    close() {
      closed = true;
      for (const request of requests)
        if (request.state === "pending" || !request.stepFinished) request.close();
      for (const change of [...changes]) change();
    },
  };
}
