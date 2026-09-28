import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import { z } from "zod";

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
  .transform((message) => message as unknown as Exclude<Message, { role: "system" }>);
export const sessionConfigurationSchema = z
  .object({
    provider: z.string(),
    modelId: z.string(),
    systemPrompt: z.string(),
    tools: z.array(z.json()),
    piAgentVersion: z.string(),
    piAiVersion: z.string(),
    formatVersion: z.literal(1),
  })
  .strict();
export const sessionCommitSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("message"), id: z.string().uuid(), message: piMessageSchema })
    .strict(),
  z
    .object({
      kind: z.literal("configuration"),
      id: z.string().uuid(),
      configuration: sessionConfigurationSchema,
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
  })
  .strict();
export type ModelContextMessage = z.infer<typeof contextMessageSchema>;

export function durableToolIdentity(
  actionScopeId: string,
  assistantId: string,
  toolCallId: string,
): string {
  return `mate:${actionScopeId}:${createHash("sha256")
    .update(JSON.stringify([assistantId, toolCallId]))
    .digest("hex")}:1`;
}
