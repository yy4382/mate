import {
  attachmentSummarySchema,
  ownerChannelSchema,
  ownerChatEventSchema,
  ownerChatSnapshotSchema,
  ownerMessagePageSchema,
  ownerMessageSchema,
} from "@mate/protocol/owner";
import { z } from "zod";

// Validate the fields consumed by this screen, while allowing richer server projections.
export const channelSchema = ownerChannelSchema
  .pick({ id: true, name: true, description: true, visibility: true, archived: true })
  .loose();

export const messageSchema = ownerMessageSchema
  .omit({ recentReplies: true })
  .partial({ quoteId: true, replyCount: true })
  .extend({
    // Message ordering uses BigInt; reject unusable wire values before merging them.
    order: ownerMessageSchema.shape.order.regex(/^\d+$/),
    get recentReplies(): z.ZodOptional<z.ZodArray<typeof messageSchema>> {
      return z.array(messageSchema).optional();
    },
  })
  .loose();

export const messagePageSchema = ownerMessagePageSchema
  .extend({ messages: z.array(messageSchema) })
  .loose();
export const snapshotSchema = ownerChatSnapshotSchema
  .extend({ channels: z.array(channelSchema) })
  .loose();
export const threadSchema = z.looseObject({
  root: messageSchema,
  replies: z.array(messageSchema),
});
export const messageContextSchema = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("timeline"),
    messageId: z.string(),
    page: messagePageSchema,
    hasNewer: z.boolean(),
  }),
  z.looseObject({
    kind: z.literal("thread"),
    messageId: z.string(),
    thread: threadSchema,
  }),
]);

export const attachmentSchema = attachmentSummarySchema
  .pick({ id: true, channelId: true, filename: true, size: true, uploader: true })
  .loose();
export const attachmentsResponseSchema = z.looseObject({
  attachments: z.array(attachmentSchema),
});
export const attachmentResponseSchema = z.looseObject({ attachment: attachmentSchema });
export const pushPublicKeySchema = z.looseObject({ publicKey: z.string() });
export const pushSubscriptionSchema = z.looseObject({ subscribed: z.literal(true) });

// EventSource manages the replay cursor; these handlers only need routing and payload data.
const eventEnvelopeSchema = ownerChatEventSchema.pick({ channelId: true }).loose();
const chatEventSchema = z.discriminatedUnion("kind", [
  eventEnvelopeSchema.extend({ kind: z.literal("channel.created"), payload: channelSchema }),
  eventEnvelopeSchema.extend({ kind: z.literal("channel.updated"), payload: channelSchema }),
  eventEnvelopeSchema.extend({ kind: z.literal("message.created"), payload: messageSchema }),
]);

export function readChatEvent(event: Event) {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") return null;
  try {
    const value: unknown = JSON.parse(event.data);
    const parsed = chatEventSchema.safeParse(value);
    return parsed.success && parsed.data.kind === event.type ? parsed.data : null;
  } catch {
    return null;
  }
}

export type Channel = z.infer<typeof channelSchema>;
export type Message = z.infer<typeof messageSchema>;
export type MessagePage = z.infer<typeof messagePageSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
