import { z } from "zod";
import type { ConversationTarget } from "./conversations.js";

export type Principal =
  | {
      id: string;
      kind: "human" | "agent" | "system" | "external";
    }
  | { kind: "unknown" };

export const messageOrderSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
/** Decimal integers, never floating point or lexicographic comparison. */
export function compareMessageOrder(left: string, right: string): -1 | 0 | 1 {
  const a = BigInt(messageOrderSchema.parse(left)),
    b = BigInt(messageOrderSchema.parse(right));
  return a < b ? -1 : a > b ? 1 : 0;
}
export interface MessageDTO {
  id: string;
  conversationId: string;
  rootId: string | null;
  author: Principal;
  origin: "participant" | "system";
  mentions: Principal[];
  text: string;
  deleted: boolean;
  // Decimal integer strings preserve ordering beyond JS safe integer precision.
  order: string;
  revision: string;
  attachments: { id: string; name?: string; title?: string; mimetype?: string; size?: number }[];
}
export interface CanonicalEffect {
  id: string;
  actor: string;
  state: string;
  target: ConversationTarget;
  original: { request: string; requestHash: string; receipt: string | null };
}

export const principalSchema = z.union([
  z
    .object({
      kind: z.enum(["human", "agent", "system", "external"]),
      id: z.string().min(1).max(1000),
    })
    .strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]);
const attachmentSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    title: z.string().optional(),
    mimetype: z.string().optional(),
    size: z.number().nonnegative().optional(),
  })
  .strict();
const messageSchema = z
  .object({
    id: z.string().min(1).max(1000),
    conversationId: z.string().min(1).max(1000),
    rootId: z.string().min(1).max(1000).nullable(),
    author: principalSchema,
    origin: z.enum(["participant", "system"]),
    mentions: z.array(principalSchema),
    text: z.string(),
    deleted: z.boolean(),
    order: messageOrderSchema,
    revision: messageOrderSchema,
    attachments: z.array(attachmentSchema),
  })
  .strict();

export function parseMessage(value: unknown): MessageDTO {
  const parsed = messageSchema.parse(value);
  return {
    ...parsed,
    attachments: parsed.attachments.map((file) => ({
      id: file.id,
      ...(file.name !== undefined ? { name: file.name } : {}),
      ...(file.title !== undefined ? { title: file.title } : {}),
      ...(file.mimetype !== undefined ? { mimetype: file.mimetype } : {}),
      ...(file.size !== undefined ? { size: file.size } : {}),
    })),
  };
}
