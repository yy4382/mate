import { randomUUID } from "node:crypto";
import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
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
        sessionId: z.string().uuid(),
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

  const pending = new Map<string, { resolve(accepted: boolean): void }>();
  let active = false;
  process.on("message", async (raw: unknown) => {
    const acknowledgement = replySchema.safeParse(raw);
    if (acknowledgement.success) {
      const waiter = pending.get(acknowledgement.data.requestId);
      pending.delete(acknowledgement.data.requestId);
      waiter?.resolve(acknowledgement.data.accepted);
      return;
    }
    const run = runSchema.safeParse(raw);
    if (!run.success || active) {
      process.send?.({ type: "failed", code: "worker_failed" });
      return;
    }
    active = true;
    const nonce = run.data.nonce,
      transcript = run.data.spec.messages.map(toAgentMessage);
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
          "此运行没有工具，也不能选择其他对话作为回复目标。",
        ].join("\n"),
        tools: [],
        messages: transcript,
      },
    });
    let unsuccessfulStopReason: "error" | "aborted" | undefined;
    const unsubscribe = agent.subscribe(async (event) => {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
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
        pending.set(journalRequestId, { resolve });
        process.send?.({ type: "journal", nonce, requestId: journalRequestId, text });
      });
      if (!accepted) throw new Error("The control plane rejected the journal entry");
    });

    try {
      await agent.continue();
      if (unsuccessfulStopReason) throw new Error("The model returned an unsuccessful result");
      process.send?.({ type: "done", nonce });
    } catch {
      process.send?.({ type: "failed", nonce, code: "model_failed" });
    } finally {
      unsubscribe();
      for (const waiter of pending.values()) waiter.resolve(false);
      pending.clear();
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
