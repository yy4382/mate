import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { configSchema } from '../config.js';
const path = z.string().refine(isAbsolute, 'Absolute path required');
export const daemonConfigSchema = z.object({
  mate: configSchema,
  runtime: z.object({
    dataDir: path,
    docker: z.object({ binary: path, host: z.string().startsWith('unix:///'), image: z.string().regex(/^sha256:[a-f0-9]{64}$/),network:z.enum(['none','bridge']).optional() }).strict().optional(),
    workspaceGrants: z.array(z.object({ agentId: z.string(), root: path, operations: z.array(z.enum(['read','write','exec'])).min(1) }).strict()).default([]),
    researchHosts: z.array(z.string().regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/)).default([]),
  }).strict()
}).strict().superRefine((c, ctx) => { for (const grant of c.runtime.workspaceGrants) {
  if (!c.mate.agents.some(a => a.id === grant.agentId)) ctx.addIssue({ code: 'custom', message: 'Unknown grant agent' });
  if (grant.operations.includes('exec') && !c.runtime.docker) ctx.addIssue({ code: 'custom', message: 'Execution grants require container configuration' });
} });
export type DaemonConfig = z.infer<typeof daemonConfigSchema>;

/** Config identity is structural. Wire requests use a different, immutable byte hash. */
export function sameConfiguration(left: DaemonConfig, right: DaemonConfig): boolean {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
    }
    return value;
  };
  return JSON.stringify(normalize(daemonConfigSchema.parse(left))) === JSON.stringify(normalize(daemonConfigSchema.parse(right)));
}
