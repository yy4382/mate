import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelContextMessage, SessionCommit } from "@mate/protocol";

export function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4o-mini",
    stopReason: "stop",
    timestamp: 1,
    usage: {
      input: 12,
      output: 3,
      cacheRead: 8,
      cacheWrite: 0,
      totalTokens: 23,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
export function assistantEntry(text: string, id = randomUUID()): SessionCommit {
  return { kind: "message", id, message: assistantMessage(text) };
}
export function assistantText(entry: SessionCommit): string | undefined {
  if (entry.kind !== "message" || entry.message.role !== "assistant") return undefined;
  return entry.message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}
export function inputMessage(
  text: string,
  channelId: string,
  visibility = "private",
): ModelContextMessage {
  return {
    id: randomUUID(),
    actionScopeId: randomUUID(),
    message: {
      role: "user",
      timestamp: 1,
      content: `[消息来源：频道 ${channelId}；可见范围：${visibility === "private" ? "私密" : "公开"}]\n${text}`,
    },
  };
}

/** Fake model consumer for scheduling tests: commit each presented input, then expose readable assertions. */
export async function consumeContextPage(
  app: { nodes: { receive(socket: any, raw: string): Promise<void> } },
  socket: { sent: string[] },
  runId: string,
  agentId: string,
) {
  const page = JSON.parse(socket.sent.at(-1)!) as {
    messages: ModelContextMessage[];
    nextCursor: number | null;
  };
  let sourceChannelId: string | undefined, sourceVisibility: string | undefined;
  const messages = [];
  for (const entry of page.messages) {
    if (entry.pending)
      await app.nodes.receive(
        socket,
        JSON.stringify({
          type: "node.agent.run.transcript",
          runId,
          agentId,
          requestId: entry.id,
          entry: { kind: "message", id: entry.id, message: entry.message },
        }),
      );
    const content = entry.message.content;
    let text =
      typeof content === "string"
        ? content
        : content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
    if (text.startsWith("[消息来源")) {
      sourceChannelId = text.match(/频道 ([0-9a-f-]+)/)?.[1];
      sourceVisibility = text.includes("可见范围：公开") ? "public" : "private";
      text = text.split("\n").slice(1).join("\n");
    }
    messages.push({
      role: entry.message.role,
      text,
      sourceChannelId,
      sourceVisibility,
      currentRunInput: entry.pending === true,
    });
  }
  return { messages, nextCursor: page.nextCursor };
}
