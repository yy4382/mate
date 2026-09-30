import { type ModelContextMessage, type SessionCommit } from "../../src/session-record.js";
import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";

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
