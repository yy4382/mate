// This test-only entry substitutes the network stream while exercising the same Pi Agent loop.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

let syntheticToolTurn = 0;

// Prevent the production entry guard from attaching the live provider stream a second time.
const workerMode = process.env.MATE_MODEL_WORKER;
delete process.env.MATE_MODEL_WORKER;
const { serveModelWorker } = await import("../../dist/src/nodes/model-worker.js");
process.env.MATE_MODEL_WORKER = workerMode;

serveModelWorker((model, context, options) => {
  const stream = createAssistantMessageEventStream();
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
      channelId = prompt.match(/本次回复目的地：频道 ([0-9a-f-]{36})/)?.[1];
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
