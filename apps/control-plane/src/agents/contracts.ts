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

export const agentProfilePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    role: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

export const agentModelPatchSchema = newAgentRequestSchema.shape.model;

export type AgentProvisioningStatus = "provisioning" | "waiting_credentials" | "ready" | "failed";
export type AgentProvisioningStage =
  | "queued"
  | "checking_account"
  | "preparing_workspace"
  | "verifying_workspace"
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
  /**
   * The single account this Agent's node runs under, plus this Agent's own workspace path. Every
   * Agent on one node reports the same username, UID and GID with a different workspace.
   */
  linuxIdentity: { username: string; uid: number; gid: number; workspace: string } | null;
  createdAt: number;
  updatedAt: number;
}
