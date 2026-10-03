import { ownerMessageSchema, ownerTaskSchema } from "@mate/protocol/owner";
import { z } from "zod";

const taskResultSchema = z.looseObject({ task: ownerTaskSchema });
/** Projections of actual business results needed by model scripts, never fabricated tool results. */
export const scriptedToolResultSchemas = {
  "conversations.read": z.looseObject({ messages: z.array(ownerMessageSchema) }),
  "tasks.create": taskResultSchema,
  "tasks.claim": ownerTaskSchema,
  "process.exec": z.object({
    operationId: z.string().uuid(),
    state: z.enum(["executing", "succeeded", "failed", "unknown"]),
    receipt: z
      .looseObject({
        stdout: z.string(),
        stderr: z.string(),
        code: z.number().nullable(),
        timedOut: z.boolean(),
      })
      .nullable(),
  }),
};

const inputCallSchema = z.looseObject({
  type: z.literal("function_call"),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
});
const outputSchema = z.looseObject({
  type: z.literal("function_call_output"),
  call_id: z.string(),
  output: z.string(),
});
const businessCallSchema = z.object({ name: z.string(), input: z.unknown() });

/** Match by the real call ID, so a result from an earlier request cannot replace this call's result. */
export function readScriptedToolResult<S extends z.core.$ZodType>(
  input: unknown[],
  name: string,
  schema: S,
): z.output<S> {
  const calls = input.flatMap((item) => {
    const parsed = inputCallSchema.safeParse(item);
    if (!parsed.success) return [];
    if (parsed.data.name === name) return [{ id: parsed.data.call_id }];
    if (parsed.data.name !== "tools.call") return [];
    const business = businessCallSchema.parse(JSON.parse(parsed.data.arguments));
    return business.name === name ? [{ id: parsed.data.call_id }] : [];
  });
  const call = calls.at(-1);
  if (!call) throw new Error(`Request has no tool call for ${name}`);
  const results = input.flatMap((item) => {
    const parsed = outputSchema.safeParse(item);
    return parsed.success && parsed.data.call_id === call.id ? [parsed.data] : [];
  });
  const [result] = results;
  if (results.length !== 1 || !result)
    throw new Error(`Expected one result for ${name}, call ${call.id}; found ${results.length}`);
  return z.parse(schema, JSON.parse(result.output));
}
