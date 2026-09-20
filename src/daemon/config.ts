import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { configSchema } from '../config.js';
const path = z.string().refine(isAbsolute, 'Absolute path required');
export const daemonConfigSchema = z.object({
  mate: configSchema,
  runtime: z.object({
    dataDir: path,
    docker: z.object({ binary: path, host: z.string().startsWith('unix:///'), image: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict().optional(),
    workspaceGrants: z.array(z.object({ agentId: z.string(), root: path, operations: z.array(z.enum(['read','write','exec'])).min(1), exactCommands: z.array(z.object({ command: z.string(), cwd: z.string() }).strict()).default([]) }).strict()).default([]),
    researchHosts: z.array(z.string().regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/)).default([]),
  }).strict()
}).strict().superRefine((c, ctx) => { for (const grant of c.runtime.workspaceGrants) {
  if (!c.mate.agents.some(a => a.id === grant.agentId)) ctx.addIssue({ code: 'custom', message: 'Unknown grant agent' });
  if (grant.operations.includes('exec') && !c.runtime.docker) ctx.addIssue({ code: 'custom', message: 'Execution grants require container configuration' });
} });
export type DaemonConfig = z.infer<typeof daemonConfigSchema>;
