import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  OwnerChannel,
  OwnerMessage,
  OwnerPrincipalKind,
  OwnerTask,
  OwnerReminder,
} from "@mate/protocol/owner";
import {
  taskRowSchema,
  reminderRowSchema,
  taskDraftRowSchema,
  toTask,
  toReminder,
  type TaskDraftRow,
} from "./rows.js";
import { conversationToolDefinitions, type TaskToolRequest } from "./tool-contracts.js";
import { AgentToolRefusal } from "./errors.js";
import { ConversationToolActions, defineConversationTool } from "./tool-actions.js";
import type { CurrentAgentToolRun } from "../runtime/tools/entry.js";

/** Conversation facts needed by task/reminder rules; all callbacks are synchronous. */
export interface TaskConversationAccess {
  requireMembership(agentId: string, channelId: string): void;
  isMember(agentId: string, channelId: string): boolean;
  inspectPositionChanges(
    agentId: string,
    inputEndSequence: number,
    channelId: string,
    rootId?: string,
  ): { changes: OwnerMessage[] };
  ownerDirectChannel(agentId: string): OwnerChannel | undefined;
  recordTaskEvent(kind: string, channelId: string, task: OwnerTask): void;
}

/** Every task projection derives its channel from its anchor message. */
const taskSelection = `SELECT t.*,a.name AS owner_agent_name,m.channel_id
         FROM owner_tasks t
         JOIN owner_messages m ON m.id=t.message_id
         LEFT JOIN owner_agents a ON a.id=t.owner_agent_id`;

/** Task responsibility, draft freshness and reminder delivery on the shared database. */
export class TaskService {
  constructor(
    private readonly db: Database.Database,
    private readonly conversations: TaskConversationAccess,
    private readonly now: () => number,
    private readonly toolActions: ConversationToolActions,
  ) {}

  createTaskForMessage(
    messageId: string,
    actorKind: OwnerPrincipalKind,
    actorId: string,
    title: string,
  ): OwnerTask {
    return this.db
      .transaction(() => {
        const message = z
          .looseObject({ id: z.string(), channel_id: z.string(), text: z.string() })
          .optional()
          .parse(
            this.db
              .prepare(
                "SELECT id,channel_id,text FROM owner_messages WHERE id=? AND internal_kind IS NULL",
              )
              .get(messageId),
          );
        if (!message) throw new Error("Message is not available");
        if (actorKind === "agent")
          this.conversations.requireMembership(actorId, message.channel_id);
        const id = this.insertTask(message.id, title, this.now());
        this.taskEvent(id, actorKind, actorId, "created", "");
        const task = this.readTask(id)!;
        this.conversations.recordTaskEvent("task.created", message.channel_id, task);
        return task;
      })
      .immediate();
  }

