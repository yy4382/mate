import { z } from 'zod';

// Stable internal identity is independent of provider installation and credentials.
export const agentIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const secretReferenceSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
export const agentDefinitionSchema = z.object({
  id: agentIdSchema,
  name: z.string().min(1),
  role: z.string().min(1),
  model: z.object({
    provider: z.string().min(1),
    id: z.string().min(1),
    apiKeyEnv: secretReferenceSchema,
  }).strict(),
}).strict();
export const budgetSettingsSchema = z.object({
  maxRuns: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  maxCostUsd: z.number().positive(),
  runTimeoutMs: z.number().int().positive(),
}).strict();
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type BudgetSettings = z.infer<typeof budgetSettingsSchema>;
export interface TeamSettings {
  agents: readonly AgentDefinition[];
  ownerUserIds: readonly string[];
  budgets: BudgetSettings;
}

/** Project only owned fields. Never leak adapter bindings to worker factories or prompts. */
export function agentDefinition(input: AgentDefinition): AgentDefinition {
  const { id, name, role, model } = input;
  return agentDefinitionSchema.parse({ id, name, role, model });
}
