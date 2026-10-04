import type { OwnerMessage, OwnerPrincipalKind, OwnerTask } from "@mate/protocol/owner";
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { CurrentAgentToolRun } from "../../runtime/tools/entry.js";
import { AgentToolRefusal } from "../errors.js";
import { taskDraftRowSchema, taskRowSchema, toTask, type TaskDraftRow } from "../rows.js";
import { defineConversationTool, type ConversationToolActions } from "../tools/actions.js";
import { conversationToolDefinitions, type TaskToolRequest } from "../tools/contracts.js";

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
  recordTaskEvent(kind: string, channelId: string, task: OwnerTask): void;
}

/** Every task projection derives its channel from its anchor message. */
const taskSelection = `SELECT t.*,a.name AS owner_agent_name,m.channel_id
         FROM owner_tasks t
         JOIN owner_messages m ON m.id=t.message_id
         LEFT JOIN owner_agents a ON a.id=t.owner_agent_id`;

/** Task responsibility and draft freshness on the shared database. */
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
          // Task visibility stays member-only; reading a public conversation does not grant task ownership.
          return {
            tasks: this.listTasks().filter((task) =>
              this.conversations.isMember(run.agent_id, task.channelId),
            ),
          };
        },
      ),
    };
  }
}
