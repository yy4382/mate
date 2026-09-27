// This test-only entry substitutes the network stream while exercising the same Pi Agent loop.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

let syntheticToolTurn = 0;

// Prevent the production entry guard from attaching the live provider stream a second time.
const workerMode = process.env.MATE_MODEL_WORKER;
delete process.env.MATE_MODEL_WORKER;
const { serveModelWorker } = await import("../../dist/src/nodes/model-worker.js");
process.env.MATE_MODEL_WORKER = workerMode;

serveModelWorker((model, context, options) => {
  const stream = createAssistantMessageEventStream();
  if (
    options.apiKey === "synthetic-key-process-recovery" ||
    options.apiKey === "synthetic-key-workspace-recovery"
  ) {
    const unrelated = systemPrompt(context).includes("Online Agent");
    const workspace = options.apiKey === "synthetic-key-workspace-recovery";
    const toolTurn = !unrelated && syntheticToolTurn++ === 0;
    stream.push({
      type: "done",
      reason: toolTurn ? "toolUse" : "stop",
      message: {
        role: "assistant",
        content: toolTurn
          ? [
              {
                type: "toolCall",
                id: workspace ? "durable-workspace-call" : "durable-process-call",
                name: "tools.call",
                arguments: {
                  name: workspace ? "workspace.write" : "process.exec",
                  input: workspace
                    ? { path: "memo.txt", content: "once" }
                    : { command: "printf side-effect" },
                },
              },
            ]
          : [
              {
                type: "text",
                text: unrelated ? "Online Agent continued." : "Recovered process result.",
              },
            ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: toolTurn ? "toolUse" : "stop",
        timestamp: Date.now(),
      },
    });
    return stream;
  }
  if (options.apiKey === "synthetic-key-http-401" || options.apiKey === "synthetic-key-http-503") {
    void options.onResponse?.(
      { status: options.apiKey.endsWith("401") ? 401 : 503, headers: {} },
      model,
    );
    stream.push({
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: "provider request failed",
        timestamp: Date.now(),
      },
    });
    return stream;
  }
  if (options.apiKey === "synthetic-key-hold") return stream;
  if (options.apiKey === "synthetic-key-tool-ack") {
    const firstToolTurn = syntheticToolTurn++ === 0;
    stream.push({
      type: "done",
      reason: firstToolTurn ? "toolUse" : "stop",
      message: {
        role: "assistant",
        content: firstToolTurn
          ? [{ type: "toolCall", id: "tool-call-stable", name: "tools.list", arguments: {} }]
          : [{ type: "text", text: "已收到工具结果。" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: firstToolTurn ? "toolUse" : "stop",
        timestamp: Date.now(),
      },
    });
    return stream;
  }
  if (options.apiKey === "synthetic-key-conversation-tools") {
    const turn = syntheticToolTurn++,
      prompt = systemPrompt(context),
      channelId = prompt.match(/本次输入来自：频道 ([0-9a-f-]{36})/)?.[1];
    const toolCall =
      turn === 0
        ? { type: "toolCall", id: "conversation-tools-list", name: "tools.list", arguments: {} }
        : turn === 1
          ? {
              type: "toolCall",
              id: "conversation-tools-send",
              name: "tools.call",
              arguments: {
                name: "messages.send",
                input: { conversationId: channelId, text: "Pi 工具经控制面发送的消息。" },
              },
            }
          : undefined;
    const content = toolCall
      ? [toolCall]
      : [{ type: "text", text: "工具调用完成后生成的最终回复。" }];
    stream.push({
      type: "done",
      reason: toolCall ? "toolUse" : "stop",
      message: {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: toolCall ? "toolUse" : "stop",
        timestamp: Date.now(),
      },
    });
    return stream;
  }
  if (options.apiKey === "synthetic-key-narrated-tool-turn") {
    const turn = syntheticToolTurn++,
      channelId = systemPrompt(context).match(/本次输入来自：频道 ([0-9a-f-]{36})/)?.[1],
      first = turn === 0;
    // A common model shape: narration and a tool call in the same assistant message. The narration
    // is one plain turn and the following answer is another, so one run records two of them.
    stream.push({
      type: "done",
      reason: first ? "toolUse" : "stop",
      message: {
        role: "assistant",
        content: first
          ? [
              { type: "text", text: "我先说明一下，然后发送这条消息。" },
              {
                type: "toolCall",
                id: "narrated-send",
                name: "tools.call",
                arguments: {
                  name: "messages.send",
                  input: { conversationId: channelId, text: "带说明的工具发送消息。" },
                },
              },
            ]
          : [{ type: "text", text: "工具已发送，这是我的最终正文。" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: first ? "toolUse" : "stop",
        timestamp: Date.now(),
      },
    });
    return stream;
  }
  if (options.apiKey === "synthetic-key-durable-action-pair") {
    const turn = syntheticToolTurn++,
      channelId = systemPrompt(context).match(/本次输入来自：频道 ([0-9a-f-]{36})/)?.[1],
      text =
        turn < 2 ? "同一交付中的重复动作。" : turn === 2 ? "参数不同，属于新的动作。" : undefined,
      call =
        text === undefined
          ? undefined
          : {
              type: "toolCall",
              id: `pi-${randomUUID()}`,
              name: "tools.call",
              arguments: {
                name: "messages.send",
                input:
                  turn === 1
                    ? { text, conversationId: channelId }
                    : { conversationId: channelId, text },
              },
            },
      content = call ? [call] : [{ type: "text", text: "重放后的最终回复。" }];
    stream.push({
      type: "done",
      reason: call ? "toolUse" : "stop",
      message: {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: call ? "toolUse" : "stop",
        timestamp: Date.now(),
      },
    });
    return stream;
  }
  if (options.apiKey === "synthetic-key-reminders-silent") {
    // The scripted Agent reads its reminders first and then chooses to say nothing this run.
    const turn = syntheticToolTurn++;
    stream.push({
      type: "done",
      reason: turn === 0 ? "toolUse" : "stop",
      message: {
        role: "assistant",
        content:
          turn === 0
            ? [
                {
                  type: "toolCall",
                  id: "reminders-silent",
                  name: "tools.call",
                  arguments: { name: "reminders.list", input: {} },
                },
              ]
            : [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: turn === 0 ? "toolUse" : "stop",
        timestamp: Date.now(),
      },
    });
    return stream;
  }
  if (options.apiKey === "synthetic-key-continuity-plan") {
    // A scripted Agent that schedules its own work instead of only explaining its input: consult
    // reminders, consult tasks, read its own workspace memory, answer the current message, then
    // continue the unfinished task it already owns and finish silently.
    const turn = syntheticToolTurn++,
      channelId = systemPrompt(context).match(/本次输入来自：频道 ([0-9a-f-]{36})/)?.[1],
      reminder = nestedToolResult(context, "reminders.list")?.reminders?.[0],
      openTask = nestedToolResult(context, "tasks.list")?.tasks?.find(
        (task) => task.status !== "done",
      ),
      memory = nestedToolResult(context, "workspace.read")?.content,
      call =
        turn === 0
          ? { name: "reminders.list", input: {} }
          : turn === 1
            ? { name: "tasks.list", input: {} }
            : turn === 2
              ? { name: "workspace.read", input: { path: "plan.md" } }
              : turn === 3 && reminder && memory
                ? {
                    name: "messages.send",
                    input: {
                      conversationId: channelId,
                      text: `先看提醒：${reminder.text} 记忆：${memory}`,
                    },
                  }
                : turn === 4 && openTask
                  ? {
                      name: "tasks.update",
                      input: {
                        taskId: openTask.id,
                        expectedVersion: openTask.version,
                        status: "done",
                        note: "继续完成原任务。",
                      },
                    }
                  : undefined;
    stream.push({
      type: "done",
      reason: call ? "toolUse" : "stop",
      message: {
        role: "assistant",
        content: call
          ? [{ type: "toolCall", id: `continuity-${turn}`, name: "tools.call", arguments: call }]
          : [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: call ? "toolUse" : "stop",
        timestamp: Date.now(),
      },
    });
    return stream;
  }
  const stopReason =
    options.apiKey === "synthetic-key-error-text"
      ? "error"
      : options.apiKey === "synthetic-key-aborted-text"
        ? "aborted"
        : "stop";
  const text =
    options.apiKey === "synthetic-key-inspect-context"
      ? JSON.stringify({
          systemPrompt: systemPrompt(context),
          messages: context.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        })
      : options.apiKey === "synthetic-key-delayed-reply"
        ? "频道解除归档后的回复。"
        : options.apiKey === "synthetic-key-error-text" ||
            options.apiKey === "synthetic-key-aborted-text"
          ? "不应提交的错误文本。"
          : options.apiKey === "synthetic-key-version-c"
            ? "这是取消旧 run 后的新凭据回复。"
            : options.apiKey === "synthetic-key-version-b"
              ? "这是密钥更新后的测试回复。"
              : "这是首次测试回复。";
  const emit = () => {
    stream.push({
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        content: options.apiKey === "synthetic-key-silent" ? [] : [{ type: "text", text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason,
        timestamp: Date.now(),
      },
    });
  };
  if (options.apiKey === "synthetic-key-delayed-reply") setTimeout(emit, 600);
  else emit();
  return stream;
});

function systemPrompt(context) {
  const message = context.messages.find((candidate) => candidate.role === "system");
  if (!message || typeof message.content !== "string")
    throw new Error("Pi system prompt is missing");
  return message.content;
}

/**
 * Read back the newest result of one nested Mate tool this turn's loop called by name.
 *
 * This relies on Pi keeping the live turn's assistant `toolCall` parts (with `arguments.name`) in the
 * context it hands to the stream, and on the journal replay the worker builds from stored text never
 * producing such a part. Each scripted plan calls every tool it looks up exactly once, so the
 * newest-match scan cannot pick up a stale result from an earlier call of the same name.
 */
function nestedToolResult(context, name) {
  const matching = new Set();
  for (const message of context.messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content)
      if (part.type === "toolCall" && part.arguments?.name === name) matching.add(part.id);
  }
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index];
    if (message.role !== "toolResult" || !matching.has(message.toolCallId)) continue;
    const text = (Array.isArray(message.content) ? message.content : [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("");
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
