import type { Message } from "@earendil-works/pi-ai";
import { z } from "zod";

import { reportedUsageSchema } from "../provider-response.js";
// Preserve Pi/provider extension fields (signatures, replay data and usage) verbatim.
const contentBlock = z.looseObject({ type: z.string() });
export const piMessageSchema = z
  .discriminatedUnion("role", [
    z.looseObject({
      role: z.literal("user"),
      content: z.union([z.string(), z.array(contentBlock)]),
      timestamp: z.number(),
    }),
    z.looseObject({
      role: z.literal("assistant"),
      content: z.array(contentBlock),
      timestamp: z.number(),
      api: z.string(),
      provider: z.string(),
      model: z.string(),
      usage: z.json(),
      stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted"]),
    }),
    z.looseObject({
      role: z.literal("toolResult"),
      content: z.array(contentBlock),
      timestamp: z.number(),
      toolCallId: z.string(),
      toolName: z.string(),
      isError: z.boolean(),
    }),
  ])
  // Mate checks the envelope; Pi supplies the content/provider fields preserved by these loose objects.
  .transform((message) => message as unknown as Exclude<Message, { role: "system" }>);
export const sessionCommitSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("message"),
      id: z.string().uuid(),
      message: piMessageSchema,
      modelRequest: z.literal(true).optional(),
      // Only assistant responses carry this. Absence on older/scripted records means unknown.
      reportedUsage: reportedUsageSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("summary_usage"),
      id: z.string().uuid(),
      stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted", "deferred", "pending"]),
      usage: z.json(),
      // Null means this provider did not expose its raw HTTP usage through Pi's fetch hook.
      // Missing fields in an object mean the response was inspected but did not report them.
      reportedUsage: reportedUsageSchema.nullable(),
    })
    .strict(),
]);
export type SessionCommit = z.infer<typeof sessionCommitSchema>;
export const contextMessageSchema = z
  .object({
    id: z.string(),
    message: piMessageSchema,
    actionScopeId: z.string(),
    pending: z.boolean().optional(),
    recoveryFact: z.boolean().optional(),
  })
  .strict();
export type ModelContextMessage = z.infer<typeof contextMessageSchema>;
