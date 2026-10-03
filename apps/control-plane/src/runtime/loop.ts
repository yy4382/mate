import { projectImages } from "./session/image-context.js";
import { WorkspaceImage } from "../workspaces/image-result.js";
import { z } from "zod";
import {
  confirmedModelResponse,
  inspectProviderResponse,
  reportedGoogleUsage,
} from "./provider-response.js";
import {
  buildAgentSystemPrompt,
  runNoticeMessage,
  runRecoveryMessage,
  contextRecoveryMessage,
  type AgentProfile,
} from "../prompts/index.js";
import {
  type SessionCommit,
  type ModelContextMessage,
  type ReportedUsage,
} from "./session/record.js";
import { durableToolIdentity } from "./tools/identity.js";
import { randomUUID } from "node:crypto";
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  Type,
  validateToolCall,
  type Model,
  type Api,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { SessionCompaction, SummaryResponseError } from "./session/compaction.js";

export interface AgentLoopSpec {
  sessionId: string;
  actionScopeId: string;
  messages: ModelContextMessage[];
  prompt: AgentProfile;
  provider: string;
  modelId: string;
  apiKey: string;
}
/** Fault injection at persistence boundaries, and a local HTTP provider in integration tests. */
export interface AgentLoopTestDependencies {
  modelForRun?: (
    model: Model<Api>,
    apiKey: string,
    session: { readonly sessionId: string },
  ) => Model<Api>;
  beforeSessionCommit?: (entry: SessionCommit) => Promise<void>;
  afterSessionCommit?: (entry: SessionCommit) => Promise<void>;
  beforeRunFinish?: () => Promise<void>;
  beforeRunStart?: (runId: string) => Promise<void>;
  afterToolCallDelta?: (delta: { sessionId: string; toolCallId: string; delta: string }) => void;
}
export type AgentLoopResult = { ok: true } | { ok: false; code: string; reason?: string };

