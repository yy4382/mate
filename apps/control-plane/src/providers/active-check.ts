import { z } from "zod";
import { randomUUID } from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type, type Api, type Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { isSupportedModel } from "./catalog.js";

const selectionSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  apiKey: z.string().trim().optional(),
  timeoutMs: z.number().int().positive().max(300_000).default(30_000),
});

const reportSchema = z.object({
  provider: z.string(),
  modelId: z.string(),
  connection: z.enum(["real", "synthetic"]),
  status: z.enum(["passed", "unverified", "failed"]),
  reason: z.enum([
    "protocol_verified",
    "credential_missing",
    "model_unavailable",
    "text_not_observed",
    "tool_not_observed",
    "tool_call_not_associated",
    "tool_result_not_acknowledged",
    "provider_error",
    "model_declined",
    "owner_cancelled",
    "timeout",
  ]),
  stage: z.enum(["configuration", "text", "tool", "continuation"]),
  httpStatus: z.number().int().nullable(),
  observed: z.object({
    textStream: z.boolean(),
    textCompleted: z.boolean(),
    toolExecuted: z.boolean(),
    toolCallAssociated: z.boolean(),
    continuationCompleted: z.boolean(),
    toolResultAcknowledged: z.boolean(),
  }),
});

/** Only test code redirects the real Pi adapter to a synthetic HTTP service. */
export interface ProviderCheckTestDependencies {
  modelForCheck: (model: Model<Api>) => Model<Api>;
}

