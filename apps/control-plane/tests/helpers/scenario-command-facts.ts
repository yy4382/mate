import { agentProcessOperationSchema } from "@mate/protocol";
import { z } from "zod";
import { readNodeScenarioFacts, readScenarioFacts } from "./scenario-facts.js";

const originalRequestSchema = z.looseObject({
  agentId: z.string().uuid(),
  operation: agentProcessOperationSchema,
});
const encodedRequestSchema = z
  .string()
  .transform((text) => originalRequestSchema.parse(JSON.parse(text)));
const encodedReceiptSchema = z
  .string()
  .nullable()
  .transform((text) =>
    text === null ? null : z.record(z.string(), z.unknown()).parse(JSON.parse(text)),
  );
const commandIdentitySchema = z.object({
  operationId: z.string().uuid(),
  agentId: z.string().uuid(),
  request: encodedRequestSchema,
  receipt: encodedReceiptSchema,
});

/** Existing read-only projections, narrowed for command identity and durable reconciliation. */
export function readScenarioCommandFacts(directory: string, agentId: string) {
  const control = commandIdentitySchema
    .extend({
      runId: z.string().uuid(),
      nodeId: z.string().uuid(),
      state: z.enum(["executing", "succeeded", "failed", "unknown"]),
      nodeReceiptConfirmed: z.union([z.literal(0), z.literal(1)]),
      nodeReceiptRevision: z.number().int().positive().nullable(),
    })
    .array()
    .parse(readScenarioFacts(directory).operations);
  const node = commandIdentitySchema
    .extend({
      state: z.enum(["started", "succeeded", "failed", "unknown"]),
      revision: z.number().int().positive(),
    })
    .array()
    .parse(readNodeScenarioFacts(directory).operations);
  return {
    control: control.filter(
      (row) => row.agentId === agentId && row.request.operation.kind === "exec",
    ),
    node: node.filter((row) => row.agentId === agentId && row.request.operation.kind === "exec"),
  };
}

const inputMessageSchema = z.looseObject({
  role: z.literal("user"),
  content: z.array(z.looseObject({ type: z.literal("input_text"), text: z.string() })),
});
const recoveredFactSchema = z.looseObject({
  operationId: z.string().uuid(),
  state: z.enum(["unknown", "succeeded", "failed"]),
  request: originalRequestSchema,
});

/** Parse actual model-visible receipt corrections, rather than a substring in unrelated history. */
export function readModelCommandFacts(input: unknown[]) {
  return input.flatMap((item) => {
    const message = inputMessageSchema.safeParse(item);
    if (!message.success) return [];
    return message.data.content.flatMap(({ text }) => {
      const prefix = "Mate 收据更正：";
      if (!text.startsWith(prefix)) return [];
      const fact = recoveredFactSchema.safeParse(JSON.parse(text.slice(prefix.length)));
      return fact.success ? [fact.data] : [];
    });
  });
}
