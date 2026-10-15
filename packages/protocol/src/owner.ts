import { z } from "zod";

/** Owner-facing wire projections. Keep server-only validation and dependencies out of this module. */
export const channelVisibilitySchema = z.enum(["public", "private"]);
export const ownerPrincipalKindSchema = z.enum(["human", "agent"]);

const authorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), id: z.literal("owner") }),
  z.object({ kind: z.literal("agent"), id: z.string() }),
]);

export const ownerChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  visibility: channelVisibilitySchema,
  archived: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const ownerMessageSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  rootId: z.string().nullable(),
  quoteId: z.string().nullable(),
  replyCount: z.number(),
  get recentReplies(): z.ZodArray<typeof ownerMessageSchema> {
    return z.array(ownerMessageSchema);
  },
  author: authorSchema,
  text: z.string(),
  order: z.string(),
  createdAt: z.number(),
});

export const ownerTaskSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  channelId: z.string(),
  title: z.string(),
  status: z.enum(["open", "in_progress", "done"]),
  ownerAgentId: z.string().nullable(),
  ownerAgentName: z.string().nullable(),
  version: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const ownerReminderSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  channelId: z.string(),
  taskId: z.string().nullable(),
  text: z.string(),
  dueAt: z.number(),
  state: z.enum(["active", "fired", "cancelled"]),
  version: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const ownerMessagePageSchema = z.object({
  messages: z.array(ownerMessageSchema),
  nextBefore: z.string().nullable(),
});

export const ownerMessageDeliverySchema = z.object({
  sequence: z.number(),
  id: z.string(),
  messageId: z.string(),
  channelId: z.string(),
  recipient: z.object({ kind: ownerPrincipalKindSchema, id: z.string() }),
  state: z.literal("pending"),
  createdAt: z.number(),
  message: ownerMessageSchema,
});

export const ownerMessageDeliveryPageSchema = z.object({
  deliveries: z.array(ownerMessageDeliverySchema),
  nextAfter: z.number().nullable(),
});

export const ownerChatSnapshotSchema = z.object({
  channels: z.array(ownerChannelSchema),
  cursor: z.number(),
});

export const ownerChatEventSchema = z.object({
  seq: z.number(),
  kind: z.string(),
  channelId: z.string(),
  payload: z.unknown(),
  createdAt: z.number(),
});

export const attachmentSummarySchema = z.object({
  id: z.string(),
  channelId: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  sha256: z.string(),
  uploader: authorSchema,
  createdAt: z.number(),
});

export const nodeSummarySchema = z.object({
  id: z.string(),
  online: z.boolean(),
  lastConnectedAt: z.string().nullable(),
});

export const agentThinkingLevelSchema = z.enum(["default", "low", "medium", "high"]);
export type AgentThinkingLevel = z.infer<typeof agentThinkingLevelSchema>;
export const agentThinkingEffortSchema = agentThinkingLevelSchema.exclude(["default"]);

export const modelProviderSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      thinkingLevels: z.array(agentThinkingEffortSchema).optional(),
    }),
  ),
});

export const modelCredentialSummarySchema = z.object({
  provider: z.string(),
  configured: z.literal(true),
  updatedAt: z.number(),
});

export const agentProvisioningStatusSchema = z.enum([
  "provisioning",
  "waiting_credentials",
  "ready",
  "failed",
]);

export const agentProvisioningStageSchema = z.enum([
  "queued",
  "checking_account",
  "preparing_workspace",
  "verifying_workspace",
  "complete",
  "failed",
]);

export const agentStopSchema = z.object({
  state: z.string(),
  receipt: z.unknown(),
  scope: z.string().optional(),
  unconfirmedOperationIds: z.array(z.string()).optional(),
});

export const agentSummarySchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  name: z.string(),
  role: z.string(),
  description: z.string(),
  model: z.object({
    provider: z.string(),
    id: z.string(),
    thinkingLevel: agentThinkingLevelSchema.optional(),
  }),
  initialChannelId: z.string().nullable(),
  sessionId: z.string(),
  status: agentProvisioningStatusSchema,
  stage: agentProvisioningStageSchema,
  error: z.string().nullable(),
  /** All Agents on one node share its ordinary host account and have their own workspace. */
  linuxIdentity: z
    .object({ username: z.string(), uid: z.number(), gid: z.number(), workspace: z.string() })
    .nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  pausedReason: z.enum(["manual", "credentials", "context"]).nullable().optional(),
  stop: agentStopSchema.nullable().optional(),
});

export type ChannelVisibility = z.infer<typeof channelVisibilitySchema>;
export type OwnerPrincipalKind = z.infer<typeof ownerPrincipalKindSchema>;
export type OwnerChannel = z.infer<typeof ownerChannelSchema>;
export type OwnerMessage = z.infer<typeof ownerMessageSchema>;
export type OwnerTask = z.infer<typeof ownerTaskSchema>;
export type OwnerReminder = z.infer<typeof ownerReminderSchema>;
export type OwnerMessagePage = z.infer<typeof ownerMessagePageSchema>;
export type OwnerMessageDelivery = z.infer<typeof ownerMessageDeliverySchema>;
export type OwnerMessageDeliveryPage = z.infer<typeof ownerMessageDeliveryPageSchema>;
export type OwnerChatSnapshot = z.infer<typeof ownerChatSnapshotSchema>;
export type OwnerChatEvent = z.infer<typeof ownerChatEventSchema>;
export type AttachmentSummary = z.infer<typeof attachmentSummarySchema>;
export type NodeSummary = z.infer<typeof nodeSummarySchema>;
export type ModelProviderSummary = z.infer<typeof modelProviderSummarySchema>;
export type ModelCredentialSummary = z.infer<typeof modelCredentialSummarySchema>;
export type AgentProvisioningStatus = z.infer<typeof agentProvisioningStatusSchema>;
export type AgentProvisioningStage = z.infer<typeof agentProvisioningStageSchema>;
export type AgentStop = z.infer<typeof agentStopSchema>;
export type AgentSummary = z.infer<typeof agentSummarySchema>;
