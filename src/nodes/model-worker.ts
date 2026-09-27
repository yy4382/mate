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
        sourceChannel: z
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
const transcriptAckSchema = z
  .object({
    type: z.literal("transcript_ack"),
    nonce: z.string().uuid(),
    requestId: z.string().uuid(),
    accepted: z.boolean(),
  })
  .strict();
/**
 * A message arrived while this run is still in progress. The node composes the model-visible
 * wording, so no message text and no delivery state can travel on this channel.
 */
const noticeSchema = z
  .object({
    type: z.literal("notice"),
    nonce: z.string().uuid(),
    conversationId: z.string().uuid(),
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
  /** The Pi loop currently producing this run, so a notice can reach it while it works. */
  let running: { nonce: string; agent: Agent } | undefined;
  process.on("message", async (raw: unknown) => {
    const acknowledgement = transcriptAckSchema.safeParse(raw);
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
    const notice = noticeSchema.safeParse(raw);
    if (notice.success) {
      if (running?.nonce === notice.data.nonce)
        running.agent.steer(runNoticeMessage(notice.data.conversationId));
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
    let credentialResponse = false;
    const agent = new Agent({
      sessionId: run.data.spec.sessionId,
      onResponse: (response) => {
        if (response.status === 401 || response.status === 403) credentialResponse = true;
      },
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
          `本次输入来自：频道 ${run.data.spec.sourceChannel.channelId}（${visibilityLabel(run.data.spec.sourceChannel.visibility)}）。`,
          // The run prompt schedules work from the Agent's whole continuing record; it does not
          // restrict history to explaining the current input. A mid-run notice is a separate
          // mechanism with its own text and is not described here.
          "上下文中的每条消息都标出来源频道、可见范围和是否属于本次输入。你跨频道、讨论串和私信共用同一条逻辑会话；历史是你自己持续工作的记录，不只是对本次输入的解释。你可以根据本次输入、仍由你负责的未完成任务、提醒和你自己组织的工作区记忆，自行决定先做什么、继续什么、暂缓什么或保持静默。",
          "为某条消息展开实际工作（而不只是回答或讨论）时，默认先对那条消息调用一次 tasks.claim_message：它认领那条消息已有的任务，没有时创建并认领该讨论原顶层消息对应的任务；已被同伴认领时返回冲突，供你先协调而不抢占。纯讨论、回答和不冲突的协助无需认领；这只是默认工作约定，不构成其他工具的后端通行证，你仍按对话权限阅读和协作。",
          "任务、提醒和你自己组织的工作区记忆都是持久事实，服务重启、更换模型进程或会话压缩后仍可用 tasks.list、reminders.list、workspace.list 和 workspace.read 找回；压缩只更换后续模型调用使用的会话，不产生第二条逻辑会话。任务状态只由任务工具更新，不会因为你发言、保持静默或运行结束而自动完成。",
          // The workspace is an organisation location, not a confidentiality boundary between
          // Agents: this is a courtesy reminder, and the Agent keeps the judgement. Mate does not
          // attach a permission request, a violation finding or a required explanation to it.
          "你的默认工作区是你自己组织资料的位置，不是对其他 Agent 保密的隔离边界：同伴的工作区就在同一个目录下，按同伴的 Agent ID 即可访问。请尊重同伴的资料组织，不要随意读取他们的工作区；当你判断当前工作确实需要时可以直接读取，不需要申请许可，也不必说明理由。",
          "运行期间可能有新消息到达：你会收到以 [运行提示] 开头的用户消息，它只给出有新消息的对话 ID，不含正文，也不代表正文已读；它不是历史记录，也不是本次输入的正文，而是当前运行中的实时提示。看到提示不会打断你正在执行的工具，你可以自行决定现在读取、暂缓或继续手上的工作。未处理的消息会留到下一轮同一会话。",
          "你的普通正文只写入你自己的 Agent 会话记录，不会发送给任何频道、讨论串或私信；只输出正文而不发言，也是一次成功的处理。要在某个频道、讨论串或私信中发言，必须调用 messages.send，并在 input 中显式给出 conversationId 和 text（讨论串用 rootId，引用用 quoteId）。公开对话中的发言不得泄露任何私密对话的内容。",
          "使用 tools.list 发现可用 Mate 操作，需要时使用 tools.describe 读取准确参数。process.exec 会在当前运行账号的普通 shell 子进程中执行命令，默认使用你自己的默认工作目录；命令里写 sudo 时是否获得 root 由宿主已有的 sudo 配置决定，Mate 不插入 sudo、不提供审批，也不修改 sudoers。使用 process.list、process.inspect 和 process.stop 查看或尽力停止自己启动的、进程组仍存在的命令。先用 agents.list 查找同伴身份，再用 conversations.open_dm 建立或返回你与目标 Agent 的私信；每次读取和发送都必须明确指定你有权访问的对话。邀请同伴时必须指定你已加入的频道和目标 Agent。控制面会检查每次操作是否获授权，拒绝结果不可绕过。",
        ].join("\n"),
        tools,
        messages: transcript,
      },
      toolExecution: "sequential",
    });
    running = { nonce, agent };
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
      const transcriptRequestId = randomUUID();
      const accepted = await new Promise<boolean>((resolve) => {
        pending.set(transcriptRequestId, { nonce, resolve });
        process.send?.({ type: "transcript", nonce, requestId: transcriptRequestId, text });
      });
      if (!accepted) throw new Error("The control plane rejected the transcript entry");
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
      process.send?.({
        type: "failed",
        nonce,
        code: credentialResponse ? "credentials_invalid" : "model_failed",
      });
    } finally {
      running = undefined;
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

/**
 * The model-visible wording of a mid-run notice. It names the conversation that received a
 * message and nothing else: no body, no author, no delivery identity, and no read receipt.
 *
 * The notice is deliberately kept out of the session journal. It is not a message and not a
 * delivery: the journal stays the record of what was said, and the pending delivery stays the
 * record of what still needs attention, so nothing has to be un-read or replayed later.
 */
function runNoticeMessage(conversationId: string): AgentMessage {
  return {
    role: "user",
    content: `[运行提示] 对话 ${conversationId} 有新消息到达。这条提示只说明有新消息，不含正文，也没有把任何消息标为已读；你可以用 conversations.read 或 attention.list 现在查看，也可以继续手上的工作，把它留给下一轮同一会话。`,
    timestamp: Date.now(),
  };
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
