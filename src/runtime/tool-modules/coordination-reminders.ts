import { z } from "zod";
import { conversationTargetSchema as targetSchema } from "../../domain/conversations.js";
import { taskRelationSchema } from "../../coordination/board.js";
import type { TaskReference } from "../../coordination/messages.js";
import {
  activeWork,
  fence,
  id,
  messageRef,
  selectedWork,
  spec,
  targetWork,
  text,
  type ToolAuthorize,
  type ToolHandler,
  type ToolExecutionContext,
  type ToolModule,
  type ToolSpec,
} from "../tool-contract.js";

const reminderInput = {
  target: targetSchema,
  content: z.string().min(1).max(12000),
  nextAt: z.number().int().nonnegative(),
  timezone: id,
  cron: id.optional(),
  taskId: id.optional(),
  anchor: messageRef.optional(),
  projection: z.enum(["private", "conversation_receipt"]).optional(),
};
/**
 * Identity, visibility and work ownership of one call that names a target conversation and may
 * optionally name a task or a message anchor. Every reference is interpreted here, so the shared
 * router never has to recognise a field name.
 */
function reminderReferences(
  context: ToolExecutionContext,
  args: {
    target: { conversationId: string };
    taskId?: string | undefined;
    anchor?: { messageId: string } | undefined;
  },
): string {
  fence(context);
  const actor = context.run.agentId,
    c = context.collaboration;
  c.messages.requireAccess(actor, args.target.conversationId);
  if (args.taskId) c.board.read(actor, args.taskId);
  if (args.anchor) c.messages.message(actor, args.anchor.messageId);
  return args.taskId ? c.board.read(actor, args.taskId).workId : context.workId;
}
/** Work item of one own reminder, re-read under current target access. */
function ownedReminder(context: ToolExecutionContext, reminderId: string): string {
  fence(context);
  return context.collaboration.reminders.read(context.run.agentId, reminderId).work_id;
}
/**
 * A task mutation is attributed to the work item its own reference names, and that work item must
 * still be active for this Agent.
 */
function taskWorkOf(
  context: ToolExecutionContext,
  args: { taskId?: string | undefined; message?: { messageId: string } | undefined },
): string {
  fence(context);
  return activeWork(
    context,
    context.coordination.workOf(context.run.agentId, args, context.workId),
  );
}
export const taskMutation = <Schema extends z.ZodType<TaskReference, any>>(
  name: string,
  schema: Schema,
  description: string,
  handler: ToolHandler<Schema>,
): ToolSpec =>
  spec({
    name,
    schema,
    description,
    scope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: (context, args) => taskWorkOf(context, args),
    handler,
  });
const reminderRead = <Schema extends z.ZodType>(
  name: string,
  schema: Schema,
  description: string,
  authorize: ToolAuthorize<Schema>,
  handler: ToolHandler<Schema>,
): ToolSpec =>
  spec({
    name,
    schema,
    description,
    scope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "refreshable",
    authorize,
    handler,
  });
/** A held task mutation this Agent owns is attributed to the work its own arguments name. */
const heldMutation = (context: ToolExecutionContext, intentId: string): string => {
  fence(context);
  return activeWork(context, context.coordination.holdWork(context.run.agentId, intentId));
};