/** The transient Pi handle only advances the durable session owned by the control plane. */
export class AgentLoop {
  private agent: Agent | undefined;
  private readonly controller = new AbortController();
  private readonly notices: string[] = [];
  cancel(): void {
    this.controller.abort();
    this.agent?.abort();
  }
  notice(conversationId: string): void {
    if (this.controller.signal.aborted) return;
    if (this.agent) this.agent.steer(runNoticeMessage(conversationId));
    else this.notices.push(conversationId);
  }
  async run(
    spec: AgentLoopSpec,
    current: () => boolean,
    append: (entry: SessionCommit) => boolean,
    execute: (
      toolCallId: string,
      operation: string,
      input: Record<string, unknown>,
    ) => Promise<{ ok: true; result: unknown } | { ok: false; error: string }>,
    test: AgentLoopTestDependencies = {},
  ): Promise<AgentLoopResult> {
    const assertCurrent = () => {
      if (this.controller.signal.aborted || !current())
        throw new Error("Agent run is no longer current");
    };
    const registry = builtinModels();
    const selected = registry.getModel(spec.provider, spec.modelId);
    if (!selected) return { ok: false, code: "model_unavailable" };
    const model =
        test.modelForRun?.(selected, spec.apiKey, { sessionId: spec.sessionId }) ?? selected,
      apiKey = spec.apiKey;
    let credentialResponse = false;
    const stream: StreamFn = (model, context, options) => {
      assertCurrent();
      const fetchRequest = options?.fetch ?? fetch;
      return registry.streamSimple(model, context, {
        ...options,
        ...(model.api === "google-generative-ai" || model.api === "google-vertex"
          ? {}
          : {
              fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
                const response = await fetchRequest(input, init);
                // SDKs may reject HTTP errors before invoking Pi's onResponse callback.
                if (response.status === 401 || response.status === 403) credentialResponse = true;
                return response;
              },
            }),
        onResponse: async (response, selectedModel) => {
          if (response.status === 401 || response.status === 403) credentialResponse = true;
          await options?.onResponse?.(response, selectedModel);
        },
      });
    };
    const transcript = spec.messages
      .filter((entry) => !entry.pending)
      .map((entry) => entry.message);
    let assistantIdentity = "",
      actionScopeId = spec.actionScopeId;
    const commit = async (entry: SessionCommit) => {
      assertCurrent();
      await test.beforeSessionCommit?.(entry);
      assertCurrent();
      if (!append(entry)) throw new Error("Session persistence rejected the entry");
      await test.afterSessionCommit?.(entry);
      assertCurrent();
    };
    const compaction = new SessionCompaction(
      spec.messages.filter((entry) => !entry.pending),
      model,
      apiKey,
      stream,
      commit,
    );
    const forwardTool = async (
      toolCallId: string,
      operation: string,
      input: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<unknown> => {
      assertCurrent();
      if (signal?.aborted) throw new Error("Tool call aborted");
      const result = await execute(
        durableToolIdentity(actionScopeId, assistantIdentity, toolCallId),
        operation,
        input,
      );
      assertCurrent();
      if (!result.ok) throw new Error(result.error);
      return result.result;
    };
    const toolInputSchema = z.record(z.string(), z.unknown());
    const tools: AgentTool[] = [
      {
        name: "tools.list",
        label: "List Mate tools",
        description: "Discover conversation tools available to this Agent run.",
        parameters: Type.Object({}),
        executionMode: "sequential",
        execute: async (toolCallId, _input, signal) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(await forwardTool(toolCallId, "tools.list", {}, signal)),
            },
          ],
          details: null,
        }),
      },
      {
        name: "tools.describe",
        label: "Describe Mate tool",
        description: "Get the exact input schema and permissions for one Mate tool.",
        parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 128 }) }),
        executionMode: "sequential",
        execute: async (toolCallId, input, signal) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                await forwardTool(
                  toolCallId,
                  "tools.describe",
                  toolInputSchema.parse(input),
                  signal,
                ),
              ),
            },
          ],
          details: null,
        }),
      },
      {
        name: "tools.call",
        label: "Call Mate tool",
        description: "Call a discovered Mate conversation tool with an explicit target.",
        parameters: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 128 }),
          input: Type.Record(Type.String(), Type.Any()),
        }),
        executionMode: "sequential",
        execute: async (toolCallId, input, signal) => {
          const parsed = toolInputSchema.parse(input);
          const result = await forwardTool(toolCallId, "tools.call", parsed, signal);
          return {
            content:
              parsed.name === "workspace.read" && result instanceof WorkspaceImage
                ? result.content(model.input.includes("image"))
                : [{ type: "text", text: JSON.stringify(result) }],
            details: null,
          };
        },
      },
    ];
    let compactionFailed = false;
    let compactionError: string | undefined;
    let inspectedNormalUsage:
      Promise<{ usage: ReportedUsage; complete: boolean } | null> | undefined;
    let normalRequestPending = false;
    const agent = new Agent({
      sessionId: spec.sessionId,
      onResponse: (response) => {
        if (response.status === 401 || response.status === 403) credentialResponse = true;
      },
      streamFn: (selectedModel, context, options) => {
        assertCurrent();
        normalRequestPending = true;
        inspectedNormalUsage = undefined;
        return stream(selectedModel, context, {
          ...options,
          apiKey,
          env: {},
          ...(selectedModel.api === "google-generative-ai" || selectedModel.api === "google-vertex"
            ? {}
            : {
                fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
                  const response = await fetch(input, init);
                  inspectedNormalUsage = inspectProviderResponse(response, selectedModel.api);
                  return response;
                },
              }),
        });
      },
      transformContext: async (messages, signal) => {
        try {
          return projectImages(
            await compaction.transform(messages, signal),
            model.input.includes("image"),
          );
        } catch (error) {
          if (
            error instanceof SummaryResponseError &&
            error.response.errorMessage &&
            providerCredentialError(error.response.errorMessage)
          )
            credentialResponse = true;
          compactionFailed = true;
          compactionError = error instanceof Error ? error.message : String(error);
          throw error;
        }
      },
      initialState: {
        model,
        systemPrompt: buildAgentSystemPrompt(spec.prompt).systemPrompt,
        tools,
        messages: transcript,
      },
      toolExecution: "sequential",
    });
    this.agent = agent;
    for (const conversationId of this.notices.splice(0))
      agent.steer(runNoticeMessage(conversationId));
    const abort = () => agent.abort();
    this.controller.signal.addEventListener("abort", abort, { once: true });
    let unsuccessfulStopReason: "error" | "aborted" | undefined;
    let contextOverflow = false;
    const unsubscribe = agent.subscribe(async (event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "toolcall_delta"
      ) {
        const update = event.assistantMessageEvent;
        const call = update.partial.content[update.contentIndex];
        if (call?.type === "toolCall")
          test.afterToolCallDelta?.({
            sessionId: spec.sessionId,
            toolCallId: call.id,
            delta: update.delta,
          });
      }
      if (event.type !== "message_end") return;
      if (
        event.message.role !== "user" &&
        event.message.role !== "assistant" &&
        event.message.role !== "toolResult"
      )
        return;
      assertCurrent();
      const id = randomUUID();
      const assistant = event.message.role === "assistant" ? event.message : null;
      const isGoogle =
        assistant?.api === "google-generative-ai" || assistant?.api === "google-vertex";
      const inspected =
        assistant && normalRequestPending ? ((await inspectedNormalUsage) ?? null) : null;
      const modelRequest =
        !!assistant &&
        normalRequestPending &&
        confirmedModelResponse(assistant, inspected?.usage ?? null, inspected?.complete ?? false);
      const usage = modelRequest
        ? (inspected?.usage ?? (isGoogle ? reportedGoogleUsage(assistant) : null))
        : null;
      if (assistant && normalRequestPending) {
        normalRequestPending = false;
        inspectedNormalUsage = undefined;
      }
      assertCurrent();
      if (assistant && (assistant.stopReason === "error" || assistant.stopReason === "aborted")) {
        if (assistant.errorMessage && providerCredentialError(assistant.errorMessage))
          credentialResponse = true;
        unsuccessfulStopReason = assistant.stopReason;
        contextOverflow = isContextOverflow(assistant.errorMessage);
        if (!modelRequest) return;
      }
      await commit({
        kind: "message",
        id,
        message: event.message,
        ...(modelRequest ? { modelRequest: true, reportedUsage: usage } : {}),
      });
      compaction.record(id, event.message);
      if (event.message.role === "assistant") {
        assistantIdentity = id;
        actionScopeId = spec.actionScopeId;
        if (event.message.stopReason === "error" || event.message.stopReason === "aborted")
          unsuccessfulStopReason = event.message.stopReason;
        if (event.message.stopReason === "error" && isContextOverflow(event.message.errorMessage))
          contextOverflow = true;
      }
    });

    try {
      assertCurrent();
      await commit({
        kind: "configuration",
        id: randomUUID(),
        configuration: {
          provider: model.provider,
          modelId: model.id,
          systemPrompt: agent.state.systemPrompt,
          tools: tools.map(({ name, description, parameters }) =>
            JSON.parse(JSON.stringify({ name, description, parameters })),
          ),
          piAgentVersion: "1.0.0",
          piAiVersion: "1.0.0",
          formatVersion: 1,
        },
      });
      // Resume only calls whose assistant message was durably accepted. Their operation identity
      // survives control-plane and node restarts; brokers return existing receipts instead of rerunning effects.
      for (const [entryIndex, entry] of spec.messages.entries()) {
        if (
          entry.message.role !== "assistant" ||
          (entry.message.stopReason !== "toolUse" && entry.message.stopReason !== "length")
        )
          continue;
        const following = spec.messages.slice(entryIndex + 1);
        const nextAssistant = following.findIndex((item) => item.message.role === "assistant");
        const results = following.slice(0, nextAssistant < 0 ? undefined : nextAssistant);
        for (const call of entry.message.content) {
          if (
            call.type !== "toolCall" ||
            results.some(
              (item) => item.message.role === "toolResult" && item.message.toolCallId === call.id,
            )
          )
            continue;
          assistantIdentity = entry.id;
          actionScopeId = entry.actionScopeId;
          let content: ToolResultMessage["content"],
            isError = false;
          try {
            if (entry.message.stopReason === "length")
              throw new Error("Tool call was not executed because the model output was truncated");
            const tool = tools.find((candidate) => candidate.name === call.name);
            if (!tool) throw new Error(`Tool ${call.name} not found`);
            const input = validateToolCall(tools, call);
            const result = await tool.execute(call.id, input);
            content = result.content;
          } catch (error) {
            isError = true;
            content = [
              { type: "text", text: error instanceof Error ? error.message : String(error) },
            ];
          }
          const message = {
            role: "toolResult" as const,
            toolCallId: call.id,
            toolName: call.name,
            content,
            details: null,
            isError,
            timestamp: Date.now(),
          };
          const id = randomUUID();
          await commit({ kind: "message", id, message });
          compaction.record(id, message);
          agent.state.messages = [...agent.state.messages, message];
        }
      }
      for (const entry of spec.messages.filter((entry) => entry.pending)) {
        await commit({ kind: "message", id: entry.id, message: entry.message });
        compaction.record(entry.id, entry.message);
        agent.state.messages = [...agent.state.messages, entry.message];
      }
      const last = agent.state.messages.at(-1);
      if (
        last?.role === "assistant" &&
        (last.stopReason === "error" || last.stopReason === "aborted")
      ) {
        const message = runRecoveryMessage();
        const id = randomUUID();
        await commit({ kind: "message", id, message });
        compaction.record(id, message);
        agent.state.messages = [...agent.state.messages, message];
      }
      // A completed silent/final response followed by a lost run completion commit needs no new generation.
      if (agent.state.messages.at(-1)?.role !== "assistant") {
        await agent.continue();
        if (contextOverflow) {
          const message = contextRecoveryMessage();
          const id = randomUUID();
          await commit({ kind: "message", id, message });
          compaction.record(id, message);
          agent.state.messages = [...agent.state.messages, message];
          compaction.forceAfterOverflow();
          unsuccessfulStopReason = undefined;
          contextOverflow = false;
          await agent.continue();
          if (contextOverflow) compactionFailed = true;
        }
      }
      if (unsuccessfulStopReason) throw new Error("The model returned an unsuccessful result");
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        code: this.controller.signal.aborted
          ? "aborted"
          : credentialResponse
            ? "credentials_invalid"
            : compactionFailed
              ? "context_failed"
              : "model_failed",
        ...(compactionFailed
          ? {
              reason: (
                compactionError ?? (error instanceof Error ? error.message : String(error))
              ).slice(0, 240),
            }
          : {}),
      };
    } finally {
      this.controller.signal.removeEventListener("abort", abort);
      this.agent = undefined;
      unsubscribe();
    }
  }
}
function isContextOverflow(message: string | undefined): boolean {
  return Boolean(
    message &&
    /context[_ -]length[_ -]exceeded|context window|maximum context length|prompt is too long|too many (input )?tokens/i.test(
      message,
    ),
  );
}
function providerCredentialError(message: string): boolean {
  // Google SDK keeps its JSON error body; Pi also formats normalized HTTP failures
  // as "<status>: <body>". Neither case depends on the provider's message prose.
  if (/^(401|403):\s/.test(message)) return true;
  try {
    const error = JSON.parse(message);
    const status = error.error?.code ?? error.status;
    return status === 401 || status === 403;
  } catch {
    return false;
  }
}
