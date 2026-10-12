import { type AssistantMessage, type Model } from "@earendil-works/pi-ai";
export const model: Model<"openai-completions"> = {
  id: "synthetic",
  name: "synthetic",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://invalid.example",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10000,
  maxTokens: 1000,
};
export function answer(
  content: AssistantMessage["content"],
  stopReason: "stop" | "toolUse" = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    stopReason,
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    usage: {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
export function deferred() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, resolve };
}
