import { z } from "zod";
import { ownerTaskSchema } from "@mate/protocol/owner";

export const taskSchema = ownerTaskSchema
  .pick({
    id: true,
    messageId: true,
    channelId: true,
    title: true,
    status: true,
    ownerAgentId: true,
    ownerAgentName: true,
  })
  .partial({ ownerAgentName: true })
  .loose();
export const tasksResponseSchema = z.looseObject({ tasks: z.array(taskSchema) });
export const taskActivityResponseSchema = z.looseObject({
  events: z.array(
    z.looseObject({
      seq: z.number(),
      actorKind: z.string(),
      actorId: z.string(),
      kind: z.string(),
      note: z.string().optional(),
    }),
  ),
});
export type Task = z.infer<typeof taskSchema>;
export type Activity = z.infer<typeof taskActivityResponseSchema>["events"][number];