const definitions: ToolSpec[] = [
  spec({
    name: "works.list",
    schema: z.object({}).strict(),
    description: "List currently visible work containers.",
    scope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "refreshable",
    authorize: selectedWork,
    handler: ({ collaboration: c, run }) => {
      const value = c.store.db
        .prepare(
          "SELECT w.id,w.origin,w.target,w.state FROM works w JOIN channel_access a ON a.channel=json_extract(w.target,'$.conversationId') WHERE a.agent_id=? AND a.active=1 ORDER BY w.rowid DESC LIMIT 100",
        )
        .all(run.agentId) as { id: string }[];
      for (const row of value) c.messages.records.mutableTarget("works", row.id);
      return { value };
    },
  }),
  spec({
    name: "works.select",
    schema: z.object({ workId: id }).strict(),
    description:
      "Select another visible active work context without changing Linux file permissions.",
    scope: "session",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: selectedWork,
    handler: ({ collaboration: c, run }, args) => {
      c.selectWork(run, args.workId);
      return { value: { work: c.work(args.workId) } };
    },
  }),
  spec({
    name: "tasks.list",
    schema: z
      .object({
        relation: taskRelationSchema.optional(),
        status: id.optional(),
        target: targetSchema.optional(),
        cursor: id.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .strict(),
    description:
      "Page current authorized tasks by relation. Listing never claims work; inspect version before mutation.",
    scope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "refreshable",
    authorize: (context, args) => targetWork(context, args.target?.conversationId),
    handler: ({ collaboration: c, run }, args) => ({
      value: c.board.list(run.agentId, {
        relation: args.relation ?? "all-visible",
        status: args.status,
        target: args.target,
        cursor: args.cursor,
        limit: args.limit,
      }),
    }),
  }),
  spec({
    name: "tasks.read",
    schema: z.object({ taskId: id }).strict(),
    description:
      "Read one currently authorized task through its message or draft visibility boundary.",
    scope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "refreshable",
    authorize: (context, args) => {
      fence(context);
      context.collaboration.board.read(context.run.agentId, args.taskId);
      return context.workId;
    },
    handler: ({ collaboration: c, run }, args) => ({
      value: c.board.read(run.agentId, args.taskId),
    }),
  }),
  spec({
    name: "tasks.events",
    schema: z
      .object({
        taskId: id,
        cursor: id.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .strict(),
    description: "Page a task transition stream and inspect explicit historical coverage.",
    scope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "refreshable",
    authorize: (context, args) => {
      fence(context);
      context.collaboration.board.read(context.run.agentId, args.taskId);
      return context.workId;
    },
    handler: ({ collaboration: c, run }, args) => ({
      value: c.board.events(run.agentId, args.taskId, args.cursor, args.limit),
    }),
  }),
  spec({
    name: "tasks.byMessage",
    schema: z.object({ message: messageRef }).strict(),
    description: "Find the canonical task attached to one visible message.",
    scope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "refreshable",
    authorize: (context, args) => {
      fence(context);
      context.collaboration.messages.message(context.run.agentId, args.message.messageId);
      return context.workId;
    },
    handler: ({ coordination, run }, args) => ({
      value: coordination.find(run.agentId, args.message) ?? null,
    }),
  }),
  spec({
    name: "tasks.intents",
    schema: z.object({}).strict(),
    description: "List this Agent’s freshness-held task mutations.",
    scope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "refreshable",
    authorize: selectedWork,
    handler: ({ collaboration: c, coordination, run }) => ({
      value: (
        c.store.db
          .prepare(
            "SELECT i.id FROM task_intents i JOIN channel_access a ON a.agent_id=i.agent_id AND a.channel=json_extract(i.target,'$.conversationId') WHERE i.agent_id=? AND a.active=1 AND i.state='held'",
          )
          .all(run.agentId) as { id: string }[]
      ).map((i) => coordination.describe(run.agentId, i.id)),
    }),
  }),
  spec({
    name: "tasks.retry",
    schema: z.object({ intentId: id, viewToken: id.optional() }).strict(),
    description: "Retry one held task mutation after obtaining a current view.",
    scope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: (context, args) => heldMutation(context, args.intentId),
    handler: ({ coordination, run }, args) => {
      const value = coordination.retry(run, args.intentId, args.viewToken) as any;
      return { value, wait: value?.result?.status === "waiting" };
    },
  }),
  spec({
    name: "tasks.continue",
    schema: z
      .object({
        intentId: id,
        holdId: id,
        acknowledge: z.literal("apply_despite_unread_or_changes"),
      })
      .strict(),
    description: "Explicitly apply one held task mutation despite the reported freshness conflict.",
    scope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: (context, args) => heldMutation(context, args.intentId),
    handler: ({ coordination, run }, args) => {
      const value = coordination.continue(run, args.intentId, args.holdId) as any;
      return { value, wait: value?.result?.status === "waiting" };
    },
  }),
  spec({
    name: "tasks.discard",
    schema: z.object({ intentId: id }).strict(),
    description: "Discard one own held task mutation.",
    scope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: (context, args) => heldMutation(context, args.intentId),
    handler: ({ coordination, run }, args) => ({ value: coordination.discard(run, args.intentId) }),
  }),
  spec({
    name: "tasks.create",
    schema: z.object({ target: targetSchema, title: text, viewToken: id.optional() }).strict(),
    description: "Create a task and an explicitly targeted visible draft.",
    scope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: (context, args) =>
      activeWork(context, targetWork(context, args.target.conversationId)),
    handler: ({ coordination, gate, run, workId }, args) => {
      const task = coordination.create(run, workId, args.target, args.title, args.viewToken);
      return { value: { task, messageDraft: gate.describe(run.agentId, task.outbox_id!) } };
    },
  }),
  taskMutation(
    "tasks.claim",
    z.union([
      z
        .object({
          taskId: id,
          expectedVersion: z.number().int().nonnegative(),
          viewToken: id.optional(),
        })
        .strict(),
      z
        .object({
          message: messageRef,
          expectedVersion: z.number().int().nonnegative(),
          viewToken: id.optional(),
        })
        .strict(),
    ]),
    "Claim a visible task with CAS, possibly after freshness confirmation.",
    ({ coordination, run, workId, actionId }, args) => ({
      value: coordination.submit(run, workId, actionId, "tasks.claim", args, args.viewToken),
    }),
  ),
  taskMutation(
    "tasks.unclaim",
    z
      .object({
        taskId: id,
        expectedVersion: z.number().int().nonnegative(),
        viewToken: id.optional(),
      })
      .strict(),
    "Release an owned task with CAS.",
    ({ coordination, run, workId, actionId }, args) => ({
      value: coordination.submit(run, workId, actionId, "tasks.unclaim", args, args.viewToken),
    }),
  ),
  taskMutation(
    "tasks.transfer",
    z
      .object({
        taskId: id,
        peerId: id,
        expectedVersion: z.number().int().nonnegative(),
        reviewDisposition: z.enum(["preserve_review", "return_for_changes"]).optional(),
        viewToken: id.optional(),
      })
      .strict(),
    "Transfer owned work with CAS and explicit review disposition.",
    ({ coordination, run, workId, actionId }, args) => ({
      value: coordination.submit(run, workId, actionId, "tasks.transfer", args, args.viewToken),
    }),
  ),
  taskMutation(
    "tasks.wait",
    z
      .object({
        taskId: id,
        dependencyId: id,
        expectedVersion: z.number().int().nonnegative(),
        viewToken: id.optional(),
      })
      .strict(),
    "Wait on a dependency and release the current run when applied.",
    ({ coordination, run, workId, actionId }, args) => {
      const value = coordination.submit(
        run,
        workId,
        actionId,
        "tasks.wait",
        args,
        args.viewToken,
      ) as any;
      return { value, wait: value?.result?.status === "waiting" };
    },
  ),
  taskMutation(
    "tasks.update",
    z
      .object({
        taskId: id,
        status: z.enum(["doing", "review", "done", "cancelled", "failed"]),
        result: text.optional(),
        expectedVersion: z.number().int().nonnegative(),
        viewToken: id.optional(),
      })
      .strict(),
    "Update owned task state and optional result with CAS.",
    ({ coordination, run, workId, actionId }, args) => ({
      value: coordination.submit(run, workId, actionId, "tasks.update", args, args.viewToken),
    }),
  ),
  taskMutation(
    "tasks.delegate",
    z.object({ taskId: id, peerId: id, title: text, viewToken: id.optional() }).strict(),
    "Delegate a bounded child task directly to a peer.",
    ({ collaboration: c, run }, args) => ({
      value: c.delegate(run.agentId, args.taskId, args.peerId, args.title, {
        run,
        viewToken: args.viewToken,
      }),
    }),
  ),
  reminderRead(
    "reminders.list",
    z.object({ before: z.number().int().positive().optional() }).strict(),
    "Page this Agent’s durable reminders.",
    selectedWork,
    ({ collaboration: c, run }, args) => {
      const items = c.reminders.list(run.agentId, args.before);
      return { value: { items, nextCursor: items.length === 100 ? items.at(-1)!.cursor : null } };
    },
  ),
  reminderRead(
    "reminders.read",
    z.object({ reminderId: id }).strict(),
    "Read one owned reminder under current target access.",
    (context, args) => ownedReminder(context, args.reminderId),
    ({ collaboration: c, run }, args) => ({
      value: c.reminders.read(run.agentId, args.reminderId),
    }),
  ),
  reminderRead(
    "reminders.log",
    z
      .object({
        reminderId: id,
        before: z.number().int().positive().optional(),
        eventCursor: z.number().int().positive().optional(),
        firingCursor: id.optional(),
      })
      .strict(),
    "Page scheduler events and firings independently, including explicit result state.",
    (context, args) => ownedReminder(context, args.reminderId),
    ({ collaboration: c, run }, args) => ({
      value: c.reminders.log(
        run.agentId,
        args.reminderId,
        args.eventCursor ?? args.before,
        args.firingCursor,
      ),
    }),
  ),
  spec({
    name: "reminders.finish",
    schema: z
      .object({
        firingId: id,
        status: z.enum(["completed", "failed", "deferred"]),
        summary: z.string().max(12000).optional(),
      })
      .strict(),
    description: "Idempotently record the semantic result of one owned reminder firing.",
    scope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: (context, args) => {
      fence(context);
      return activeWork(
        context,
        context.collaboration.reminders.firingWork(context.run.agentId, args.firingId),
      );
    },
    handler: ({ collaboration: c, run }, args) => ({
      value: c.reminders.finish(run.agentId, args.firingId, args.status, args.summary),
    }),
  }),
  spec({
    name: "reminders.create",
    schema: z.object(reminderInput).strict(),
    description: "Create an author-owned durable wakeup; projection defaults to private.",
    scope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: (context, args) => activeWork(context, reminderReferences(context, args)),
    handler: ({ collaboration: c, run, workId }, args) => ({
      value: c.reminders.create(run.agentId, workId, args),
    }),
  }),
  spec({
    name: "reminders.edit",
    schema: z
      .object({ ...reminderInput, reminderId: id, expectedVersion: z.number().int().positive() })
      .strict(),
    description: "Edit an owned reminder with CAS without rewriting its historical baseline.",
    scope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: (context, args) => {
      reminderReferences(context, args);
      return activeWork(context, ownedReminder(context, args.reminderId));
    },
    handler: ({ collaboration: c, run }, args) => ({
      value: c.reminders.edit(run.agentId, args.reminderId, args.expectedVersion, args),
    }),
  }),
  spec({
    name: "reminders.cancel",
    schema: z
      .object({
        reminderId: id,
        expectedVersion: z.number().int().positive(),
        cancelPending: z.boolean().optional(),
      })
      .strict(),
    description: "Cancel future firings with CAS and optionally withdraw pending deliveries.",
    scope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: (context, args) => activeWork(context, ownedReminder(context, args.reminderId)),
    handler: ({ collaboration: c, run }, args) => ({
      value: c.reminders.cancel(
        run.agentId,
        args.reminderId,
        args.expectedVersion,
        args.cancelPending,
      ),
    }),
  }),
  reminderRead(
    "schedules.list",
    z.object({}).strict(),
    "Compatibility alias for listing this Agent’s reminders.",
    selectedWork,
    ({ collaboration: c, run }) => ({ value: c.schedules(run.agentId) }),
  ),
  spec({
    name: "schedules.create",
    schema: z
      .object({
        target: targetSchema,
        nextAt: z.number().int().positive(),
        timezone: id,
        cron: id.optional(),
        taskId: id.optional(),
      })
      .strict(),
    description: "Compatibility wakeup creator with private projection.",
    scope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: (context, args) => activeWork(context, reminderReferences(context, args)),
    handler: ({ collaboration: c, run, workId }, args) => ({
      value: c.schedule(
        run.agentId,
        workId,
        args.target,
        args.nextAt,
        args.timezone,
        args.cron,
        args.taskId,
      ),
    }),
  }),
  spec({
    name: "schedules.cancel",
    schema: z
      .object({
        scheduleId: id,
        expectedVersion: z.number().int().positive(),
        cancelPending: z.boolean().optional(),
      })
      .strict(),
    description: "Compatibility reminder cancellation with CAS.",
    scope: "work",
    seatPolicy: "deny",
    effectPolicy: "atomic-recorded",
    replayPolicy: "immutable",
    authorize: (context, args) => activeWork(context, ownedReminder(context, args.scheduleId)),
    handler: ({ collaboration: c, run }, args) => ({
      value: c.reminders.cancel(
        run.agentId,
        args.scheduleId,
        args.expectedVersion,
        args.cancelPending,
      ),
    }),
  }),
];

export const coordinationRemindersModule: ToolModule = Object.freeze({
  domain: "coordination-reminders",
  specs: Object.freeze(definitions),
});
