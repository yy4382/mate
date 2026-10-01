import { z } from "zod";
import { ownerChannelSchema } from "@mate/protocol/owner";

/** Facts an Agent may discover without gaining membership or changing attention. */
export const agentConversationFactsSchema = ownerChannelSchema
  .pick({
    id: true,
    name: true,
    description: true,
    visibility: true,
  })
  .extend({ kind: z.enum(["channel", "dm"]) });
export type AgentConversationFacts = z.infer<typeof agentConversationFactsSchema>;

export const newChannelSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500),
    visibility: z.enum(["public", "private"]),
  })
  .strict();
export const updateChannelSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).optional(),
    visibility: z.enum(["public", "private"]).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
export const newMessageSchema = z
  .object({
    text: z.string().trim().min(1).max(20_000),
    rootId: z.string().uuid().optional(),
    quoteId: z.string().uuid().optional(),
    asTask: z.boolean().optional(),
  })
  .strict()
  .refine((value) => !(value.rootId && value.quoteId));
export const ownerChannelInvitationSchema = z.object({ agentId: z.string().uuid() }).strict();

export type NewOwnerChannel = z.output<typeof newChannelSchema>;
export type OwnerChannelUpdate = z.output<typeof updateChannelSchema>;
