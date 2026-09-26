import { z } from "zod";
export const operationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("read_bytes"),
      path: z.string().max(4096),
      offset: z.number().int().min(0).max(1000000),
      length: z.number().int().min(1).max(32768),
    })
    .strict(),
  z
    .object({
      kind: z.literal("write_bytes"),
      path: z.string().max(4096),
      base64: z
        .string()
        .max(1333336)
        .refine(
          (value) => Buffer.from(value, "base64").toString("base64") === value,
          "Canonical base64 required",
        ),
    })
    .strict(),
  z.object({ kind: z.literal("read"), path: z.string().max(4096) }).strict(),
  z
    .object({
      kind: z.literal("write"),
      path: z.string().max(4096),
      content: z.string().max(1000000),
    })
    .strict(),
  z.object({ kind: z.literal("list"), path: z.string().max(4096) }).strict(),
  z.object({ kind: z.literal("stat"), path: z.string().max(4096) }).strict(),
  z
    .object({
      kind: z.literal("search"),
      path: z.string().max(4096),
      query: z.string().min(1).max(1000),
    })
    .strict(),
  z.object({ kind: z.literal("mkdir"), path: z.string().min(1).max(4096) }).strict(),
  z
    .object({
      kind: z.literal("move"),
      path: z.string().min(1).max(4096),
      destination: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      kind: z.literal("remove"),
      path: z.string().min(1).max(4096),
      expectedHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("edit"),
      path: z.string().min(1).max(4096),
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
      oldText: z.string().min(1).max(1000000),
      newText: z.string().max(1000000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("exec"),
      command: z.string().min(1).max(16000),
      cwd: z.string().max(4096),
    })
    .strict(),
]);
export type Operation = z.infer<typeof operationSchema>;
export interface ExecutionRequest {
  root: string;
  operation: Operation;
  timeoutMs: number;
  agentId?: string;
  /** Stable Agent operation identity for the systemd scope that owns this command. */
  operationId?: string;
}
export interface ExecutionResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** Present when the host placed this command in an Agent-owned systemd scope. */
  processUnit?: string;
}
export interface ExecutionBackend {
  execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult>;
}
