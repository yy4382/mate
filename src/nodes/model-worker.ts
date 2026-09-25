import { randomUUID } from "node:crypto";
import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { z } from "zod";

const contextMessageSchema = z
  .object({
    sequence: z.number().int().positive(),
    role: z.enum(["user", "assistant"]),
    text: z.string().min(1).max(20_000),
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
          "只需在触发本次运行的对话中回复。此运行没有工具，也不能选择其他对话作为回复目标。",
        ].join("\n"),
        tools: [],
        messages: transcript,
      },
    });
    const unsubscribe = agent.subscribe(async (event) => {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
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
  if (message.role === "user") return { role: "user", content: message.text, timestamp };
  return {
    role: "assistant",
    content: [{ type: "text", text: message.text }],
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
