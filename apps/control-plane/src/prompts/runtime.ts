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
    id: "run-recovery",
    source: "apps/control-plane/src/prompts/runtime.ts#runRecoveryMessage",
    condition: "恢复时末条记录为 error 或 aborted 的 assistant 响应",
    role: "user",
  },
  {
    id: "context-recovery",
    source: "apps/control-plane/src/prompts/runtime.ts#contextRecoveryMessage",
    condition: "普通请求上下文溢出后，强制压缩重试前",
    role: "user",
  },
  {
    id: "receipt-correction",
    source: "apps/control-plane/src/prompts/runtime.ts#receiptCorrectionMessage",
    condition: "恢复操作收据的新事实；canonical JSON 与去重由调用方负责",
    role: "user",
  },
  {
    id: "summary-replay",
    source: "apps/control-plane/src/prompts/runtime.ts#summaryMessage",
    condition: "已有控制面确认的压缩摘要，放在保留消息之前；时间戳为 0",
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

export function summaryMessage(summary: string): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text: `[会话压缩摘要]\n${summary}` }],
    timestamp: 0,
  };
}

export function runRecoveryMessage(): UserMessage {
  return {
    role: "user" as const,
    content:
      "[运行恢复] 上次模型响应未成功完成。请从已保存的工具结果和操作事实继续，不要重做结果未知的副作用。",
    timestamp: Date.now(),
  };
}
export function contextRecoveryMessage(): UserMessage {
  return {
    role: "user" as const,
    content:
      "[上下文恢复] 上次普通模型请求超出上下文容量。已保存的工具结果和操作事实仍有效；从压缩后的同一会话继续，不要重做结果未知的副作用。",
    timestamp: Date.now(),
  };
}
