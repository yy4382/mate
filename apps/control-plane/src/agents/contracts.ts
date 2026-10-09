import { z } from "zod";
import { isSupportedModel, isSupportedModelProvider } from "../providers/catalog.js";

export const newAgentRequestSchema = z
  .object({
    id: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    nodeId: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    role: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1000),
    model: z
      .object({
        provider: z
          .string()
          .trim()
          .regex(/^[a-z][a-z0-9._-]{0,63}$/)
          .refine(isSupportedModelProvider),
        id: z.string().trim().min(1).max(200),
      })
      .strict()
      .refine((model) => isSupportedModel(model.provider, model.id)),
    initialChannelId: z.string().uuid().optional(),
  })
  .strict();

export type NewAgentRequest = z.infer<typeof newAgentRequestSchema>;

export const agentProfilePatchSchema = newAgentRequestSchema
  .pick({ name: true, role: true, description: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0);

export const agentModelPatchSchema = newAgentRequestSchema.shape.model;

export type {
  AgentProvisioningStatus,
  AgentProvisioningStage,
  AgentSummary,
} from "@mate/protocol/owner";
