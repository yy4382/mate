import {
  agentStopSchema,
  agentSummarySchema,
  modelCredentialSummarySchema,
  modelProviderSummarySchema,
  ownerChannelSchema,
} from "@mate/protocol/owner";
import { z } from "zod";

// Creation responses may omit the optional initial invitation; the screen does not require
// persistence timestamps or the session ID to render or retry the stable Agent request.
export const agentSchema = agentSummarySchema
  .partial({ initialChannelId: true, sessionId: true, createdAt: true, updatedAt: true })
  .loose();
export const channelSummarySchema = ownerChannelSchema
  .pick({ id: true, name: true, archived: true })
  .loose();
export const agentsResponseSchema = z.looseObject({ agents: z.array(agentSchema) });
export const agentResponseSchema = z.looseObject({ agent: agentSchema });
export const channelsResponseSchema = z.looseObject({ channels: z.array(channelSummarySchema) });
export const directChannelResponseSchema = z.looseObject({
  channel: ownerChannelSchema.pick({ id: true }).loose(),
});
export const providersResponseSchema = z.looseObject({
  providers: z.array(modelProviderSummarySchema.loose()),
});
export const credentialsResponseSchema = z.looseObject({
  credentials: z.array(modelCredentialSummarySchema.loose()),
});

export const activityPageSchema = z.looseObject({
  events: z.array(
    z.looseObject({
      sequence: z.number(),
      summary: z.string(),
      at: z.number(),
      detail: z.unknown().optional(),
    }),
  ),
  nodeOnline: z.boolean(),
  pausedReason: agentSummarySchema.shape.pausedReason,
  stop: agentStopSchema.loose().nullish(),
});
export const pauseResponseSchema = z.looseObject({ stop: agentStopSchema.loose().nullish() });
export type AgentSummary = z.infer<typeof agentSchema>;
export type ChannelSummary = z.infer<typeof channelSummarySchema>;
export type ActivityPage = z.infer<typeof activityPageSchema>;
