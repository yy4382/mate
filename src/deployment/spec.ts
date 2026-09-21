import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { agentIdSchema } from '../domain/agents.js';

const absolute = z.string().refine(isAbsolute, 'Absolute path required').refine(value => resolve(value) === value, 'Canonical lexical path required');
const capacityMiB = z.number().int().min(64).max(1024 * 1024);

export const deploymentSpecSchema = z.object({
  version: z.literal(1),
  release: z.object({ source: absolute, gitCommit: z.string().regex(/^[a-f0-9]{7,64}$/) }).strict(),
  configSource: absolute,
  environmentSource: absolute.optional(),
  privateWorkspaces: z.array(z.object({ agentId: agentIdSchema, capacityMiB }).strict()).default([]),
  externalWorkspaces: z.array(z.object({ root: absolute, capacityMiB }).strict()).default([]),
  stateReserveMiB: z.number().int().min(256).max(1024 * 1024).default(512),
  daemonMemoryMiB: z.number().int().min(128).max(8192).default(512),
}).strict();
export type DeploymentSpec = z.infer<typeof deploymentSpecSchema>;
