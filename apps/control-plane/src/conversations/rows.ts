import {
  channelVisibilitySchema,
  ownerPrincipalKindSchema,
  ownerTaskSchema,
  ownerReminderSchema,
} from "@mate/protocol/owner";
import { z } from "zod";
import type { OwnerChannel, OwnerMessage, OwnerTask, OwnerReminder } from "@mate/protocol/owner";
export const channelRowSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  visibility: channelVisibilitySchema,
  archived: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type ChannelRow = z.infer<typeof channelRowSchema>;

export const messageRowSchema = z.looseObject({
  id: z.string(),
  channel_id: z.string(),
  order_seq: z.number(),
  text: z.string(),
  root_id: z.string().nullable().optional(),
  quote_id: z.string().nullable().optional(),
  author_kind: ownerPrincipalKindSchema,
  author_id: z.string(),
  created_at: z.number(),
});
export type MessageRow = z.infer<typeof messageRowSchema>;

export const taskRowSchema = z.looseObject({
  id: z.string(),
  message_id: z.string(),
  channel_id: z.string(),
  title: z.string(),
  status: ownerTaskSchema.shape.status,
  owner_agent_id: z.string().nullable(),
  owner_agent_name: z.string().nullable(),
  version: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type TaskRow = z.infer<typeof taskRowSchema>;

export const reminderRowSchema = z.looseObject({
  id: z.string(),
  agent_id: z.string(),
  channel_id: z.string(),
  task_id: z.string().nullable(),
  text: z.string(),
  due_at: z.number(),
  state: ownerReminderSchema.shape.state,
  version: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type ReminderRow = z.infer<typeof reminderRowSchema>;

export const taskDraftRowSchema = z.looseObject({
  id: z.string(),
  agent_id: z.string(),
  task_id: z.string().nullable(),
  action: z.string(),
  input_json: z.string(),
  input_end_seq: z.number(),
  state: z.string(),
});
export type TaskDraftRow = z.infer<typeof taskDraftRowSchema>;

export const eventRowSchema = z.looseObject({
  seq: z.number(),
  kind: z.string(),
  channel_id: z.string(),
  payload: z.string(),
  created_at: z.number(),
});
export type EventRow = z.infer<typeof eventRowSchema>;

export const pendingDeliveryRowSchema = z.looseObject({
  delivery_sequence: z.number(),
  delivery_id: z.string(),
  message_id: z.string(),
  channel_id: z.string(),
  recipient_kind: ownerPrincipalKindSchema,
  recipient_id: z.string(),
  state: z.literal("pending"),
  delivery_created_at: z.number(),
  order_seq: z.number(),
  text: z.string(),
  root_id: z.string().nullable(),
  quote_id: z.string().nullable(),
  author_kind: ownerPrincipalKindSchema,
  author_id: z.string(),
  created_at: z.number(),
});
export type PendingDeliveryRow = z.infer<typeof pendingDeliveryRowSchema>;

export function toChannel(row: ChannelRow): OwnerChannel {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toMessage(row: MessageRow): OwnerMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    rootId: row.root_id ?? null,
    quoteId: row.quote_id ?? null,
    replyCount: 0,
    recentReplies: [],
    author:
      row.author_kind === "agent"
        ? { kind: "agent", id: row.author_id }
        : { kind: "human", id: "owner" },
    text: row.text,
    order: String(row.order_seq),
    createdAt: row.created_at,
  };
}

export function toTask(row: TaskRow): OwnerTask {
  return {
    id: row.id,
    messageId: row.message_id,
    channelId: row.channel_id,
    title: row.title,
    status: row.status,
    ownerAgentId: row.owner_agent_id,
    ownerAgentName: row.owner_agent_name,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toReminder(row: ReminderRow): OwnerReminder {
  return {
    id: row.id,
    agentId: row.agent_id,
    channelId: row.channel_id,
    taskId: row.task_id,
    text: row.text,
    dueAt: row.due_at,
    state: row.state,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const agentDraftRowSchema = z.looseObject({
  id: z.string(),
  agent_id: z.string(),
  channel_id: z.string(),
  root_id: z.string().nullable(),
  quote_id: z.string().nullable(),
  text: z.string(),
  input_end_seq: z.number(),
  state: z.string(),
});
export type AgentDraftRow = z.infer<typeof agentDraftRowSchema>;
export const conversationRowSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  visibility: channelVisibilitySchema,
  conversation_kind: z.enum(["channel", "dm"]),
  active_member: z.number().nullable(),
});
export type ConversationRow = z.infer<typeof conversationRowSchema>;
