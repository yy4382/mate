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
export function assistantEntry(text: string, id = randomUUID()) {
  return { id, message: assistantMessage(text) };
}
