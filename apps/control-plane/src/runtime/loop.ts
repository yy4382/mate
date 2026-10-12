import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineTool, type Conversation } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type, type Model, type Api, type Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { z } from "zod";
import { WorkspaceImage } from "../workspaces/reads/image-result.js";
import { buildAgentSystemPrompt, runNoticeMessage, type AgentProfile } from "../prompts/index.js";
import { type SessionCommit, type ModelContextMessage } from "./session/record.js";
import type { AgentToolCallResult } from "./tools/registry.js";

export interface AgentLoopSpec {
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
  beforeSessionCommit?: (entry: SessionCommit) => Promise<void>;
  afterSessionCommit?: (entry: SessionCommit) => Promise<void>;
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
  private conversation: Conversation | undefined;
  private readonly controller = new AbortController();
  private readonly notices: { conversationId: string; deliveryId: string }[] = [];
  cancel(): void {
    this.controller.abort();
    // Close cancels invocations without withdrawing the durable inbox.
    void this.harness?.close(BACKGROUND_CONTEXT).catch(() => {});
  }
  notice(conversationId: string, deliveryId = conversationId): void {
    if (this.controller.signal.aborted) return;
    if (this.conversation) {
      void this.conversation
        .submit(
          {
            type: "input",
            content: runNoticeMessage(conversationId).content,
            requestId: `notice:${deliveryId}`,
            whenBusy: "steer",
          },
          BACKGROUND_CONTEXT,
        )
        .catch(() => {});
    } else this.notices.push({ conversationId, deliveryId });
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
    const models: Models = {
      ...catalog,
      getModel: (provider, id) =>
        provider === model.provider && id === model.id ? model : catalog.getModel(provider, id),
      streamSimple: (requested, context, options) => {
        assertCurrent();
        return catalog.streamSimple(requested, context, {
          ...options,
          apiKey: spec.apiKey,
          env: {},
          onResponse: async (response, currentModel) => {
            if (response.status === 401 || response.status === 403) credentialResponse = true;
            await options?.onResponse?.(response, currentModel);
          },
          fetch: async (input, init) => {
            assertCurrent();
            const response = await fetch(input, init);
            if (response.status === 401 || response.status === 403) credentialResponse = true;
            return response;
          },
        });
      },
    };
    const inputSchema = z.record(z.string(), z.unknown());
    const forward = async (taskId: number, operation: string, input: Record<string, unknown>) => {
      assertCurrent();
      const toolCallId = actions.bindTool(String(taskId), operation, input);
      const result = await actions.executeTool({ toolCallId, operation, input });
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
          executionMode: "sequential",
          execute: async (_input, api) => forward(api.taskId, "tools.list", {}),
        }),
        defineTool({
          name: "tools.describe",
          description: "Get the exact input schema and permissions for one Mate tool.",
          parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 128 }) }),
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
          executionMode: "sequential",
          execute: async (input, api) =>
            forward(api.taskId, "tools.call", inputSchema.parse(input)),
        }),
      ],
    });
    const context = withAbortSignal(this.controller.signal, BACKGROUND_CONTEXT);
    try {
      assertCurrent();
      mkdirSync(dirname(spec.storagePath), { recursive: true, mode: 0o700 });
      const database = await openNodeSqliteDatabase(spec.storagePath);
      try {
        chmodSync(spec.storagePath, 0o600);
        await database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
        const storage = await SqliteStorage.open(database);
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
      const conversation = await harness.root(BACKGROUND_CONTEXT);
      await conversation.configure(
        {
          model: { provider: spec.provider, modelId: spec.modelId },
          instructions: buildAgentSystemPrompt(spec.prompt).systemPrompt,
        },
        BACKGROUND_CONTEXT,
      );
      this.conversation = conversation;
      assertCurrent();
      const submissions = [];
      for (const entry of spec.messages) {
        if (entry.message.role !== "user") throw new Error("Durable input must be a user message");
        assertCurrent();
        const submission = await conversation.submit(
          {
            type: "input",
            requestId: `delivery:${entry.id}`,
            content: entry.message.content,
            whenBusy: "steer",
          },
          context,
        );
        await test.afterInputAccepted?.(entry.id);
        submissions.push(submission);
      }
      for (const notice of this.notices.splice(0))
        this.notice(notice.conversationId, notice.deliveryId);
      for (const submission of submissions) {
        const settled = await submission.wait(context);
        if (settled.status !== "done")
          return { ok: false, code: credentialResponse ? "credentials_invalid" : "model_failed" };
      }
      await conversation.waitForIdle(context);
      return { ok: true };
    } catch {
      return {
        ok: false,
        code: this.controller.signal.aborted
          ? "aborted"
          : credentialResponse
            ? "credentials_invalid"
            : "model_failed",
      };
    } finally {
      this.conversation = undefined;
      await this.harness?.close(BACKGROUND_CONTEXT);
      this.harness = undefined;
    }
  }
}
