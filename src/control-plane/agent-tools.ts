import { z } from "zod";

const conversationId = z.string().uuid(),
  pageLimit = z.number().int().min(1).max(100).default(50),
  cursor = z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .max(16)
    .optional();

/** Control-plane-owned operation catalog; the node forwards these names and inputs unchanged. */
export const agentConversationOperations = Object.freeze({
  "agents.list": {
    description: "发现当前已配置、可通过 Mate 联系的其他 Agent 身份。",
    schema: z.object({}).strict(),
    seatPolicy: "deny" as const,
  },
  "conversations.list": {
    description: "列出当前可发现的对话。公开频道只显示名称和简介；私有对话只在你已加入时显示。",
    schema: z.object({}).strict(),
    seatPolicy: "deny" as const,
  },
  "conversations.read": {
    description:
      "读取一个已加入对话中的消息。必须指定 conversationId；使用 before 和 limit 向更早消息分页。",
    schema: z.object({ conversationId, before: cursor, limit: pageLimit }).strict(),
    seatPolicy: "deny" as const,
  },
  "conversations.open_dm": {
    description:
      "为你和一名明确指定的、已配置同伴创建或返回唯一私信；控制面会同时授予双方成员权限。",
    schema: z.object({ targetAgentId: z.string().uuid() }).strict(),
    seatPolicy: "deny" as const,
  },
  "messages.send": {
    description:
      "向一个明确指定且当前已加入的频道或私信发送普通消息。发送目标必须提供 conversationId。",
    schema: z.object({ conversationId, text: z.string().min(1).max(20_000) }).strict(),
    seatPolicy: "deny" as const,
  },
  "conversations.invite": {
    description:
      "邀请一名已配置的同伴 Agent 加入你当前所在的频道。不能邀请自己，也不能邀请他人加入私信。",
    schema: z.object({ conversationId, agentId: z.string().uuid() }).strict(),
    seatPolicy: "deny" as const,
  },
});

export type AgentConversationOperation = keyof typeof agentConversationOperations;

export const agentToolSchemas = {
  "tools.list": z.object({}).strict(),
  "tools.describe": z.object({ name: z.string().min(1).max(128) }).strict(),
  "tools.call": z
    .object({
      name: z.string().min(1).max(128),
      input: z.record(z.string(), z.json()),
    })
    .strict(),
};

export type AgentToolOperation = keyof typeof agentToolSchemas;
