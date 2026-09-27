import { z } from "zod";

/** Leave room for the full JSON request envelope inside the 1 MiB WebSocket frame. */
export const WORKSPACE_WRITE_MAX_BYTES = 700 * 1024;
export const WORKSPACE_WRITE_BYTES_BASE64_MAX_CHARS = Math.ceil(WORKSPACE_WRITE_MAX_BYTES / 3) * 4;

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
      kind: z.literal("workspace_list"),
      path: z.string().max(4096),
      offset: z.number().int().min(0).max(1_000_000).default(0),
      limit: z.number().int().min(1).max(32).default(32),
    })
    .strict(),
  z.object({ kind: z.literal("workspace_stat"), path: z.string().max(4096) }).strict(),
  z
    .object({
      kind: z.literal("workspace_read_chunk"),
      path: z.string().max(4096),
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      length: z.number().int().min(1).max(8192),
      version: z
        .object({
          device: z.string().regex(/^[0-9]+$/),
          inode: z.string().regex(/^[0-9]+$/),
          size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          modifiedNs: z.string().regex(/^[0-9]+$/),
          changedNs: z.string().regex(/^[0-9]+$/),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("write_bytes"),
      path: z.string().max(4096),
      base64: z
        .string()
        .max(WORKSPACE_WRITE_BYTES_BASE64_MAX_CHARS)
        .refine(
          (value) => Buffer.from(value, "base64").toString("base64") === value,
          "Canonical base64 required",
        )
        .refine(
          (value) => Buffer.from(value, "base64").byteLength <= WORKSPACE_WRITE_MAX_BYTES,
          "Decoded binary file exceeds the 700 KiB workspace write limit",
        ),
    })
    .strict(),
  z.object({ kind: z.literal("read"), path: z.string().max(4096) }).strict(),
  z
    .object({
      kind: z.literal("write"),
      path: z.string().max(4096),
      content: z
        .string()
        .max(WORKSPACE_WRITE_MAX_BYTES)
        .refine(
          (value) => Buffer.byteLength(value, "utf8") <= WORKSPACE_WRITE_MAX_BYTES,
          "UTF-8 file exceeds the 700 KiB workspace write limit",
        ),
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
  /** Stable Agent operation identity, so one request is recognised across node restarts. */
  operationId?: string;
}
export interface ExecutionResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}
export interface ExecutionBackend {
  execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult>;
}
