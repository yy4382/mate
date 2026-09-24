import { z } from "zod";
export { requiredSlackBotScopes } from "./capabilities.js";
export const slackTs = z.string().regex(/^\d{1,16}\.\d{1,6}$/);
const fileMetadata = z.object({
  id: z.string().regex(/^F[A-Z0-9]+$/),
  name: z.string().max(500).optional(),
  title: z.string().max(500).optional(),
  mimetype: z.string().max(200).optional(),
  size: z.number().nonnegative().optional(),
});
const outputMetadata = z
  .object({
    event_type: z.string(),
    event_payload: z.record(z.string(), z.unknown()).optional(),
  })
  .optional();
export const rawMessage = z
  .object({
    type: z.string(),
    channel: z.string(),
    ts: slackTs.optional(),
    event_ts: slackTs.optional(),
    thread_ts: slackTs.optional(),
    metadata: outputMetadata,
    edited: z.object({ ts: slackTs }).optional(),
    files: z.array(fileMetadata).max(100).optional(),
    text: z.string().optional(),
    user: z.string().optional(),
    bot_id: z.string().optional(),
    subtype: z.string().optional(),
    deleted_ts: slackTs.optional(),
    previous_message: z.object({ thread_ts: slackTs.optional() }).passthrough().optional(),
    message: z
      .object({
        metadata: outputMetadata,
        files: z.array(fileMetadata).max(100).optional(),
        ts: slackTs,
        thread_ts: slackTs.optional(),
        text: z.string().optional(),
        user: z.string().optional(),
        bot_id: z.string().optional(),
        edited: z.object({ ts: slackTs }).optional(),
      })
      .optional(),
  })
  .passthrough();
