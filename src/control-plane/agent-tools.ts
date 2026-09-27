import { z } from "zod";
import type { AgentProcessOperation } from "../nodes/process-operations.js";
import {
  WORKSPACE_WRITE_BYTES_BASE64_MAX_CHARS,
  WORKSPACE_WRITE_MAX_BYTES,
} from "../execution/backend.js";
import { MAX_NODE_MESSAGE_BYTES } from "../nodes/protocol.js";
import { systemCommandSchema } from "../execution/system-command.js";

const conversationId = z.string().uuid(),
  workspacePath = z.string().max(4096),
  pageLimit = z.number().int().min(1).max(100).default(50),
  cursor = z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .max(16)
    .optional();

/** Control-plane-owned operation catalog; the node forwards these names and inputs unchanged. */
export const agentConversationOperations = Object.freeze({
  "session.compact": {
    description: "提交一份会话摘要和快照；控制面确认后，下一次运行从新模型会话及该摘要继续。",
    schema: z.object({ summary: z.string().min(1).max(20_000), snapshot: z.json() }).strict(),
    seatPolicy: "deny" as const,
  },
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
  "conversations.read_thread": {
    description: "读取一条根消息的完整讨论串。必须指定已加入对话和根消息 ID。",
    schema: z.object({ conversationId, rootId: z.string().uuid() }).strict(),
    seatPolicy: "deny" as const,
  },
  "conversations.open_dm": {
    description:
      "为你和一名明确指定的、已配置同伴创建或返回唯一私信；控制面会同时授予双方成员权限。",
    schema: z.object({ targetAgentId: z.string().uuid() }).strict(),
    seatPolicy: "deny" as const,
  },
  "attention.list": {
    description: "查看你的消息注意力状态。通知已见和正文已呈现分别记录。",
    schema: z.object({ conversationId }).strict(),
    seatPolicy: "deny" as const,
  },
  "attention.update": {
    description:
      "分别设置一条消息的未读、已见、暂缓或静音状态；正文已呈现由控制面在交付正文时记录。",
    schema: z
      .object({
        conversationId,
        messageId: z.string().uuid(),
        unread: z.boolean().optional(),
        seen: z.boolean().optional(),
        deferred: z.boolean().optional(),
        muted: z.boolean().optional(),
      })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "drafts.save": {
    description: "持久保存发送草稿和当前讨论位置。保存后可查看并发变化。",
    schema: z
      .object({
        conversationId,
        text: z.string().min(1).max(20_000),
        rootId: z.string().uuid().optional(),
        quoteId: z.string().uuid().optional(),
      })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "drafts.review": {
    description: "查看草稿后的讨论变化，并选择修改、保留、放弃、暂缓或知情继续。",
    schema: z
      .object({
        draftId: z.string().uuid(),
        choice: z.enum(["inspect", "revise", "keep", "abandon", "defer", "continue"]),
        text: z.string().min(1).max(20_000).optional(),
      })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "messages.send": {
    description:
      "向一个明确指定且当前已加入的频道或私信发送普通消息。发送目标必须提供 conversationId。",
    schema: z
      .object({
        conversationId,
        text: z.string().min(1).max(20_000),
        rootId: z.string().uuid().optional(),
        quoteId: z.string().uuid().optional(),
        draftId: z.string().uuid().optional(),
        asTask: z.boolean().optional(),
      })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "tasks.create": {
    description: "从你可读取的已有消息创建任务；消息是唯一规范锚点。",
    schema: z
      .object({ messageId: z.string().uuid(), draftId: z.string().uuid().optional() })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "tasks.claim_message": {
    description:
      "对一条你可读取的消息直接发起认领：该消息已有任务时认领那个任务（讨论串回复也可能带有自己的任务），否则创建并认领该讨论原顶层消息对应的任务；结果中的 messageId 是本次认领的任务锚点。已被同伴认领时返回 outcome=conflict 而不抢占，你仍可阅读、讨论或提供不冲突的协助。",
    schema: z
      .object({ messageId: z.string().uuid(), draftId: z.string().uuid().optional() })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "tasks.claim": {
    description: "认领一个可见任务；先检查相关讨论的新变化。",
    schema: z
      .object({
        taskId: z.string().uuid(),
        expectedVersion: z.number().int().positive(),
        draftId: z.string().uuid().optional(),
      })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "tasks.yield": {
    description: "让出任务；若同伴已认领，记录你已让位而不改写其负责人。",
    schema: z
      .object({
        taskId: z.string().uuid(),
        expectedVersion: z.number().int().positive(),
        draftId: z.string().uuid().optional(),
      })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "tasks.transfer": {
    description: "把你当前负责的任务移交给同一对话的另一名成员 Agent。",
    schema: z
      .object({
        taskId: z.string().uuid(),
        expectedVersion: z.number().int().positive(),
        agentId: z.string().uuid(),
        draftId: z.string().uuid().optional(),
      })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "tasks.update": {
    description: "更新可见任务的标题、状态或说明。",
    schema: z
      .object({
        taskId: z.string().uuid(),
        expectedVersion: z.number().int().positive(),
        title: z.string().trim().min(1).max(200).optional(),
        status: z.enum(["open", "in_progress", "done"]).optional(),
        note: z.string().max(2000).default(""),
        draftId: z.string().uuid().optional(),
      })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "tasks.review": {
    description: "检查任务操作期间出现的相关消息，选择修改、保留、放弃、暂缓或知情继续。",
    schema: z
      .object({
        draftId: z.string().uuid(),
        choice: z.enum(["inspect", "revise", "keep", "abandon", "defer", "continue"]),
        revisedInput: z.record(z.string(), z.json()).optional(),
      })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "tasks.list": {
    description: "列出你当前可读取对话中的任务。",
    schema: z.object({}).strict(),
    seatPolicy: "deny" as const,
  },
  "reminders.create": {
    description: "为自己建立一次性提醒，可关联任务；任务完成后提醒仍然有效。",
    schema: z
      .object({
        conversationId,
        text: z.string().trim().min(1).max(2000),
        dueAt: z.number().int().positive(),
        taskId: z.string().uuid().optional(),
      })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "reminders.reschedule": {
    description: "修改自己尚未触发的提醒时间。",
    schema: z
      .object({
        reminderId: z.string().uuid(),
        expectedVersion: z.number().int().positive(),
        dueAt: z.number().int().positive(),
      })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "reminders.cancel": {
    description: "取消自己尚未触发的提醒。",
    schema: z
      .object({ reminderId: z.string().uuid(), expectedVersion: z.number().int().positive() })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "reminders.list": {
    description: "查看自己的提醒和触发历史。",
    schema: z.object({}).strict(),
    seatPolicy: "deny" as const,
  },
  "conversations.invite": {
    description:
      "邀请一名已配置的同伴 Agent 加入你当前所在的频道。不能邀请自己，也不能邀请他人加入私信。",
    schema: z.object({ conversationId, agentId: z.string().uuid() }).strict(),
    seatPolicy: "deny" as const,
  },
});

const workspaceVersion = z
  .object({
    device: z.string().regex(/^[0-9]+$/),
    inode: z.string().regex(/^[0-9]+$/),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    modifiedNs: z.string().regex(/^[0-9]+$/),
    changedNs: z.string().regex(/^[0-9]+$/),
  })
  .strict();

/** File tools cross the control plane and run under the Agent's provisioned Linux account. */
export const agentWorkspaceOperations = Object.freeze({
  "workspace.list": {
    description: "列出你私人 home 中的目录。使用 path 指定相对路径；支持 offset 和 limit 分页。",
    schema: z
      .object({
        path: workspacePath,
        offset: z.number().int().min(0).max(1_000_000).default(0),
        limit: z.number().int().min(1).max(32).default(32),
      })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "workspace.stat": {
    description: "查看你私人 home 中文件或目录的类型和大小。",
    schema: z.object({ path: workspacePath }).strict(),
    seatPolicy: "deny" as const,
  },
  "workspace.read": {
    description:
      "读取私人 home 中不超过 8 KiB 的 UTF-8 文本文件；更大的文件使用 read_chunk 分页读取。",
    schema: z.object({ path: workspacePath }).strict(),
    seatPolicy: "deny" as const,
  },
  "workspace.read_chunk": {
    description:
      "分块读取私人 home 中的文件；每次最多 8 KiB，并用返回的 version 继续读取同一版本。",
    schema: z
      .object({
        path: workspacePath,
        offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        length: z.number().int().min(1).max(8192).default(8192),
        version: workspaceVersion.optional(),
      })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "workspace.write": {
    description:
      "在私人 home 中写入或替换不超过 700 KiB 的 UTF-8 文本文件，且完整请求必须适合 1 MiB 节点消息。每次修改会由控制面记录并使用持久收据。",
    schema: z
      .object({
        path: workspacePath,
        content: z
          .string()
          .max(WORKSPACE_WRITE_MAX_BYTES)
          .refine((value) => Buffer.byteLength(value, "utf8") <= WORKSPACE_WRITE_MAX_BYTES),
      })
      .strict()
      .superRefine((input, context) => {
        const worstCaseRequest = {
          type: "node.agent.run.tool",
          requestId: "00000000-0000-4000-8000-000000000000",
          runId: "00000000-0000-4000-8000-000000000000",
          agentId: "00000000-0000-4000-8000-000000000000",
          toolCallId: "t".repeat(500),
          operation: "tools.call",
          input: { name: "workspace.write", input },
        };
        if (Buffer.byteLength(JSON.stringify(worstCaseRequest), "utf8") > MAX_NODE_MESSAGE_BYTES)
          context.addIssue({
            code: "custom",
            message: "完整 workspace.write 请求超过 1 MiB 节点消息上限，请缩小文本。",
          });
      }),
    seatPolicy: "deny" as const,
  },
  "workspace.write_bytes": {
    description:
      "在私人 home 中写入或替换不超过 700 KiB 的二进制文件，内容使用标准 base64；更大的附件请使用流式附件发布。",
    schema: z
      .object({
        path: workspacePath,
        base64: z
          .string()
          .max(WORKSPACE_WRITE_BYTES_BASE64_MAX_CHARS)
          .refine((value) => Buffer.from(value, "base64").toString("base64") === value)
          .refine((value) => Buffer.from(value, "base64").byteLength <= WORKSPACE_WRITE_MAX_BYTES),
      })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "workspace.edit": {
    description:
      "expectedHash 必须在编辑检查时匹配、oldText 必须唯一出现；Mate 工作区写操作会串行并在提交前复核，但普通命令、后台进程或绕过 Mate 的同 UID 写入仍可能与最终替换竞争。",
    schema: z
      .object({
        path: workspacePath,
        expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
        oldText: z.string().min(1).max(1_000_000),
        newText: z.string().max(1_000_000),
      })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "workspace.mkdir": {
    description: "在私人 home 中创建目录。",
    schema: z.object({ path: z.string().min(1).max(4096) }).strict(),
    seatPolicy: "deny" as const,
  },
  "workspace.move": {
    description: "在私人 home 内移动或重命名文件；源和目标都必须留在私人 home。",
    schema: z
      .object({ path: z.string().min(1).max(4096), destination: z.string().min(1).max(4096) })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "workspace.remove": {
    description: "删除私人 home 中的文件；如提供 expectedHash，文件必须仍与该摘要相符。",
    schema: z
      .object({
        path: z.string().min(1).max(4096),
        expectedHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "attachments.list": {
    description: "查看你已加入对话中的附件。",
    schema: z.object({ conversationId }).strict(),
    seatPolicy: "deny" as const,
  },
  "attachments.read_chunk": {
    description: "分块读取已加入对话中的附件；每次最多 8 KiB。",
    schema: z
      .object({
        conversationId,
        attachmentId: z.string().uuid(),
        offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        length: z.number().int().min(1).max(8192).default(8192),
      })
      .strict(),
    seatPolicy: "deny" as const,
  },
  "attachments.publish": {
    description:
      "把你私人 home 中的一份文件发布到你已加入且明确指定的对话附件中；必须提供 conversationId。",
    schema: z
      .object({
        conversationId,
        path: z.string().min(1).max(4096),
        filename: z.string().max(255).optional(),
      })
      .strict(),
    seatPolicy: "deny" as const,
  },
});

export const agentMateOperations = Object.freeze({
  ...agentConversationOperations,
  ...agentWorkspaceOperations,
});

export type AgentConversationOperation = keyof typeof agentConversationOperations;
export type AgentWorkspaceOperation = keyof typeof agentWorkspaceOperations;
export type AgentMateOperation = keyof typeof agentMateOperations;

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

export const agentSystemToolOperations = Object.freeze({
  "system.exec": {
    description:
      "申请一条系统特权命令。必须提供程序绝对路径、各个参数和绝对工作目录；所有者在 Mate 对话卡完整审阅并批准后，节点才可能以 root 执行。十分钟内未开始即失效。",
    schema: systemCommandSchema,
    seatPolicy: "deny" as const,
  },
  "system.status": {
    description: "查询自己一条系统特权请求的审批与执行结果。",
    schema: z.object({ requestId: z.string().uuid() }).strict(),
    seatPolicy: "deny" as const,
  },
});

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