/** An explicit, transient transport probe. It owns no Mate Agent, node or persistent session. */
export async function checkProviderProtocol(
  input: z.input<typeof selectionSchema> & { signal?: AbortSignal },
  test?: ProviderCheckTestDependencies,
) {
  const selection = selectionSchema.parse(input);
  const report = reportSchema.parse({
    provider: selection.provider,
    modelId: selection.modelId,
    connection: test ? "synthetic" : "real",
    status: "unverified",
    reason: "credential_missing",
    stage: "configuration",
    httpStatus: null,
    observed: {
      textStream: false,
      textCompleted: false,
      toolExecuted: false,
      toolCallAssociated: false,
      continuationCompleted: false,
      toolResultAcknowledged: false,
    },
  });
  if (!selection.apiKey) return report;
  const apiKey = selection.apiKey;
  const registry = builtinModels();
  const selected = registry.getModel(selection.provider, selection.modelId);
  if (!selected || !isSupportedModel(selection.provider, selection.modelId)) {
    report.reason = "model_unavailable";
    return report;
  }
  const model = test?.modelForCheck(selected) ?? selected;
  const marker = `mate-probe-${randomUUID()}`;
  let callId = "",
    announcedCallId = "",
    callCount = 0,
    executionCount = 0,
    timedOut = false;
  const agent = new Agent({
    initialState: {
      model,
      systemPrompt:
        "You are checking provider transport and tool protocol. Follow only the short check instructions.",
    },
    // Each probe phase is one explicit Pi turn, with one result continuation requested below.
    shouldStopAfterTurn: () => true,
    streamFn: (model, context, options) => {
      if (report.stage === "continuation") {
        report.observed.toolCallAssociated = context.messages.some(
          (message) =>
            message.role === "toolResult" &&
            callId.length > 0 &&
            callId === announcedCallId &&
            message.toolCallId === callId &&
            message.toolName === "mate_protocol_probe" &&
            !message.isError &&
            message.content.some((content) => content.type === "text" && content.text === marker),
        );
      }
      return registry.streamSimple(model, context, {
        ...options,
        apiKey,
        env: {},
        transport: "sse",
        maxRetries: 0,
        timeoutMs: selection.timeoutMs,
        onResponse: (response) => {
          report.httpStatus = response.status;
        },
        ...(model.api === "google-generative-ai" || model.api === "google-vertex"
          ? {}
          : {
              fetch: async (request: RequestInfo | URL, init?: RequestInit) => {
                const response = await fetch(request, init);
                report.httpStatus = response.status;
                return response;
              },
            }),
      });
    },
  });
  const unsubscribe = agent.subscribe((event) => {
    if (
      event.type === "message_update" &&
      report.stage === "text" &&
      event.assistantMessageEvent.type === "text_delta" &&
      event.assistantMessageEvent.delta.length > 0
    )
      report.observed.textStream = true;
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
      // Pi normalizes these completed model-decline outcomes to error. They do not prove
      // broken transport; classify only the structured terminal reason, never error prose.
      const declined = ["refusal", "sensitive", "content_filter"].includes(
        event.message.rawStopReason ?? "",
      );
      report.status = declined ? "unverified" : "failed";
      report.reason = declined ? "model_declined" : "provider_error";
    }
    if (report.stage === "text")
      report.observed.textCompleted = event.message.stopReason === "stop";
    if (report.stage === "tool") {
      const calls = event.message.content.filter((content) => content.type === "toolCall");
      callCount = calls.length;
      announcedCallId = calls[0]?.id ?? "";
    }
    if (report.stage === "continuation") {
      report.observed.continuationCompleted = event.message.stopReason === "stop";
      report.observed.toolResultAcknowledged = event.message.content.some(
        (content) => content.type === "text" && content.text.includes(marker),
      );
    }
  });
  const cancel = () => agent.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    agent.abort();
  }, selection.timeoutMs);
  input.signal?.addEventListener("abort", cancel, { once: true });
  const failedOrCancelled = () => {
    if (timedOut || input.signal?.aborted) {
      report.status = "unverified";
      report.reason = timedOut ? "timeout" : "owner_cancelled";
      return true;
    }
    return report.status === "failed" || report.reason === "model_declined";
  };
  try {
    if (failedOrCancelled()) return report;
    report.stage = "text";
    await agent.prompt("Reply with a brief greeting, using a short text response.");
    if (failedOrCancelled()) return report;
    if (!report.observed.textStream || !report.observed.textCompleted) {
      report.reason = "text_not_observed";
      return report;
    }
    report.stage = "tool";
    report.httpStatus = null;
    agent.state.tools = [
      {
        name: "mate_protocol_probe",
        label: "Harmless protocol check",
        description:
          "Return a temporary marker. No files, commands, network or external side effects.",
        parameters: Type.Object({}),
        execute: async (id) => {
          executionCount++;
          if (executionCount !== 1) throw new Error("The probe requires one tool call");
          callId = id;
          report.observed.toolExecuted = true;
          return { content: [{ type: "text", text: marker }], details: null };
        },
      },
    ];
    await agent.prompt(
      "Call mate_protocol_probe exactly once with no arguments. After receiving its result, reply briefly with that exact marker.",
    );
    if (failedOrCancelled()) return report;
    if (executionCount !== 1 || callCount !== 1) {
      report.reason = "tool_not_observed";
      return report;
    }
    if (!callId || callId !== announcedCallId) {
      report.status = "failed";
      report.reason = "tool_call_not_associated";
      return report;
    }
    // Some adapters require the matching tool declaration with tool-use/result history.
    // Keep it declared; the one-turn stop and execute guard still prevent another probe effect.
    report.stage = "continuation";
    report.httpStatus = null;
    await agent.continue();
    if (failedOrCancelled()) return report;
    if (!report.observed.toolCallAssociated) {
      report.status = "failed";
      report.reason = "tool_call_not_associated";
    } else if (!report.observed.continuationCompleted || !report.observed.toolResultAcknowledged)
      report.reason = "tool_result_not_acknowledged";
    else {
      report.status = "passed";
      report.reason = "protocol_verified";
    }
    return report;
  } catch {
    if (!failedOrCancelled()) {
      report.status = "failed";
      report.reason = "provider_error";
    }
    return report;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", cancel);
    unsubscribe();
    agent.reset();
  }
}
