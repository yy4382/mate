import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

const absolute = z
  .string()
  .refine(isAbsolute, "Absolute path required")
  .refine((value) => resolve(value) === value, "Canonical lexical path required");

export const deploymentSpecSchema = z
  .object({
    version: z.literal(1),
    release: z
      .object({
        source: absolute,
        gitCommit: z.string().regex(/^[a-f0-9]{7,64}$/),
      })
      .strict(),
    configSource: absolute,
    environmentSource: absolute.optional(),
    stateReserveMiB: z
      .number()
      .int()
      .min(256)
      .max(1024 * 1024)
      .default(512),
    daemonMemoryMiB: z.number().int().min(128).max(8192).default(512),
  })
  .strict();
export type DeploymentSpec = z.infer<typeof deploymentSpecSchema>;
