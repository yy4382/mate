import type { UserMessage } from "@earendil-works/pi-ai";
import type { PromptSource } from "./types.js";

export const runtimeSources: PromptSource[] = [
  {
    id: "delivery",
    source: "apps/control-plane/src/prompts/runtime.ts#sourceMessage",
    condition: "新输入消息首次交付；使用来源频道、可见范围、讨论串与引用",
    role: "user",
  },
  {
    id: "notice",
    source: "apps/control-plane/src/prompts/runtime.ts#runNoticeMessage",
    condition: "运行中收到新消息提示；不带正文、不标已读",
    role: "user",
  },

  {
    id: "receipt-correction",
    source: "apps/control-plane/src/prompts/runtime.ts#receiptCorrectionMessage",
    condition: "恢复操作收据的新事实；canonical JSON 与去重由调用方负责",
    role: "user",
  },
];

export function sourceMessage(
  conversationId: string,
  input: {
    text: string;
    visibility: string;
    root_id: string | null;
    quote_id: string | null;
    created_at: number;
  },
): UserMessage {
  return {
    role: "user",
    timestamp: input.created_at,
    content: `[消息来源：频道 ${conversationId}；可见范围：${input.visibility === "public" ? "公开" : "私密"}；讨论串：${input.root_id ?? "无"}；引用：${input.quote_id ?? "无"}]\n${input.text}`,
  };
}

export function receiptCorrectionMessage(fact: string, timestamp: number): UserMessage {
  return { role: "user", content: `Mate 收据更正：${fact}`, timestamp };
}

export function runNoticeMessage(conversationId: string): UserMessage {
  return {
    role: "user",
    content: `[运行提示] 对话 ${conversationId} 有新消息到达。这条提示只说明有新消息，不含正文，也没有把任何消息标为已读；你可以用 conversations.read 或 attention.list 现在查看，也可以继续手上的工作，把它留给下一轮同一会话。`,
    timestamp: Date.now(),
  };
}
