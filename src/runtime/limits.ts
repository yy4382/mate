import { z } from "zod";

/** What one Mate process may run at the same time. Deployment configuration and embedded
 * entries read the same definition, so a local entry cannot silently admit more than a
 * deployed daemon would. */
export const runtimeLimitsSchema = z
  .object({
    maxActiveRuns: z.number().int().min(1).max(32),
    maxBackendOperations: z.number().int().min(1).max(32),
    workerIdleMs: z.number().int().min(1).max(3600000),
  })
  .strict();
export type RuntimeLimits = z.infer<typeof runtimeLimitsSchema>;
export const defaultRuntimeLimits: RuntimeLimits = Object.freeze({
  maxActiveRuns: 1,
  maxBackendOperations: 1,
  workerIdleMs: 300000,
});