  /** Insert one independent, unclaimed task; callers commit its activity with the task. */
  private insertTask(messageId: string, title: string, at: number): string {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO owner_tasks(id,message_id,title,status,created_at,updated_at) VALUES(?,?,?,'open',?,?)",
      )
      .run(id, messageId, title, at, at);
    return id;
  }

  readTask(id: string): OwnerTask | undefined {
    const row = taskRowSchema
      .optional()
      .parse(this.db.prepare(`${taskSelection} WHERE t.id=?`).get(id));
    return row && toTask(row);
  }

  tasksForMessage(messageId: string): OwnerTask[] {
    return taskRowSchema
      .array()
      .parse(this.db.prepare(`${taskSelection} WHERE t.message_id=? ORDER BY t.id`).all(messageId))
      .map(toTask);
  }

  /** Only additions to the ID set invalidate a create decision; task edits do not. */
  private taskSnapshot(tasks: OwnerTask[]): string {
    return createHash("sha256")
      .update(JSON.stringify(tasks.map((task) => task.id)))
      .digest("hex");
  }

  listTasks(): OwnerTask[] {
    return taskRowSchema
      .array()
      .parse(this.db.prepare(`${taskSelection} ORDER BY t.updated_at DESC,t.id DESC`).all())
      .map(toTask);
  }

  taskActivity(taskId: string): unknown[] {
    return this.db
      .prepare(
        "SELECT seq,task_id AS taskId,actor_kind AS actorKind,actor_id AS actorId,kind,note,created_at AS createdAt FROM owner_task_events WHERE task_id=? ORDER BY seq",
      )
      .all(taskId);
  }

  private taskDraftPosition(draft: TaskDraftRow): {
    channelId: string;
    rootId: string | undefined;
  } {
    const input = z
      .looseObject({ messageId: z.string().optional() })
      .parse(JSON.parse(draft.input_json));
    const task = draft.task_id ? this.readTask(draft.task_id) : undefined;
    const messageId = task?.messageId ?? input.messageId;
    const message = z
      .looseObject({ channel_id: z.string(), root_id: z.string().nullable() })
      .optional()
      .parse(
        this.db.prepare("SELECT channel_id,root_id FROM owner_messages WHERE id=?").get(messageId),
      );
    if (!message) throw new AgentToolRefusal("Task anchor is not available");
    return { channelId: message.channel_id, rootId: message.root_id ?? undefined };
  }

  private unreviewedTaskChanges(draft: TaskDraftRow): OwnerMessage[] {
    const position = this.taskDraftPosition(draft);
    return this.conversations
      .inspectPositionChanges(
        draft.agent_id,
        draft.input_end_seq,
        position.channelId,
        position.rootId,
      )
      .changes.filter(
        (message) =>
          !this.db
            .prepare("SELECT 1 FROM owner_task_draft_reviews WHERE draft_id=? AND message_id=?")
            .get(draft.id, message.id),
      );
  }

  private recordTaskDraftReviews(draftId: string, changes: OwnerMessage[]): void {
    for (const message of changes) {
      this.db
        .prepare("INSERT OR IGNORE INTO owner_task_draft_reviews(draft_id,message_id) VALUES(?,?)")
        .run(draftId, message.id);
      const draft = z
        .looseObject({ agent_id: z.string() })
        .parse(this.db.prepare("SELECT agent_id FROM owner_task_drafts WHERE id=?").get(draftId));
      this.db
        .prepare(
          "INSERT OR IGNORE INTO owner_agent_message_attention(agent_id,message_id,updated_at) VALUES(?,?,?)",
        )
        .run(draft.agent_id, message.id, this.now());
      this.db
        .prepare(
          "UPDATE owner_agent_message_attention SET presented=1,updated_at=? WHERE agent_id=? AND message_id=?",
        )
        .run(this.now(), draft.agent_id, message.id);
    }
  }

  private mutateTask(agentId: string, task: OwnerTask, request: TaskToolRequest): OwnerTask {
    const { name: action, input } = request;
    const current = this.readTask(task.id);
    if (
      !current ||
      (current.version !== ("expectedVersion" in input ? input.expectedVersion : undefined) &&
        !(action === "tasks.yield" && current.ownerAgentId !== agentId))
    )
      throw new AgentToolRefusal("Task version changed; read the task again");
    this.conversations.requireMembership(agentId, current.channelId);
    let owner = current.ownerAgentId,
      status = current.status,
      title = current.title;
    if (action === "tasks.claim") {
      if (owner && owner !== agentId) throw new AgentToolRefusal("Task is already claimed");
      owner = agentId;
      status = "in_progress";
    } else if (action === "tasks.yield") {
      if (owner === agentId) {
        owner = null;
        status = "open";
      }
      // A peer's newer claim remains authoritative; this Agent may still yield socially.
    } else if (action === "tasks.transfer") {
      const targetId = input.agentId;
      // Only the current owner hands the task on: a peer cannot take over by transferring it.
      if (owner !== agentId)
        throw new AgentToolRefusal("Only the current owner can transfer this task");
      if (targetId === agentId) throw new AgentToolRefusal("Task is already yours");
      if (!this.conversations.isMember(targetId, current.channelId))
        throw new AgentToolRefusal("Transfer target is not a conversation member");
      owner = targetId;
      status = "in_progress";
    } else if (action === "tasks.update") {
      if (typeof input.title === "string") title = input.title;
      if (typeof input.status === "string") status = input.status;
    }
    this.db
      .prepare(
        "UPDATE owner_tasks SET title=?,status=?,owner_agent_id=?,version=version+1,updated_at=? WHERE id=?",
      )
      .run(title, status, owner, this.now(), task.id);
    this.taskEvent(task.id, "agent", agentId, action.slice(6), "note" in input ? input.note : "");
    const updated = this.readTask(task.id)!;
    this.conversations.recordTaskEvent("task.updated", task.channelId, updated);
    return updated;
  }

  private taskEvent(
    taskId: string,
    actorKind: OwnerPrincipalKind,
    actorId: string,
    kind: string,
    note: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO owner_task_events(task_id,actor_kind,actor_id,kind,note,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(taskId, actorKind, actorId, kind, note, this.now());
  }

  listAgentReminders(
    agentId: string,
  ): Array<OwnerReminder & { firing: { firedAt: number; handledAt: number | null } | null }> {
    const rows = reminderRowSchema
      .array()
      .parse(
        this.db
          .prepare(
            "SELECT id,agent_id,channel_id,task_id,text,due_at,state,version,created_at,updated_at FROM owner_reminders WHERE agent_id=? ORDER BY due_at DESC,id",
          )
          .all(agentId),
      );
    return rows.map((row) => {
      const firing = z
        .looseObject({ firedAt: z.number(), handledAt: z.number().nullable() })
        .optional()
        .parse(
          this.db
            .prepare(
              "SELECT fired_at AS firedAt,handled_at AS handledAt FROM owner_reminder_firings WHERE reminder_id=?",
            )
            .get(row.id),
        );
      return { ...toReminder(row), firing: firing ?? null };
    });
  }

  private readReminder(id: string): OwnerReminder | undefined {
    const row = reminderRowSchema
      .optional()
      .parse(
        this.db
          .prepare(
            "SELECT id,agent_id,channel_id,task_id,text,due_at,state,version,created_at,updated_at FROM owner_reminders WHERE id=?",
          )
          .get(id),
      );
    return row && toReminder(row);
  }

  /** Due time and delivery are committed together, independent of node connectivity. */
  fireDueReminders(): number {
    return this.db
      .transaction(() => {
        const due = z
          .looseObject({ id: z.string(), agent_id: z.string() })
          .array()
          .parse(
            this.db
              .prepare(
                "SELECT id,agent_id FROM owner_reminders WHERE state='active' AND due_at<=? ORDER BY due_at,id LIMIT 100",
              )
              .all(this.now()),
          );
        for (const candidate of due) {
          const reminder = this.readReminder(candidate.id)!;
          const channel = this.conversations.ownerDirectChannel(reminder.agentId);
          if (!channel) continue;
          const order = z
            .looseObject({ next: z.number() })
            .parse(
              this.db
                .prepare(
                  "SELECT COALESCE(MAX(order_seq),0)+1 AS next FROM owner_messages WHERE channel_id=?",
                )
                .get(channel.id),
            );
          const messageId = randomUUID(),
            deliveryId = randomUUID(),
            at = this.now();
          this.db
            .prepare(
              "INSERT INTO owner_messages(id,channel_id,order_seq,text,author_kind,author_id,internal_kind,created_at) VALUES(?,?,?,?,'agent',?,'reminder',?)",
            )
            .run(messageId, channel.id, order.next, `提醒：${reminder.text}`, reminder.agentId, at);
          this.db
            .prepare(
              "INSERT INTO owner_message_deliveries(id,message_id,channel_id,recipient_kind,recipient_id,state,created_at) VALUES(?,?,?,'agent',?,'pending',?)",
            )
            .run(deliveryId, messageId, channel.id, reminder.agentId, at);
          this.db
            .prepare(
              "INSERT INTO owner_reminder_firings(id,reminder_id,agent_id,fired_at,delivery_id) VALUES(?,?,?,?,?)",
            )
            .run(randomUUID(), reminder.id, reminder.agentId, at, deliveryId);
          this.db
            .prepare(
              "UPDATE owner_reminders SET state='fired',version=version+1,updated_at=? WHERE id=?",
            )
            .run(at, reminder.id);
        }
        this.syncHandledReminders();
        return due.length;
      })
      .immediate();
  }

  syncHandledReminders(): void {
    this.db
      .prepare(
        `UPDATE owner_reminder_firings SET handled_at=(
      SELECT d.handled_at FROM owner_message_deliveries d
      WHERE d.id=owner_reminder_firings.delivery_id
    ) WHERE handled_at IS NULL AND EXISTS (
      SELECT 1 FROM owner_message_deliveries d
      JOIN owner_agent_runs r
        ON r.agent_id=owner_reminder_firings.agent_id AND r.state='completed'
           AND r.input_end_seq>=d.seq AND r.completed_at=d.handled_at
      JOIN owner_message_deliveries seed ON seed.id=r.delivery_id AND seed.channel_id=d.channel_id
      WHERE d.id=owner_reminder_firings.delivery_id AND d.state='handled' AND seed.seq<=d.seq
    )`,
      )
      .run();
  }

  private executeTaskChange(
    run: CurrentAgentToolRun,
    toolCallId: string,
    request: TaskToolRequest,
  ): unknown {
    const { name: taskOperation, input: args } = request;
    const messageId = "messageId" in args ? args.messageId : undefined;
    const task = "taskId" in args ? this.readTask(args.taskId) : undefined;
    const message = messageId
      ? z
          .looseObject({ id: z.string(), channel_id: z.string(), root_id: z.string().nullable() })
          .optional()
          .parse(
            this.db
              .prepare(
                "SELECT id,channel_id,root_id FROM owner_messages WHERE id=? AND internal_kind IS NULL",
              )
              .get(messageId),
          )
      : undefined;
    if (!task && !message) throw new AgentToolRefusal("Task or message is not available");
    const channelId = task?.channelId ?? message!.channel_id;
    this.conversations.requireMembership(run.agent_id, channelId);
    return this.toolActions.record(run, toolCallId, taskOperation, args, () => {
      const tasks = taskOperation === "tasks.create" ? this.tasksForMessage(messageId!) : undefined;
      const taskFacts = tasks ? { tasks, taskSnapshot: this.taskSnapshot(tasks) } : undefined;
      let readyDraft: TaskDraftRow | undefined;
      const anchorMessageId = task?.messageId ?? messageId!;
      const anchor = z
        .looseObject({ root_id: z.string().nullable() })
        .optional()
        .parse(
          this.db.prepare("SELECT root_id FROM owner_messages WHERE id=?").get(anchorMessageId),
        );
      const rootId = anchor?.root_id ?? undefined;
      if (!args.draftId) {
        const { changes } = this.conversations.inspectPositionChanges(
          run.agent_id,
          run.input_end_seq,
          channelId,
          rootId,
        );
        if (changes.length) {
          const draftId = randomUUID();
          this.db
            .prepare(
              "INSERT INTO owner_task_drafts(id,agent_id,task_id,action,input_json,input_end_seq,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'editing',?,?)",
            )
            .run(
              draftId,
              run.agent_id,
              task?.id ?? null,
              taskOperation,
              JSON.stringify(args),
              run.input_end_seq,
              this.now(),
              this.now(),
            );
          this.recordTaskDraftReviews(draftId, changes);
          return { channelId, status: "needs_review", draftId, changes, ...taskFacts };
        }
      } else {
        const draft = taskDraftRowSchema
          .optional()
          .parse(
            this.db
              .prepare("SELECT * FROM owner_task_drafts WHERE id=? AND agent_id=?")
              .get(args.draftId, run.agent_id),
          );
        if (
          !draft ||
          draft.action !== taskOperation ||
          draft.state !== "ready" ||
          draft.task_id !== (task?.id ?? null)
        )
          throw new AgentToolRefusal("Task draft is not ready");
        const original = z.record(z.string(), z.unknown()).parse(JSON.parse(draft.input_json));
        const current: Record<string, unknown> = { ...args };
        delete current.draftId;
        delete original.draftId;
        // A refreshed snapshot is new task knowledge, not a revision of the draft's work.
        if (taskOperation === "tasks.create") {
          delete current.taskSnapshot;
          delete original.taskSnapshot;
        }
        if (!isDeepStrictEqual(original, current))
          throw new AgentToolRefusal("Task draft changed; revise it first");
        if (this.unreviewedTaskChanges(draft).length)
          throw new AgentToolRefusal("Conversation changed; review the task draft again");
        readyDraft = draft;
      }
      let result: unknown;
      if (request.name === "tasks.create") {
        const taskSnapshot = taskFacts!.taskSnapshot;
        if (
          request.input.taskSnapshot === undefined
            ? tasks!.length > 0
            : request.input.taskSnapshot !== taskSnapshot
        )
          return { status: "tasks_changed", ...taskFacts };
        const created = this.createTaskForMessage(
          messageId!,
          "agent",
          run.agent_id,
          request.input.title,
        );
        result = {
          status: "created",
          task: created,
          taskSnapshot: this.taskSnapshot(this.tasksForMessage(messageId!)),
        };
      } else {
        result = this.mutateTask(run.agent_id, task!, request);
      }
      if (readyDraft)
        this.db
          .prepare("UPDATE owner_task_drafts SET state='applied',updated_at=? WHERE id=?")
          .run(this.now(), readyDraft.id);
      return result;
    });
  }

  agentTools() {
    return {
      "tasks.create": defineConversationTool(
        conversationToolDefinitions["tasks.create"],
        (run, toolCallId, args) => {
          return this.executeTaskChange(run, toolCallId, { name: "tasks.create", input: args });
        },
      ),
      "tasks.claim": defineConversationTool(
        conversationToolDefinitions["tasks.claim"],
        (run, toolCallId, args) => {
          return this.executeTaskChange(run, toolCallId, { name: "tasks.claim", input: args });
        },
      ),
      "tasks.yield": defineConversationTool(
        conversationToolDefinitions["tasks.yield"],
        (run, toolCallId, args) => {
          return this.executeTaskChange(run, toolCallId, { name: "tasks.yield", input: args });
        },
      ),
      "tasks.transfer": defineConversationTool(
        conversationToolDefinitions["tasks.transfer"],
        (run, toolCallId, args) => {
          return this.executeTaskChange(run, toolCallId, { name: "tasks.transfer", input: args });
        },
      ),
      "tasks.update": defineConversationTool(
        conversationToolDefinitions["tasks.update"],
        (run, toolCallId, args) => {
          return this.executeTaskChange(run, toolCallId, { name: "tasks.update", input: args });
        },
      ),
      "tasks.review": defineConversationTool(
        conversationToolDefinitions["tasks.review"],
        (run, toolCallId, args) => {
          return this.toolActions.record(run, toolCallId, "tasks.review", args, () => {
            const draft = taskDraftRowSchema
              .optional()
              .parse(
                this.db
                  .prepare("SELECT * FROM owner_task_drafts WHERE id=? AND agent_id=?")
                  .get(args.draftId, run.agent_id),
              );
            if (!draft) throw new AgentToolRefusal("Task draft is not available");
            const position = this.taskDraftPosition(draft);
            this.conversations.requireMembership(run.agent_id, position.channelId);
            const changes = this.unreviewedTaskChanges(draft);
            const result = {
              channelId: position.channelId,
              draftId: draft.id,
              state: draft.state,
              changes,
            };
            if (args.choice === "inspect") {
              this.recordTaskDraftReviews(draft.id, changes);
              return result;
            }
            if (draft.state === "abandoned" || draft.state === "applied")
              throw new AgentToolRefusal("Task draft is closed");
            if (args.choice === "continue" && changes.length)
              throw new AgentToolRefusal(
                "Conversation changed; inspect the task draft before continuing",
              );
            if (args.choice === "revise" && !args.revisedInput)
              throw new AgentToolRefusal("Revised task input is required");
            const state =
              args.choice === "revise"
                ? "editing"
                : args.choice === "keep"
                  ? "kept"
                  : args.choice === "abandon"
                    ? "abandoned"
                    : args.choice === "defer"
                      ? "deferred"
                      : "ready";
            this.recordTaskDraftReviews(draft.id, changes);
            this.db
              .prepare(
                "UPDATE owner_task_drafts SET input_json=COALESCE(?,input_json),state=?,updated_at=? WHERE id=?",
              )
              .run(
                args.choice === "revise" ? JSON.stringify(args.revisedInput) : null,
                state,
                this.now(),
                draft.id,
              );
            return { ...result, state };
          });
        },
      ),
      "tasks.list": defineConversationTool(
        conversationToolDefinitions["tasks.list"],
        (run, toolCallId, args) => {
          // Task visibility stays member-only: this ticket widened conversation READS, and
          // task ownership must not move with them.
          return {
            tasks: this.listTasks().filter((task) =>
              this.conversations.isMember(run.agent_id, task.channelId),
            ),
          };
        },
      ),
      "reminders.create": defineConversationTool(
        conversationToolDefinitions["reminders.create"],
        (run, toolCallId, args) => {
          this.conversations.requireMembership(run.agent_id, args.conversationId);
          return this.toolActions.record(run, toolCallId, "reminders.create", args, () => {
            if (args.taskId) {
              const task = this.readTask(args.taskId);
              if (!task || task.channelId !== args.conversationId)
                throw new AgentToolRefusal("Task is not in this conversation");
            }
            const id = randomUUID(),
              at = this.now();
            this.db
              .prepare(
                "INSERT INTO owner_reminders(id,agent_id,channel_id,task_id,text,due_at,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'active',?,?)",
              )
              .run(
                id,
                run.agent_id,
                args.conversationId,
                args.taskId ?? null,
                args.text,
                args.dueAt,
                at,
                at,
              );
            return this.readReminder(id)!;
          });
        },
      ),
      "reminders.reschedule": defineConversationTool(
        conversationToolDefinitions["reminders.reschedule"],
        (run, toolCallId, args) => {
          const reminder = this.readReminder(args.reminderId);
          if (!reminder || reminder.agentId !== run.agent_id)
            throw new AgentToolRefusal("Reminder is not available");
          return this.toolActions.record(run, toolCallId, "reminders.reschedule", args, () => {
            const current = this.readReminder(args.reminderId)!;
            if (current.version !== args.expectedVersion || current.state !== "active")
              throw new AgentToolRefusal("Reminder version or state changed");
            this.db
              .prepare(
                "UPDATE owner_reminders SET due_at=?,version=version+1,updated_at=? WHERE id=?",
              )
              .run(args.dueAt, this.now(), current.id);
            return this.readReminder(current.id)!;
          });
        },
      ),
      "reminders.cancel": defineConversationTool(
        conversationToolDefinitions["reminders.cancel"],
        (run, toolCallId, args) => {
          const reminder = this.readReminder(args.reminderId);
          if (!reminder || reminder.agentId !== run.agent_id)
            throw new AgentToolRefusal("Reminder is not available");
          return this.toolActions.record(run, toolCallId, "reminders.cancel", args, () => {
            const current = this.readReminder(args.reminderId)!;
            if (current.version !== args.expectedVersion || current.state !== "active")
              throw new AgentToolRefusal("Reminder version or state changed");
            this.db
              .prepare(
                "UPDATE owner_reminders SET state='cancelled',version=version+1,updated_at=? WHERE id=?",
              )
              .run(this.now(), current.id);
            return this.readReminder(current.id)!;
          });
        },
      ),
      "reminders.list": defineConversationTool(
        conversationToolDefinitions["reminders.list"],
        (run, toolCallId, args) => {
          this.syncHandledReminders();
          return { reminders: this.listAgentReminders(run.agent_id) };
        },
      ),
    };
  }
}
