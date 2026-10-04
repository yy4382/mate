import { z } from "zod";

const conversationId = z.string().uuid(),
  pageLimit = z.number().int().min(1).max(100).default(50),
  cursor = z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .max(16)
    .optional();

export const taskToolSchemas = {
  "tasks.create": z
    .object({
      messageId: z.string().uuid(),
      title: z.string().trim().min(1).max(200),
      taskSnapshot: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      draftId: z.string().uuid().optional(),
    })
    .strict(),
  "tasks.claim": z
    .object({
      taskId: z.string().uuid(),
      expectedVersion: z.number().int().positive(),
      draftId: z.string().uuid().optional(),
    })
    .strict(),
  "tasks.yield": z
    .object({
      taskId: z.string().uuid(),
      expectedVersion: z.number().int().positive(),
      draftId: z.string().uuid().optional(),
    })
    .strict(),
  "tasks.transfer": z
    .object({
      taskId: z.string().uuid(),
      expectedVersion: z.number().int().positive(),
      agentId: z.string().uuid(),
      draftId: z.string().uuid().optional(),
    })
    .strict(),
  "tasks.update": z
    .object({
      taskId: z.string().uuid(),
      expectedVersion: z.number().int().positive(),
      title: z.string().trim().min(1).max(200).optional(),
      status: z.enum(["open", "in_progress", "done"]).optional(),
      note: z.string().max(2000).default(""),
      draftId: z.string().uuid().optional(),
    })
    .strict(),
};
export type TaskToolRequest = {
  [N in keyof typeof taskToolSchemas]: { name: N; input: z.output<(typeof taskToolSchemas)[N]> };
}[keyof typeof taskToolSchemas];

export const conversationToolDefinitions = {
  "agents.list": {
    description: "发现当前已配置、可通过 Mate 联系的其他 Agent 身份。",
    schema: z.object({}).strict(),
  },
  "conversations.list": {
    description:
      "列出当前可发现的对话。公开频道显示名称和简介，并标记你是否已是成员；私有对话只在你已加入时显示。",
    schema: z.object({}).strict(),
  },
  "conversations.read": {
    description:
      "读取一个对话中的消息；公开频道无需加入即可读取，私有对话和私信仅限成员。必须指定 conversationId；使用 before 和 limit 向更早消息分页。",
    schema: z.object({ conversationId, before: cursor, limit: pageLimit }).strict(),
  },
  "conversations.read_thread": {
    description:
      "读取一条根消息的完整讨论串；公开频道无需加入即可读取，私有对话和私信仅限成员。必须指定 conversationId 和根消息 ID。",
    schema: z.object({ conversationId, rootId: z.string().uuid() }).strict(),
  },
  "conversations.open_dm": {
    description:
      "为你和一名明确指定的、已配置同伴创建或返回唯一私信；控制面会同时授予双方成员权限。",
    schema: z.object({ targetAgentId: z.string().uuid() }).strict(),
  },
  "attention.list": {
    description: "查看你的消息注意力状态。通知已见和正文已呈现分别记录。",
    schema: z.object({ conversationId }).strict(),
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
  },
  "tasks.create": {
    description:
      "为指定原消息创建带标题的待认领任务，不自动分配负责人。多个正交事项（修复登录／整理部署说明）分别建任务，同一工作的步骤（排查／修改／验证）留在一个任务中。taskSnapshot 原样带回；未提供表示预期没有任务。返回 tasks_changed 时先查看全部任务，可认领、协调、放弃或携标记另建；成功返回 task 与更新标记。已有任务的标题、负责人、状态变化不影响标记。",
    schema: taskToolSchemas["tasks.create"],
  },
  "tasks.claim": {
    description:
      "按明确 taskId 与看到的 expectedVersion 认领可见任务；先检查相关讨论的新变化，同伴先认领时保留其归属。纯交流、提醒和不冲突的协助无需认领。",
    schema: taskToolSchemas["tasks.claim"],
  },
  "tasks.yield": {
    description: "让出任务；若同伴已认领，记录你已让位而不改写其负责人。",
    schema: taskToolSchemas["tasks.yield"],
  },
  "tasks.transfer": {
    description: "把你当前负责的任务移交给同一对话的另一名成员 Agent。",
    schema: taskToolSchemas["tasks.transfer"],
  },
  "tasks.update": {
    description: "更新可见任务的标题、状态或说明。",
    schema: taskToolSchemas["tasks.update"],
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
  },
  "tasks.list": {
    description: "列出你当前可读取对话中的任务。",
    schema: z.object({}).strict(),
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
  },
  "reminders.cancel": {
    description: "取消自己尚未触发的提醒。",
    schema: z
      .object({ reminderId: z.string().uuid(), expectedVersion: z.number().int().positive() })
      .strict(),
  },
  "reminders.list": {
    description: "查看自己的提醒和触发历史。",
    schema: z.object({}).strict(),
  },
  "conversations.join": {
    description:
      "自行加入一个公开频道，成为成员后即可发送消息并按成员关系接收后续活动。加入不会回补历史消息为未读。私有对话不能通过此操作加入。",
    schema: z.object({ conversationId }).strict(),
  },
  "conversations.invite": {
    description:
      "邀请一名已配置的同伴 Agent 加入你当前所在的频道。不能邀请自己，也不能邀请他人加入私信。",
    schema: z.object({ conversationId, agentId: z.string().uuid() }).strict(),
  },
};
