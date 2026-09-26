import { createHash, randomUUID } from "node:crypto";
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { z } from "zod";

const contextMessageSchema = z
  .object({
    sequence: z.number().int().positive(),
    role: z.enum(["user", "assistant"]),
    text: z.string().min(1).max(20_000),
    sourceChannelId: z.string().uuid(),
    sourceVisibility: z.enum(["public", "private"]),
    currentRunInput: z.boolean(),
  })
  .strict();
const runSchema = z
  .object({
    type: z.literal("run"),
    nonce: z.string().uuid(),
    spec: z
      .object({
        runId: z.string().uuid(),
        agentId: z.string().uuid(),
        sessionId: z.string().uuid(),
        actionScopeId: z.string().uuid(),
        outputChannel: z
          .object({
            channelId: z.string().uuid(),
            visibility: z.enum(["public", "private"]),
          })
          .strict(),
        messages: z.array(contextMessageSchema).min(1),
        prompt: z
          .object({
            name: z.string().min(1).max(80),
            role: z.string().min(1).max(160),
            description: z.string().max(1000),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
const replySchema = z
  .object({
    type: z.literal("journal_ack"),
    nonce: z.string().uuid(),
    requestId: z.string().uuid(),
    accepted: z.boolean(),
  })
  .strict();
const toolReplySchema = z.discriminatedUnion("ok", [
  z
    .object({
      type: z.literal("tool_result"),
      nonce: z.string().uuid(),
      requestId: z.string().uuid(),
      toolCallId: z.string().min(1).max(500),
      ok: z.literal(true),
      result: z.json(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_result"),
      nonce: z.string().uuid(),
      requestId: z.string().uuid(),
      toolCallId: z.string().min(1).max(500),
      ok: z.literal(false),
      error: z.string().min(1).max(240),
    })
    .strict(),
]);

export type ModelContextMessage = z.infer<typeof contextMessageSchema>;
export type ModelRunSpec = z.infer<typeof runSchema>["spec"];

/** Run a single Pi Agent turn in this short-lived, credential-bearing process. */
export function serveModelWorker(stream: StreamFn): void {
  const models = builtinModels(),
    provider = process.env.MATE_MODEL_PROVIDER,
    modelId = process.env.MATE_MODEL_ID,
    apiKey = process.env.MATE_MODEL_KEY,
    model = provider && modelId ? models.getModel(provider, modelId) : undefined;
  if (!model || !apiKey) {
    process.send?.({ type: "failed", code: "model_unavailable" });
    return;
  }

  const pending = new Map<string, { nonce: string; resolve(accepted: boolean): void }>(),
    pendingTools = new Map<
      string,
      { nonce: string; toolCallId: string; resolve(reply: z.infer<typeof toolReplySchema>): void }
    >();
  let active = false;
  process.on("message", async (raw: unknown) => {
    const acknowledgement = replySchema.safeParse(raw);
    if (acknowledgement.success) {
      const waiter = pending.get(acknowledgement.data.requestId);
      if (waiter?.nonce === acknowledgement.data.nonce) {
        pending.delete(acknowledgement.data.requestId);
        waiter.resolve(acknowledgement.data.accepted);
      }
      return;
    }
    const toolReply = toolReplySchema.safeParse(raw);
    if (toolReply.success) {
      const waiter = pendingTools.get(toolReply.data.requestId);
      if (
        waiter?.nonce === toolReply.data.nonce &&
        waiter.toolCallId === toolReply.data.toolCallId
      ) {
        pendingTools.delete(toolReply.data.requestId);
        waiter.resolve(toolReply.data);
      }
      return;
    }
    const run = runSchema.safeParse(raw);
    if (!run.success || active) {
      process.send?.({ type: "failed", code: "worker_failed" });
      return;
    }
    active = true;
    const nonce = run.data.nonce,
      transcript = run.data.spec.messages.map(toAgentMessage),
      actionOccurrences = new Map<string, number>();
    const forwardTool = async (
      toolCallId: string,
      operation: string,
      input: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<unknown> => {
      if (signal?.aborted) throw new Error("Tool call aborted");
      const requestId = randomUUID();
      let durableToolCallId = toolCallId;
      if (operation === "tools.call") {
        const signatureHash = createHash("sha256")
            .update(canonicalJson({ operation, input }))
            .digest("hex"),
          occurrence = (actionOccurrences.get(signatureHash) ?? 0) + 1;
        actionOccurrences.set(signatureHash, occurrence);
        durableToolCallId = `mate:${run.data.spec.actionScopeId}:${signatureHash}:${occurrence}`;
      }
      const result = await new Promise<z.infer<typeof toolReplySchema>>((resolve, reject) => {
        const abort = () => {
          pendingTools.delete(requestId);
          reject(new Error("Tool call aborted"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        pendingTools.set(requestId, {
          nonce,
          toolCallId: durableToolCallId,
          resolve: (reply) => {
            signal?.removeEventListener("abort", abort);
            resolve(reply);
          },
        });
        process.send?.({
          type: "tool",
          nonce,
          requestId,
          toolCallId: durableToolCallId,
          operation,
          input,
        });
      });
      if (!result.ok) throw new Error(result.error);
      return result.result;
    };
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
                  input as Record<string, unknown>,
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
        execute: async (toolCallId, input, signal) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                await forwardTool(
                  toolCallId,
                  "tools.call",
                  input as Record<string, unknown>,
                  signal,
                ),
              ),
            },
          ],
          details: null,
        }),
      },
    ];
    const agent = new Agent({
      sessionId: run.data.spec.sessionId,
      streamFn: (selectedModel, context, options) =>
        stream(selectedModel, context, {
          ...options,
          apiKey,
          env: {},
        }),
      initialState: {
        model,
        systemPrompt: [
          `你是 Mate 中的 Agent 同事「${run.data.spec.prompt.name}」。`,
          `你的角色：${run.data.spec.prompt.role}`,
          `介绍：${run.data.spec.prompt.description}`,
          `本次回复目的地：频道 ${run.data.spec.outputChannel.channelId}（${visibilityLabel(run.data.spec.outputChannel.visibility)}）。`,
          "上下文中的每条消息都标出来源频道、可见范围和是否属于本次输入。只处理标为本次输入的消息；历史仅用于理解。公开频道回复不得泄露任何私密频道内容。",
          "使用 tools.list 发现可用 Mate 操作，需要时使用 tools.describe 读取准确参数。process.exec 会以你固定的非特权 Linux 用户运行普通命令；使用 process.list、process.inspect 和 process.stop 管理自己的命令进程。普通命令不需要逐条人工审批。先用 agents.list 查找同伴身份，再用 conversations.open_dm 建立或返回你与目标 Agent 的私信；每次读取和发送都必须明确指定你有权访问的对话。邀请同伴时必须指定你已加入的频道和目标 Agent。控制面会检查每次操作是否获授权，拒绝结果不可绕过。",
        ].join("\n"),
        tools,
        messages: transcript,
      },
      toolExecution: "sequential",
    });
    let unsuccessfulStopReason: "error" | "aborted" | undefined;
    const unsubscribe = agent.subscribe(async (event) => {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
        if (process.env.MATE_MODEL_TEST_DIAGNOSTICS === "1")
          process.stderr.write(
            `Pi assistant unsuccessful: ${event.message.stopReason}; ${event.message.errorMessage?.slice(0, 500) ?? "no detail"}\n`,
          );
        unsuccessfulStopReason = event.message.stopReason;
        return;
      }
      const text = event.message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim();
      if (!text) return;
      const journalRequestId = randomUUID();
      const accepted = await new Promise<boolean>((resolve) => {
        pending.set(journalRequestId, { nonce, resolve });
        process.send?.({ type: "journal", nonce, requestId: journalRequestId, text });
      });
      if (!accepted) throw new Error("The control plane rejected the journal entry");
    });

    try {
      await agent.continue();
      if (unsuccessfulStopReason) throw new Error("The model returned an unsuccessful result");
      process.send?.({ type: "done", nonce });
    } catch (error) {
      if (process.env.MATE_MODEL_TEST_DIAGNOSTICS === "1")
        process.stderr.write(
          `Pi model worker failed: ${(error instanceof Error ? (error.stack ?? error.message) : String(error)).slice(0, 1500)}\n`,
        );
      process.send?.({ type: "failed", nonce, code: "model_failed" });
    } finally {
      unsubscribe();
      for (const waiter of pending.values()) waiter.resolve(false);
      pending.clear();
      pendingTools.clear();
    }
  });
  process.on("disconnect", () => process.exit(0));
}

function toAgentMessage(message: ModelContextMessage): AgentMessage {
  const timestamp = message.sequence;
  const content = [
    `[消息来源：频道 ${message.sourceChannelId}；可见范围：${visibilityLabel(message.sourceVisibility)}；${message.currentRunInput ? "本次输入" : "历史记录"}]`,
    message.text,
  ].join("\n");
  if (message.role === "user") return { role: "user", content, timestamp };
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: "openai-completions",
    provider: "openai",
    model: "journal-replay",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

function visibilityLabel(visibility: "public" | "private"): string {
  return visibility === "public" ? "公开" : "私密";
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

if (process.env.MATE_MODEL_WORKER === "1") {
  const models = builtinModels();
  serveModelWorker((model, context, options) =>
    models.streamSimple(model, context, {
      ...options,
      apiKey: process.env.MATE_MODEL_KEY!,
      env: {},
    }),
  );
}
