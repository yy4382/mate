import { z } from "zod";

/** Only ordinary Agent commands and process controls cross this boundary. */
export const agentProcessOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("exec"),
      command: z.string().min(1).max(16_000),
      cwd: z.string().max(4096),
    })
    .strict(),
  z.object({ kind: z.literal("process.list") }).strict(),
  z
    .object({
      kind: z.literal("process.inspect"),
      targetOperationId: z.string().uuid(),
    })
    .strict(),
  z.object({ kind: z.literal("process.stop"), targetOperationId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("process.stop_all") }).strict(),
]);

export type AgentProcessOperation = z.infer<typeof agentProcessOperationSchema>;
export type AgentProcessOperationState = "started" | "succeeded" | "failed" | "unknown";
