import { z } from "zod";
import type { AgentProcessOperation } from "../nodes/process-operations.js";

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

const operationId = z.string().uuid();

/** Ordinary commands and self-process controls run as the Agent's provisioned Linux user. */
export const agentProcessToolOperations = Object.freeze({
  "process.exec": {
    description:
      "在自己的 Linux 用户和 home 目录下运行普通 shell 命令。命令有固定时间与输出上限；需要继续运行的任务可用 process.list、process.inspect 和 process.stop 查看或停止。",
    schema: z
      .object({ command: z.string().min(1).max(16_000), cwd: z.string().max(4096).optional() })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "process.list": {
    description: "列出自己当前由 Mate 管理的命令进程。",
    schema: z.object({}).strict(),
    seatPolicy: "deny" as const,
  },
  "process.inspect": {
    description: "查询一个由 process.exec 返回的操作 ID 当前是否仍在运行。",
    schema: z.object({ targetOperationId: operationId }).strict(),
    seatPolicy: "deny" as const,
  },
  "process.stop": {
    description: "停止一个由 process.exec 返回的操作 ID 对应的进程及其子进程。",
    schema: z.object({ targetOperationId: operationId }).strict(),
    seatPolicy: "deny" as const,
  },
});

export type AgentProcessToolOperation = keyof typeof agentProcessToolOperations;

/** Validate one public tool call and map it to the narrower node process protocol. */
export function toAgentProcessOperation(
  name: string,
  input: unknown,
): AgentProcessOperation | undefined {
  if (!Object.hasOwn(agentProcessToolOperations, name)) return undefined;
  switch (name as AgentProcessToolOperation) {
    case "process.exec": {
      const args = agentProcessToolOperations["process.exec"].schema.parse(input);
      return { kind: "exec", command: args.command, cwd: args.cwd ?? "." };
    }
    case "process.list":
      agentProcessToolOperations["process.list"].schema.parse(input);
      return { kind: "process.list" };
    case "process.inspect": {
      const args = agentProcessToolOperations["process.inspect"].schema.parse(input);
      return { kind: "process.inspect", targetOperationId: args.targetOperationId };
    }
    case "process.stop": {
      const args = agentProcessToolOperations["process.stop"].schema.parse(input);
      return { kind: "process.stop", targetOperationId: args.targetOperationId };
    }
  }
}

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
