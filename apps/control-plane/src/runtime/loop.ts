import { projectImages } from "./session/image-context.js";
import { WorkspaceImage } from "../workspaces/image-result.js";
import { z } from "zod";
import {
  confirmedModelResponse,
  providerResponseComplete,
  reportedGoogleUsage,
  reportedUsage,
} from "./provider-response.js";
import {
  type SessionCommit,
  type ModelContextMessage,
  type ReportedUsage,
} from "./session/record.js";
import { durableToolIdentity } from "./tools/identity.js";
import { randomUUID } from "node:crypto";
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
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
  prompt: { name: string; role: string; description: string };
  provider: string;
  modelId: string;
  apiKey: string;
}
/** Fault injection at persistence boundaries, and a local HTTP provider in integration tests. */
export interface AgentLoopTestDependencies {
  modelForRun?: (model: Model<Api>, apiKey: string) => Model<Api>;
  beforeSessionCommit?: (entry: SessionCommit) => Promise<void>;
  afterSessionCommit?: (entry: SessionCommit) => Promise<void>;
  beforeRunFinish?: () => Promise<void>;
  beforeRunStart?: (runId: string) => Promise<void>;
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
    const model = test.modelForRun?.(selected, spec.apiKey) ?? selected,
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
                  inspectedNormalUsage = response
                    .clone()
                    .text()
                    .then((body) => ({
                      usage: reportedUsage(body, selectedModel.api),
                      complete: providerResponseComplete(body, response.status),
                    }))
                    .catch(() => null);
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
        systemPrompt: [
          `你是 Mate 中的 Agent 同事「${spec.prompt.name}」。`,
          `你的角色：${spec.prompt.role}`,
          `介绍：${spec.prompt.description}`,
          // The run prompt schedules work from the Agent's whole continuing record; it does not
          // restrict history to explaining the current input. A mid-run notice is a separate
          // mechanism with its own text and is not described here.
          "输入消息首次呈现时标出来源频道与可见范围。你跨频道、讨论串和私信共用同一条逻辑会话；历史是你自己持续工作的记录，不只是对本次输入的解释。你可以根据本次输入、仍由你负责的未完成任务、提醒和你自己组织的工作区记忆，自行决定先做什么、继续什么、暂缓什么或保持静默。",
          "为某条消息展开实际工作时，默认先明确相关任务并用 tasks.claim 按任务 ID 和看到的版本认领。选择记录工作时，用 tasks.create 提供原消息 ID 与标题创建待认领任务，创建不自动分配负责人；顶层消息与讨论串回复都可挂多个任务，回复任务属于指定回复。多个正交事项（修复登录／整理部署说明）分别建任务，同一项工作的步骤（排查／修改／验证）留在同一任务中。创建返回已有任务时，可认领、协调、放弃，或原样携 taskSnapshot 为另一事项继续创建；思考期间又有新增任务时会再次返回当前任务列表。已被同伴认领时先协调而不抢占。纯交流、提醒和不冲突的协助无需认领；这是默认工作约定，不构成其他工具的通行证，你仍按对话权限阅读和协作。",
          "任务、提醒和你自己组织的工作区记忆都是持久事实，服务重启、开始新的 run或会话压缩后仍可用 tasks.list、reminders.list、workspace.list 和 workspace.read 找回；压缩只更换后续模型调用使用的上下文，不产生第二条逻辑会话。任务状态只由任务工具更新，不会因为你发言、保持静默或运行结束而自动完成。",
          // The workspace is an organisation location, not a confidentiality boundary between
          // Agents: this is a courtesy reminder, and the Agent keeps the judgement. Mate does not
          // attach a permission request, a violation finding or a required explanation to it.
          "你的默认工作区是你自己组织资料的位置，不是对其他 Agent 保密的隔离边界：同伴的工作区就在同一个目录下，按同伴的 Agent ID 即可访问。请尊重同伴的资料组织，不要随意读取他们的工作区；当你判断当前工作确实需要时可以直接读取，不需要申请许可，也不必说明理由。",
          "运行期间可能有新消息到达：你会收到以 [运行提示] 开头的用户消息，它只给出有新消息的对话 ID，不含正文，也不代表正文已读；它会按你实际看到的顺序保存在会话历史中，与消息正文分别记录。看到提示不会打断你正在执行的工具，你可以自行决定现在读取、暂缓或继续手上的工作。未处理的消息会留到下一轮同一会话。",
          "你的普通正文只写入你自己的 Agent 会话记录，不会发送给任何频道、讨论串或私信；只输出正文而不发言，也是一次成功的处理。要在某个频道、讨论串或私信中发言，必须调用 messages.send，并在 input 中显式给出 conversationId 和 text（讨论串用 rootId，引用用 quoteId）。公开对话中的发言不得泄露任何私密对话的内容。",
          "使用 tools.list 发现可用 Mate 操作，需要时使用 tools.describe 读取准确参数。process.exec 会在当前运行账号的普通 shell 子进程中执行命令，默认使用你自己的默认工作目录；命令里写 sudo 时是否获得 root 由宿主已有的 sudo 配置决定，Mate 不插入 sudo、不提供审批，也不修改 sudoers。使用 process.list、process.inspect 和 process.stop 查看或尽力停止自己启动的、进程组仍存在的命令；Mate 的进程记录只属于当前这次节点进程，节点重启或命令以新会话离开该进程组后它无法观察，也不会声称那些命令已经结束——无法确认时收据只说未知，你应据此决定是否重做有副作用的操作。先用 agents.list 查找同伴身份，再用 conversations.open_dm 建立或返回你与目标 Agent 的私信；每次读取和发送都必须明确指定你有权访问的对话。邀请同伴时必须指定你已加入的频道和目标 Agent。控制面会检查每次操作是否获授权，拒绝结果不可绕过。",
        ].join("\n"),
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
          piAgentVersion: "0.86.0",
          piAiVersion: "0.86.0",
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
        const message = {
          role: "user" as const,
          content:
            "[运行恢复] 上次模型响应未成功完成。请从已保存的工具结果和操作事实继续，不要重做结果未知的副作用。",
          timestamp: Date.now(),
        };
        const id = randomUUID();
        await commit({ kind: "message", id, message });
        compaction.record(id, message);
        agent.state.messages = [...agent.state.messages, message];
      }
      // A completed silent/final response followed by a lost run completion commit needs no new generation.
      if (agent.state.messages.at(-1)?.role !== "assistant") {
        await agent.continue();
        if (contextOverflow) {
          const message = {
            role: "user" as const,
            content:
              "[上下文恢复] 上次普通模型请求超出上下文容量。已保存的工具结果和操作事实仍有效；从压缩后的同一会话继续，不要重做结果未知的副作用。",
            timestamp: Date.now(),
          };
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
function runNoticeMessage(conversationId: string): AgentMessage {
  return {
    role: "user",
    content: `[运行提示] 对话 ${conversationId} 有新消息到达。这条提示只说明有新消息，不含正文，也没有把任何消息标为已读；你可以用 conversations.read 或 attention.list 现在查看，也可以继续手上的工作，把它留给下一轮同一会话。`,
    timestamp: Date.now(),
  };
}
