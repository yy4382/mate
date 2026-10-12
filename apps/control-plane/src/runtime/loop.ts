import { chmodSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
  Harness,
  createRegistry,
  defineTool,
  defineDoc,
  type StorageWrite,
  type Storage,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  Type,
  type Model,
  type Api,
  type Models,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { z } from "zod";
import { WorkspaceImage } from "../workspaces/reads/image-result.js";
import { buildAgentSystemPrompt, runNoticeMessage, type AgentProfile } from "../prompts/index.js";
import { type ModelContextMessage } from "./session/input.js";
import { runtimeVersions } from "./build-identity.js";
import { UsageObservations } from "./usage-observation.js";
import {
  inspectProviderResponse,
  reportedGoogleUsage,
  confirmedModelResponse,
  restoreFailedUsage,
} from "./provider-response.js";
import { projectImages } from "./session/image-context.js";
import type { AgentToolCallResult } from "./tools/registry.js";

const admissionDoc = defineDoc({
  kind: "mate.admission",
  version: 1,
  scope: "session",
  initial: () => ({ sessionId: "", configuration: "", runtimeVersions }),
});

export interface AgentLoopSpec {
  initialized: boolean;
  initializedNow(): void;
  inputAccepted(deliveryId: string, submissionId: number): void;
  sessionId: string;
  storagePath: string;
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
  beforeDurableCommit?: (writes: readonly StorageWrite[]) => Promise<void>;
  afterDurableCommit?: (writes: readonly StorageWrite[]) => Promise<void>;
  afterInputAccepted?: (requestId: string) => Promise<void>;
  beforeRunFinish?: () => Promise<void>;
  beforeRunStart?: (runId: string) => Promise<void>;
  afterToolCallDelta?: (delta: { sessionId: string; toolCallId: string; delta: string }) => void;
}
export type AgentLoopResult = { ok: true } | { ok: false; code: string; reason?: string };
export interface AgentLoopActions {
  isCurrent(): boolean;
  bindTool(taskId: string, operation: string, input: Record<string, unknown>): string;
  executeTool(request: {
    toolCallId: string;
    operation: string;
    input: Record<string, unknown>;
  }): Promise<AgentToolCallResult>;
}

/** One owned Harness advances the Agent's original SQLite conversation, then closes before admission is released. */
export class AgentLoop {
  private harness: Harness | undefined;
  private sendNotice: ((conversationId: string, deliveryId: string) => Promise<void>) | undefined;
  private readonly controller = new AbortController();
  private readonly notices: { conversationId: string; deliveryId: string }[] = [];
  async whileCurrent<T>(work: Promise<T>): Promise<T> {
    const signal = this.controller.signal;
    signal.throwIfAborted();
    let listener = () => {};
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          listener = () => reject(signal.reason);
          signal.addEventListener("abort", listener, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", listener);
    }
  }
  cancel(): void {
    this.controller.abort();
    // Close cancels invocations without withdrawing the durable inbox.
    void this.harness?.close(BACKGROUND_CONTEXT).catch(() => {});
  }
  notice(conversationId: string, deliveryId = conversationId): void {
    if (this.controller.signal.aborted) return;
    if (this.sendNotice) void this.sendNotice(conversationId, deliveryId).catch(() => {});
    else this.notices.push({ conversationId, deliveryId });
  }

  async run(
    spec: AgentLoopSpec,
    actions: AgentLoopActions,
    test: AgentLoopTestDependencies = {},
  ): Promise<AgentLoopResult> {
    const assertCurrent = () => {
      if (this.controller.signal.aborted || !actions.isCurrent())
        throw new Error("Agent run is no longer current");
    };
    const catalog = builtinModels();
    const selected = catalog.getModel(spec.provider, spec.modelId);
    if (!selected) return { ok: false, code: "model_unavailable" };
    const model =
      test.modelForRun?.(selected, spec.apiKey, { sessionId: spec.sessionId }) ?? selected;
    let credentialResponse = false;
    let storageFailed = false;
    let canAdvance = false;
    const assertAdvancing = () => {
      assertCurrent();
      if (!canAdvance) throw new Error("Agent admission is reconciling");
    };
    const observations = new UsageObservations();
    const streamModel = (
      requested: Model<Api>,
      context: Parameters<Models["streamSimple"]>[1],
      options: SimpleStreamOptions | undefined,
      summary = false,
    ) => {
      assertAdvancing();
      let inspection: ReturnType<typeof inspectProviderResponse> = Promise.resolve(null);
      const stream = catalog.streamSimple(
        requested,
        {
          ...context,
          messages: projectImages(context.messages, requested.input.includes("image")),
        },
        {
          ...options,
          apiKey: spec.apiKey,
          env: {},
          onResponse: async (response, currentModel) => {
            if (response.status === 401 || response.status === 403) credentialResponse = true;
            await options?.onResponse?.(response, currentModel);
          },
          ...(requested.api === "google-generative-ai" || requested.api === "google-vertex"
            ? {}
            : {
                fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
                  assertAdvancing();
                  const response = await fetch(input, init);
                  if (response.status === 401 || response.status === 403) credentialResponse = true;
                  inspection = inspectProviderResponse(response, requested.api);
                  return response;
                },
              }),
        },
      );
      const result = stream.result.bind(stream);
      const observed = result().then(async (message) => {
        const inspected = await inspection;
        const reported =
          requested.api === "google-generative-ai" || requested.api === "google-vertex"
            ? reportedGoogleUsage(message)
            : (inspected?.usage ?? null);
        restoreFailedUsage(message, reported, inspected?.complete ?? false, requested);
        observations.capture(
          message,
          reported,
          confirmedModelResponse(message, reported, inspected?.complete),
          summary,
        );
        return message;
      });
      stream.result = () => observed;
      if (test.afterToolCallDelta) {
        const push = stream.push.bind(stream);
        stream.push = (event) => {
          push(event);
          if (event.type === "toolcall_delta") {
            const call = event.partial.content[event.contentIndex];
            if (call?.type === "toolCall")
              test.afterToolCallDelta?.({
                sessionId: spec.sessionId,
                toolCallId: call.id,
                delta: event.delta,
              });
          }
        };
      }
      // Google uses its SDK transport rather than the custom fetch/onResponse seam.
      // Classify only explicit authentication evidence, never generic network errors.
      void stream
        .result()
        .then((message) => {
          if (
            (requested.api === "google-generative-ai" || requested.api === "google-vertex") &&
            /(?:"code"\s*:\s*(?:401|403)|PERMISSION_DENIED|UNAUTHENTICATED|API_KEY_INVALID)/.test(
              message.errorMessage ?? "",
            )
          )
            credentialResponse = true;
        })
        .catch(() => {});
      return stream;
    };
    const models: Models = {
      ...catalog,
      getModel: (provider, id) =>
        provider === model.provider && id === model.id ? model : catalog.getModel(provider, id),
      streamSimple: streamModel,
      completeSimple: (requested, context, options) =>
        streamModel(requested, context, options, true).result(),
    };
    const inputSchema = z.record(z.string(), z.unknown());
    const forward = async (taskId: number, operation: string, input: Record<string, unknown>) => {
      assertAdvancing();
      const toolCallId = actions.bindTool(String(taskId), operation, input);
      // Revoke the model invocation promptly; the dispatched domain operation keeps
      // recording its eventual receipt independently of this run's lifetime.
      const result = await this.whileCurrent(actions.executeTool({ toolCallId, operation, input }));
      assertCurrent();
      if (!result.ok)
        return { isError: true, content: [{ type: "text" as const, text: result.error }] };
      return {
        content:
          input.name === "workspace.read" && result.result instanceof WorkspaceImage
            ? result.result.content(model.input.includes("image"))
            : [{ type: "text" as const, text: JSON.stringify(result.result) }],
      };
    };
    const registry = createRegistry();
    registry.install({
      name: "mate",
      tools: [
        defineTool({
          name: "tools.list",
          description: "Discover conversation tools available to this Agent run.",
          parameters: Type.Object({}),
          replay: "safe",
          executionMode: "sequential",
          execute: async (_input, api) => forward(api.taskId, "tools.list", {}),
        }),
        defineTool({
          name: "tools.describe",
          description: "Get the exact input schema and permissions for one Mate tool.",
          parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 128 }) }),
          replay: "safe",
          executionMode: "sequential",
          execute: async (input, api) =>
            forward(api.taskId, "tools.describe", inputSchema.parse(input)),
        }),
        defineTool({
          name: "tools.call",
          description: "Call a discovered Mate conversation tool with an explicit target.",
          parameters: Type.Object({
            name: Type.String({ minLength: 1, maxLength: 128 }),
            input: Type.Record(Type.String(), Type.Any()),
          }),
          // Domain transactions and node intents deduplicate this persistent task identity.
          replay: "safe",
          executionMode: "sequential",
          execute: async (input, api) =>
            forward(api.taskId, "tools.call", inputSchema.parse(input)),
        }),
      ],
    });
    const context = withAbortSignal(this.controller.signal, BACKGROUND_CONTEXT);
    try {
      assertCurrent();
      if (spec.initialized && !existsSync(spec.storagePath))
        return {
          ok: false,
          code: "execution_environment",
          reason: "原 Agent 会话文件缺失；请恢复原数据。",
        };
      mkdirSync(dirname(spec.storagePath), { recursive: true, mode: 0o700 });
      const database = await openNodeSqliteDatabase(spec.storagePath);
      let storage: SqliteStorage;
      try {
        chmodSync(spec.storagePath, 0o600);
        await database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
        storage = await SqliteStorage.open(database);
        const commit = storage.commit.bind(storage);
        storage.commit = async (writes, context) => {
          try {
            await test.beforeDurableCommit?.(writes);
            const observed = await observations.writes(storage, writes, context);
            const sequence = await commit(observed.writes, context);
            observed.committed();
            await test.afterDurableCommit?.(writes);
            return sequence;
          } catch (error) {
            // A failed checkpoint must stop this invocation even when the upstream
            // scheduler reports the write failure without settling its submission.
            if (!this.controller.signal.aborted) {
              storageFailed = true;
              this.cancel();
            }
            throw error;
          }
        };
        this.harness = await Harness.open(
          storage,
          {
            models,
            registry,
            settings: { toolExecution: "sequential", compaction: { backgroundTokens: 0 } },
          },
          BACKGROUND_CONTEXT,
        );
      } catch (error) {
        await database.close();
        throw error;
      }
      const harness = this.harness;
      assertCurrent();
      const binding = await harness.snapshot(admissionDoc, context);
      if ((spec.initialized && !binding) || (binding && binding.sessionId !== spec.sessionId))
        return {
          ok: false,
          code: "execution_environment",
          reason: "原 Agent 会话身份不匹配；请恢复原数据。",
        };
      const conversation = await harness.root(BACKGROUND_CONTEXT);
      const configuration = createHash("sha256")
        .update(
          JSON.stringify({
            provider: spec.provider,
            modelId: spec.modelId,
            apiKey: spec.apiKey,
            prompt: spec.prompt,
            runtimeVersions,
          }),
        )
        .digest("hex");
      const newFacts = [];
      for (const entry of spec.messages) {
        if (
          entry.recoveryFact === true &&
          !(await storage.submissionByRequest(conversation.id, `delivery:${entry.id}`, context))
        )
          newFacts.push(entry);
      }
      // abort() enables scheduling: provider and tool entry points remain closed until
      // the native termination and admission facts have both committed.
      if ((binding && binding.configuration !== configuration) || newFacts.length > 0)
        await conversation.abort(context);
      assertCurrent();
      await conversation.commit(async (tx) => {
        const binding = await tx.doc(admissionDoc);
        binding.sessionId = spec.sessionId;
        binding.configuration = configuration;
        binding.runtimeVersions = runtimeVersions;
      }, context);
      spec.initializedNow();
      await conversation.configure(
        {
          model: { provider: spec.provider, modelId: spec.modelId },
          instructions: buildAgentSystemPrompt(spec.prompt).systemPrompt,
        },
        BACKGROUND_CONTEXT,
      );
      assertCurrent();
      const submissions = [];
      // Recovery facts are passive native writes while the conversation is idle. Every
      // fact is committed before any input may start the next provider request.
      for (const entry of newFacts) {
        assertCurrent();
        await conversation.submit(
          {
            type: "write",
            requestId: `delivery:${entry.id}`,
            entry: { kind: "mate.recovery", model: [entry.message] },
          },
          context,
        );
      }
      assertCurrent();
      canAdvance = true;
      this.sendNotice = async (conversationId, deliveryId) => {
        let requestId = `notice:${deliveryId}`;
        let existing = await storage.submissionByRequest(conversation.id, requestId, context);
        while (existing?.status === "unanswered") {
          // A placed notice remains in the context; an aborted queued notice must be
          // admitted again, independently of the still-unread message body.
          if (existing.entry !== undefined) return;
          requestId = `notice:${deliveryId}:after:${existing.id}`;
          existing = await storage.submissionByRequest(conversation.id, requestId, context);
        }
        assertCurrent();
        await conversation.submit(
          {
            type: "input",
            requestId,
            content: runNoticeMessage(conversationId).content,
            whenBusy: "steer",
          },
          context,
        );
      };
      for (const entry of spec.messages.filter((entry) => !entry.recoveryFact)) {
        if (entry.message.role !== "user") throw new Error("Durable input must be a user message");
        assertCurrent();
        let requestId = `delivery:${entry.id}`;
        let content = entry.message.content;
        let existing = await storage.submissionByRequest(conversation.id, requestId, context);
        // Terminal attempts never restart. A deterministic successor also survives a lost
        // Mate acknowledgment; the original text is repeated only if it was never placed.
        while (existing?.status === "unanswered") {
          if (existing.entry !== undefined)
            content = "[恢复提示] 上次工作已终止但输入仍待处理。请继续同一会话中尚未完成的工作。";
          requestId = `delivery:${entry.id}:after:${existing.id}`;
          existing = await storage.submissionByRequest(conversation.id, requestId, context);
        }
        assertCurrent();
        const submission = await conversation.submit(
          { type: "input", requestId, content, whenBusy: "steer" },
          context,
        );
        spec.inputAccepted(entry.id, submission.id);
        await test.afterInputAccepted?.(entry.id);
        submissions.push(submission);
      }
      for (const notice of this.notices.splice(0))
        this.notice(notice.conversationId, notice.deliveryId);
      for (const submission of submissions) {
        const settled = await submission.wait(context);
        if (settled.status !== "done") {
          const contextOverflow = await endedWithOverflow(storage, conversation.id, settled.detail);
          return {
            ok: false,
            code: credentialResponse
              ? "credentials_invalid"
              : contextOverflow
                ? "context_failed"
                : "model_failed",
            ...(typeof settled.detail === "string" ? { reason: settled.detail } : {}),
          };
        }
      }
      await conversation.waitForIdle(context);
      return { ok: true };
    } catch {
      return {
        ok: false,
        code: storageFailed
          ? "session_commit_failed"
          : this.controller.signal.aborted
            ? "aborted"
            : credentialResponse
              ? "credentials_invalid"
              : "model_failed",
      };
    } finally {
      this.sendNotice = undefined;
      await this.harness?.close(BACKGROUND_CONTEXT);
      this.harness = undefined;
    }
  }
}

/** The terminal submission and its last assistant response survive summary failures and process restarts. */
async function endedWithOverflow(
  storage: Storage,
  conversationId: ConversationId,
  detail: unknown,
) {
  let cursor;
  do {
    const page = await storage.scanEntries({ conversationId }, 100, cursor, BACKGROUND_CONTEXT);
    for (const entry of page.items) {
      const message = entry.model?.find((message) => message.role === "assistant");
      if (message)
        return (
          message.stopReason === "error" &&
          message.errorMessage === detail &&
          isContextOverflow(message)
        );
    }
    cursor = page.next;
  } while (cursor);
  return false;
}
