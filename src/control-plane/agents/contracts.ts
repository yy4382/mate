import { z } from "zod";
import { isSupportedModel, isSupportedModelProvider } from "../model-providers.js";

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

export type AgentProvisioningStatus = "provisioning" | "waiting_credentials" | "ready" | "failed";
export type AgentProvisioningStage =
  | "queued"
  | "checking_account"
  | "creating_account"
  | "preparing_home"
  | "verifying_identity"
  | "complete"
  | "failed";

export interface AgentSummary {
  id: string;
  nodeId: string;
  name: string;
  role: string;
  description: string;
  model: NewAgentRequest["model"];
  initialChannelId: string | null;
  sessionId: string;
  status: AgentProvisioningStatus;
  stage: AgentProvisioningStage;
  error: string | null;
  linuxIdentity: { username: string; uid: number; gid: number; home: string } | null;
  createdAt: number;
  updatedAt: number;
}
