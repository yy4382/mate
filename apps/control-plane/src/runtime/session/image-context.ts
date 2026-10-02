import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Request-time projection only: the durable transcript and its tool-call identities are untouched. */
export function projectImages(messages: AgentMessage[], vision: boolean): AgentMessage[] {
  if (vision) return messages;
  return messages.map((message) => {
    if (message.role !== "user" && message.role !== "toolResult" && message.role !== "system")
      return message;
    if (typeof message.content === "string") return message;
    return {
      ...message,
      content: message.content.map((block) =>
        block.type === "image"
          ? {
              type: "text",
              text: `[图片 ${block.mimeType}：当前文本上下文无法直接读取；原始图片保留在会话记录中。]`,
            }
          : block,
      ),
    };
  });
}
