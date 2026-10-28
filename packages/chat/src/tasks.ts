import { TaskStatus, Task, TaskResult } from "./contracts.ts";
import { z } from "zod";
import { targetAccount, type Actor } from "./accounts.ts";
import { ChatError } from "./chat-error.ts";
import { isMember, requireWritable } from "./conversations.ts";
import type { ChatDatabase } from "./database.ts";
import { appendEntry } from "./entries.ts";
import { FreshnessOptions, freshWrite } from "./forward-reading.ts";
import { Id, RequestId } from "./identifiers.ts";
import { timelineOfEntry, type Timeline } from "./timelines.ts";

export const TaskTitle = z.string().trim().min(1).max(200);

export const CreateTaskRequest = z.object({
  requestId: RequestId,
  messageId: Id,
  title: TaskTitle,
  ...FreshnessOptions,
});

export const TaskChangeRequest = z.object({
  requestId: RequestId,
  taskId: Id,
  change: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("claim") }),
    z.object({ kind: z.literal("yield") }),
    z.object({ kind: z.literal("transfer"), to: Id }),
    z.object({ kind: z.literal("complete") }),
  ]),
  ...FreshnessOptions,
});
type TaskChangeRequest = z.output<typeof TaskChangeRequest>;

const TaskRow = z.object({
  id: Id,
  message_id: Id,
  title: z.string(),
  owner_id: Id.nullable(),
  status: TaskStatus,
});

function loadTask(db: ChatDatabase, taskId: number): Task | undefined {
  const row = db.get(
    TaskRow,
    "SELECT id, message_id, title, owner_id, status FROM tasks WHERE id = ?",
    taskId,
  );
  return row === undefined
    ? undefined
    : {
        taskId: row.id,
        messageId: row.message_id,
        title: row.title,
        owner: row.owner_id,
        status: row.status,
      };
}

const Created = z.object({ id: Id });

/** Create an unassigned task on a message and record it in the message's timeline. */
export function insertTask(
  db: ChatDatabase,
  actor: Actor,
  message: { entryId: number; timelineId: number },
  title: string,
): { task: Task; seq: number } {
  const created = db.get(
    Created,
    "INSERT INTO tasks (message_id, title, status) VALUES (?, ?, 'open') RETURNING id",
    message.entryId,
    title,
  );
  if (created === undefined) throw new Error("task insert returned no row");
  const { seq } = appendEntry(db, message.timelineId, {
    kind: "task",
    author: actor.id,
    taskId: created.id,
    change: "created",
    owner: null,
  });
  const task = loadTask(db, created.id);
  if (task === undefined) throw new Error(`task ${created.id} vanished`);
  return { task, seq };
}

const MessageKind = z.object({ kind: z.string() });

export function createTask(
  db: ChatDatabase,
  actor: Actor,
  request: z.output<typeof CreateTaskRequest>,
): TaskResult {
  const timeline = timelineOfEntry(db, actor, request.messageId);
  const entry = db.get(MessageKind, "SELECT kind FROM entries WHERE id = ?", request.messageId);
  if (entry?.kind !== "message")
    throw new ChatError("not-found", `message ${request.messageId} not found`);
  requireWritable(db, actor, timeline.conversation);
  const outcome = freshWrite(db, actor, timeline, request, () =>
    insertTask(db, actor, { entryId: request.messageId, timelineId: timeline.id }, request.title),
  );
  return "held" in outcome
    ? { status: "held", page: outcome.held }
    : { status: "applied", ...outcome.written };
}

type Decision =
  | { refused: "claimed" | "not-owner" | "completed" }
  | {
      change: "claimed" | "yielded" | "transferred" | "completed";
      owner: number | null;
      status: Task["status"];
    };

/** The task state machine: what a change does to a task in its current state. */
function decide(task: Task, actor: Actor, change: TaskChangeRequest["change"]): Decision {
  if (task.status === "completed") return { refused: "completed" };
  switch (change.kind) {
    case "claim":
      return task.owner === null
        ? { change: "claimed", owner: actor.id, status: "open" }
        : { refused: "claimed" };
    case "yield":
      return task.owner === actor.id
        ? { change: "yielded", owner: null, status: "open" }
        : { refused: "not-owner" };
    case "transfer":
      return task.owner === actor.id
        ? { change: "transferred", owner: change.to, status: "open" }
        : { refused: "not-owner" };
    case "complete":
      return { change: "completed", owner: task.owner, status: "completed" };
  }
}

/** A task's own timeline: where its message is. Readers who may not read it get `not-found`. */
function taskTimeline(
  db: ChatDatabase,
  actor: Actor,
  taskId: number,
): { task: Task; timeline: Timeline } {
  const task = loadTask(db, taskId);
  if (task === undefined) throw new ChatError("not-found", `task ${taskId} not found`);
  return { task, timeline: timelineOfEntry(db, actor, task.messageId) };
}

/** Claim, yield, transfer or complete a task. Task changes are recorded as task entries, never as messages. */
export function changeTask(db: ChatDatabase, actor: Actor, request: TaskChangeRequest): TaskResult {
  const { task, timeline } = taskTimeline(db, actor, request.taskId);
  requireWritable(db, actor, timeline.conversation);
  if (request.change.kind === "transfer") {
    if (request.change.to === actor.id)
      throw new ChatError("invalid-target", "a task cannot be transferred to its own owner");
    const target = targetAccount(db, request.change.to);
    if (!target.active || !isMember(db, target.id, timeline.conversation.id))
      throw new ChatError("invalid-target", `account ${target.id} is not an active member here`);
  }
  const outcome = freshWrite(db, actor, timeline, request, (): TaskResult => {
    const decision = decide(task, actor, request.change);
    if ("refused" in decision) return { status: "refused", reason: decision.refused, task };
    db.run(
      "UPDATE tasks SET owner_id = ?, status = ? WHERE id = ?",
      decision.owner,
      decision.status,
      task.taskId,
    );
    const { seq } = appendEntry(db, timeline.id, {
      kind: "task",
      author: actor.id,
      taskId: task.taskId,
      change: decision.change,
      owner: decision.owner,
    });
    return {
      status: "applied",
      task: { ...task, owner: decision.owner, status: decision.status },
      seq,
    };
  });
  return "held" in outcome ? { status: "held", page: outcome.held } : outcome.written;
}
