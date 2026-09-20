import { z } from 'zod';

const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const secretRef = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const agentSchema = z.object({
  id, name: z.string().min(1), role: z.string().min(1),
  slackAppId: z.string().regex(/^A[A-Z0-9]+$/),
  slackUserId: z.string().regex(/^U[A-Z0-9]+$/),
  slackBotId: z.string().regex(/^B[A-Z0-9]+$/),
  botTokenEnv: secretRef, appTokenEnv: secretRef,
  model: z.object({ provider: z.string().min(1), id: z.string().min(1), apiKeyEnv: secretRef }).strict(),
  channels: z.record(z.string().regex(/^[CDG][A-Z0-9]+$/), z.enum(['mentions', 'participate'])),
}).strict();

export const configSchema = z.object({
  teamId: z.string().regex(/^T[A-Z0-9]+$/),
  ownerUserIds: z.array(z.string().regex(/^U[A-Z0-9]+$/)).min(1),
  agents: z.array(agentSchema).min(1),
  budgets: z.object({ maxRuns: z.number().int().positive(), maxTokens: z.number().int().positive(),
    maxCostUsd: z.number().positive(), runTimeoutMs: z.number().int().positive() }).strict(),
}).strict().superRefine((config, ctx) => {
  if (config.agents.some(agent => config.ownerUserIds.includes(agent.slackUserId))) {
    ctx.addIssue({ code: 'custom', message: 'Owner identity must not be an agent bot identity' });
  }
  for (const key of ['id', 'slackAppId', 'slackUserId', 'slackBotId', 'botTokenEnv', 'appTokenEnv'] as const) {
    const values = config.agents.map(a => a[key]);
    if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', message: `Duplicate agent ${key}` });
  }
});
export type MateConfig = z.infer<typeof configSchema>;
export type AgentConfig = MateConfig['agents'][number];

/** Errors contain reference names only, never secret values. */
export function requireSecret(env: NodeJS.ProcessEnv, reference: string): string {
  secretRef.parse(reference);
  const value = env[reference];
  if (!value?.trim()) throw new Error(`Missing secret environment variable: ${reference}`);
  return value;
}
