import { ownerReminderSchema } from "@mate/protocol/owner";
import { z } from "zod";

export const reminderSchema = ownerReminderSchema
  .pick({ id: true, text: true, dueAt: true, state: true })
  .extend({
    firing: z.looseObject({ handledAt: z.number().nullish() }).nullish(),
  })
  .loose();
export const remindersResponseSchema = z.looseObject({ reminders: z.array(reminderSchema) });
export type Reminder = z.infer<typeof reminderSchema>;
