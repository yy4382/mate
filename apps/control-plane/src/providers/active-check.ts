import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  Type,
  type Api,
  type Model,
  type Context,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
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
    "additional_tool_call",
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

const responseEventSchema = z.record(z.string(), z.unknown());

/** A completed decline needs a normal terminal event, rather than a terminal provider error. */
function normalDeclineTermination(body: string, api: Api) {
  let terminal = false;
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const lines = frame.split(/\r?\n/);
    if (lines.some((line) => /^event:\s*(error|response\.failed)\s*$/.test(line))) return false;
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) continue;
    if (data === "[DONE]") {
      if (api === "openai-completions") terminal = true;
      continue;
    }
    try {
      const event = responseEventSchema.parse(JSON.parse(data));
      if (
        event.type === "error" ||
        event.type === "response.failed" ||
        (event.error !== undefined && event.error !== null)
      )
        return false;
      if (api === "anthropic-messages" && event.type === "message_stop") terminal = true;
    } catch {
      return false;
    }
  }
  return terminal;
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
  let callId = "";
  let announcedCallId = "";
  let callCount = 0;
  let executionCount = 0;
  let continuationCalls = false;
  let timedOut = false;
  let completeResponse = Promise.resolve(false);
  const controller = new AbortController();
  const context: Context = {
    systemPrompt:
      "You are checking provider transport and tool protocol. Follow only the short check instructions.",
    messages: [],
  };
  const streamCheckResponse = () => {
    completeResponse = Promise.resolve(false);
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
      signal: controller.signal,
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
              // Inspect terminal evidence transiently; no body is retained in the report or on disk.
              completeResponse = response
                .clone()
                .text()
                .then((body) => normalDeclineTermination(body, model.api))
                .catch(() => false);
              return response;
            },
          }),
    });
  };
  const observeCheckResponse = async (message: AssistantMessage) => {
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      // Pi normalizes these completed model-decline outcomes to error. They do not prove
      // broken transport; classify only the structured terminal reason, never error prose.
      const nativeReason = message.rawStopReason ?? "";
      const httpDeclined =
        ["refusal", "sensitive", "content_filter"].includes(nativeReason) &&
        report.httpStatus !== null &&
        report.httpStatus >= 200 &&
        report.httpStatus < 300 &&
        (await completeResponse);
      // Pi's Google adapter does not expose fetch. In pinned Pi 1.1.0 this exact adapter-generated
      // diagnostic is emitted only after SDK stream iteration finishes, distinct from SDK/parse errors.
      // Require both the structured content-decline reason and that completion diagnostic.
      const googleDeclined =
        (message.api === "google-generative-ai" || message.api === "google-vertex") &&
        [
          "SAFETY",
          "BLOCKLIST",
          "PROHIBITED_CONTENT",
          "SPII",
          "RECITATION",
          "IMAGE_SAFETY",
          "IMAGE_PROHIBITED_CONTENT",
          "IMAGE_RECITATION",
        ].includes(nativeReason) &&
        message.errorMessage === `Provider stopped with: ${nativeReason}`;
      const declined = httpDeclined || googleDeclined;
      report.status = declined ? "unverified" : "failed";
      report.reason = declined ? "model_declined" : "provider_error";
    }
    if (report.stage === "text") report.observed.textCompleted = message.stopReason === "stop";
    if (report.stage === "tool") {
      const calls = message.content.filter((content) => content.type === "toolCall");
      callCount = calls.length;
      announcedCallId = calls[0]?.id ?? "";
    }
    if (report.stage === "continuation") {
      continuationCalls = message.content.some((content) => content.type === "toolCall");
      report.observed.continuationCompleted = message.stopReason === "stop";
      report.observed.toolResultAcknowledged = message.content.some(
        (content) => content.type === "text" && content.text.includes(marker),
      );
    }
  };
  const turn = async (prompt?: string) => {
    if (prompt !== undefined)
      context.messages.push({ role: "user", content: prompt, timestamp: Date.now() });
    const stream = streamCheckResponse();
    for await (const event of stream) {
      if (report.stage === "text" && event.type === "text_delta" && event.delta.length > 0)
        report.observed.textStream = true;
    }
    const message = await stream.result();
    await observeCheckResponse(message);
    context.messages.push(message);
    return message;
  };
  const cancel = () => controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
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
    await turn("Reply with a brief greeting, using a short text response.");
    if (failedOrCancelled()) return report;
    if (!report.observed.textStream || !report.observed.textCompleted) {
      report.reason = "text_not_observed";
      return report;
    }
    report.stage = "tool";
    report.httpStatus = null;
    context.tools = [
      {
        name: "mate_protocol_probe",
        description:
          "Return a temporary marker. No files, commands, network or external side effects.",
        parameters: Type.Object({}),
      },
    ];
    const toolResponse = await turn(
      "Call mate_protocol_probe exactly once with no arguments. After receiving its result, reply briefly with that exact marker.",
    );
    if (failedOrCancelled()) return report;
    const call = toolResponse.content.find((content) => content.type === "toolCall");
    if (
      toolResponse.stopReason === "toolUse" &&
      callCount === 1 &&
      call?.type === "toolCall" &&
      call.name === "mate_protocol_probe" &&
      z.strictObject({}).safeParse(call.arguments).success
    ) {
      callId = call.id;
      executionCount = 1;
      report.observed.toolExecuted = true;
      context.messages.push({
        role: "toolResult",
        toolCallId: callId,
        toolName: "mate_protocol_probe",
        content: [{ type: "text", text: marker }],
        isError: false,
        timestamp: Date.now(),
      });
    }
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
    // Keep it declared to test association; this final request never executes another probe call.
    report.stage = "continuation";
    report.httpStatus = null;
    await turn();
    if (failedOrCancelled()) return report;
    if (!report.observed.toolCallAssociated) {
      report.status = "failed";
      report.reason = "tool_call_not_associated";
    } else if (continuationCalls || executionCount !== 1) report.reason = "additional_tool_call";
    else if (!report.observed.continuationCompleted || !report.observed.toolResultAcknowledged)
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
  }
}
