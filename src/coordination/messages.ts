import { randomUUID } from "node:crypto";
import type { Collaboration, Task } from "../collaboration/service.js";
import { encode, type RunToken } from "../storage/store.js";
import type { MessageDTO as NormalMessage } from "../domain/messages.js";
import type { ConversationTarget as Target } from "../domain/conversations.js";
import type { SendBasis } from "../conversations/freshness.js";
interface Ref {
  messageId: string;
}
interface Intent {
  id: string;
  agent_id: string;
  work_id: string;
  operation: string;
  args: string;
  target: string;
  state: string;
  hold_id: string | null;
  receipt: string | null;
}
/** The object references one task mutation names in its own validated input. */
export interface TaskReference {
  taskId?: string | undefined;
  /** The visible message this mutation is about, when it names no task of its own. */
  anchor?: { messageId: string } | undefined;
  /** The original spelling of `anchor`, kept for the operations that already shipped it. */
  message?: { messageId: string } | undefined;
}
/** A step the Agent can take next, written where the Agent already looks for its own intents. */
export interface ConflictStep {
  step: "observe" | "apply" | "discard";
  tool: string;
  args?: Record<string, unknown>;
}
/** A task that moved after this intent was prepared: the intent is rebound, not silently applied. */
export interface TaskVersionConflict {
  conflict: "task_version";
  operation: string;
  expectedVersion: number;
  currentVersion: number;
  task: {
    id: string;
    status: string;
    owner: string | null;
    assignedTo: string | null;
    version: number;
    messageId: string | null;
  };
  steps: ConflictStep[];
}
/** The message a mutation names, in either of the two spellings its input allows. */
function anchorOf(args: TaskReference): Ref | undefined {
  return args.anchor ?? args.message;
}
export class MessageTasks {
  constructor(readonly c: Collaboration) {}
  private message(actor: string, ref: Ref): NormalMessage {
    const message = this.c.messages.message(actor, ref.messageId);
    if (message.deleted) throw new Error("Message not visible or deleted");
    return message;
  }
  /**
   * Work ownership of one task mutation: the referenced task's work item, the work of the task
   * already published from the referenced message, or the work the mutation was recorded with.
   * Both references are re-read under the acting Agent's current visibility.
   */
  workOf(actor: string, args: TaskReference, fallback: string): string {
    if (args.taskId) return this.c.board.read(actor, args.taskId).workId;
    const ref = anchorOf(args);
    if (!ref) return fallback;
    const message = this.c.messages.message(actor, ref.messageId),
      // The task module answers which task a message anchors; the message's own activity binding
      // covers a message that has no task at all.
      anchored = this.c.tasks.findForMessage(message.id);
    if (anchored) {
      this.c.board.read(actor, anchored.id);
      return anchored.work_id;
    }
    const row = this.c.store.db
      .prepare("SELECT work_id FROM message_work WHERE message_key=?")
      .get(message.id) as { work_id: string } | undefined;
    return row?.work_id ?? fallback;
  }
  /** Work item of one held mutation this Agent owns, re-read from the work its arguments name. */
  holdWork(actor: string, id: string): string {
    const held = this.intent(actor, id);
    return this.workOf(actor, JSON.parse(held.args) as TaskReference, held.work_id);
  }
  find(actor: string, ref: Ref): Task | undefined {
    const m = this.message(actor, ref);
    this.c.activateDelegations();
    return this.c.tasks.findForMessage(m.id);
  }
  /** The thread a new task anchored to this message belongs to. */
  private anchorTarget(actor: string, ref: Ref): Target {
    const m = this.message(actor, ref);
    if (!m.rootId) throw new Error("Message root is unknown");
    return { conversationId: m.conversationId, threadId: m.rootId };
  }
  private target(actor: string, args: any): Target {
    if (args.taskId) {
      this.c.board.read(actor, args.taskId);
      return JSON.parse(this.c.task(args.taskId).target);
    }
    return this.anchorTarget(actor, anchorOf(args)!);
  }
  /**
   * The task one intent addresses: the task named by id, or the canonical task anchored to the
   * message. Resolving by anchor creates the task only when none exists, so two Agents naming the
   * same message converge on one task row.
   */
  private resolved(run: RunToken, args: any, workId: string, target: Target): Task {
    const c = this.c,
      ref = anchorOf(args);
    if (!ref) {
      const task = c.task(args.taskId);
      c.assertActionWork(run, task.work_id);
      return task;
    }
    // A publication whose message is already visible may simply not be linked yet. Confirming it
    // first is what keeps the message's one canonical task from being created twice.
    c.activateDelegations();
    const message = this.message(run.agentId, ref),
      existing = c.tasks.findForMessage(message.id);
    if (existing) {
      c.assertActionWork(run, existing.work_id);
      return existing;
    }
    c.assertActionWork(run, workId);
    const created = c.createTask({
      agentId: run.agentId,
      workId,
      target,
      title: message.text.slice(0, 500) || "Message task",
      messageKey: message.id,
      pendingOutboxId: `task-anchor:${message.id}`,
    });
    // A task created now cannot be the one the caller inspected, so only the first version is
    // claimable by intent; any other expectation is a conflict rather than a fresh task.
    if (args.expectedVersion !== 0) throw new Error("Task version conflict");
    return c.task(created);
  }
  submit(
    run: RunToken,
    workId: string,
    id: string,
    operation: string,
    args: any,
    viewToken?: string,
  ): unknown {
    const s = this.c.store;
    return s.atomic(() => {
      s.assertRun(run);
      const target = this.target(run.agentId, args),
        old = s.db.prepare("SELECT * FROM task_intents WHERE id=?").get(id) as Intent | undefined;
      if (old) {
        if (
          old.agent_id !== run.agentId ||
          old.operation !== operation ||
          old.args !== encode(args)
        )
          throw new Error("Task intent identity conflict");
        return this.describe(run.agentId, id);
      }
      s.db
        .prepare("INSERT INTO task_intents VALUES(?,?,?,?,?,?,?,NULL,NULL)")
        .run(id, run.agentId, workId, operation, encode(args), encode(target), "held");
      this.c.messages.writes.mutable("task_intents", id);
      return this.tryApply(run, id, viewToken, false);
    });
  }
  describe(actor: string, id: string): unknown {
    const i = this.intent(actor, id);
    return {
      intentId: i.id,
      status: i.state,
      holdId: i.hold_id,
      target: JSON.parse(i.target),
      result: i.receipt ? this.c.messages.records.taskIntentResult(i.receipt) : null,
      choices: ["retry_with_view", "discard", "continue_once"],
    };
  }
  private intent(actor: string, id: string): Intent {
    const i = this.c.store.db
      .prepare("SELECT * FROM task_intents WHERE id=? AND agent_id=?")
      .get(id, actor) as Intent | undefined;
    if (!i) throw new Error("Unknown task intent");
    this.c.messages.records.mutableTarget("task_intents", id);
    this.c.messages.requireAccess(actor, JSON.parse(i.target).conversationId);
    return i;
  }
  retry(run: RunToken, id: string, viewToken?: string): unknown {
    return this.c.store.atomic(() => this.tryApply(run, id, viewToken, false));
  }
  continue(run: RunToken, id: string, holdId: string): unknown {
    return this.c.store.atomic(() => {
      const i = this.intent(run.agentId, id);
      if (i.state !== "held" || i.hold_id !== holdId) throw new Error("Task hold receipt conflict");
      return this.tryApply(run, id, undefined, true);
    });
  }
  discard(run: RunToken, id: string): unknown {
    this.c.store.assertRun(run);
    const i = this.intent(run.agentId, id);
    if (i.state !== "held") throw new Error("Task intent is not held");
    this.c.store.db.prepare("UPDATE task_intents SET state='discarded' WHERE id=?").run(id);
    return this.describe(run.agentId, id);
  }
  private conflict(i: Intent, task: Task, expected: number): TaskVersionConflict {
    return {
      conflict: "task_version",
      operation: i.operation,
      expectedVersion: expected,
      currentVersion: task.version,
      task: {
        id: task.id,
        status: task.status,
        owner: task.owner,
        assignedTo: task.assigned_to,
        version: task.version,
        messageId: task.message_key,
      },
      steps: [
        { step: "observe", tool: "tasks.read", args: { taskId: task.id } },
        { step: "apply", tool: "tasks.continue" },
        { step: "discard", tool: "tasks.discard" },
      ],
    };
  }
  private tryApply(
    run: RunToken,
    id: string,
    token: string | undefined,
    continued: boolean,
  ): unknown {
    const c = this.c,
      s = c.store;
    s.assertRun(run);
    const i = this.intent(run.agentId, id);
    if (i.state !== "held") return this.describe(run.agentId, id);
    const args = JSON.parse(i.args),
      target = this.target(run.agentId, args);
    if (!continued && !c.attention.valid(run, target, token)) {
      s.db.prepare("UPDATE task_intents SET hold_id=? WHERE id=?").run(randomUUID(), id);
      return this.describe(run.agentId, id);
    }
    const task = this.resolved(run, args, i.work_id, target),
      expectedVersion: number = args.expectedVersion;
    c.messages.requireAccess(run.agentId, JSON.parse(task.target).conversationId);
    if (task.version !== expectedVersion) {
      // Another writer moved the task after this intent was prepared. Rebind the version the
      // intent will be applied at, so the Agent's next explicit acknowledgement is decisive, and
      // report the change instead of either overwriting it or failing with no usable next step.
      args.expectedVersion = task.version;
      s.db.prepare("UPDATE task_intents SET args=? WHERE id=?").run(encode(args), id);
      return {
        ...(this.describe(run.agentId, id) as Record<string, unknown>),
        ...this.conflict(i, task, expectedVersion),
      };
    }
    const previousVersion = task.version;
    switch (i.operation) {
      case "tasks.claim":
        if (!c.claimable(run.agentId, task.id))
          throw new Error("Task already claimed or unavailable");
        c.claim(run.agentId, task.id, expectedVersion);
        break;
      case "tasks.wait":
        c.wait(run.agentId, task.id, args.dependencyId, expectedVersion);
        break;
      case "tasks.update":
        c.update(run.agentId, task.id, args.status, args.result, expectedVersion);
        break;
      case "tasks.unclaim":
        c.unclaim(run.agentId, task.id, expectedVersion);
        break;
      case "tasks.transfer":
        c.transfer(run.agentId, task.id, args.peerId, expectedVersion, args.reviewDisposition);
        break;
      default:
        throw new Error("Invalid task operation");
    }
    const updated = c.task(task.id);
    if (updated.version !== previousVersion) {
      if (updated.message_key) {
        const source = s.db
          .prepare("SELECT thread FROM messages WHERE key=?")
          .get(updated.message_key) as { thread: string };
        s.db
          .prepare(
            "INSERT INTO conversation_events(channel,thread,message_key,revision,kind) VALUES(?,?,?,?,?)",
          )
          .run(
            target.conversationId,
            source.thread,
            updated.message_key,
            `task:${updated.version}`,
            "task",
          );
      }
      const outputId = `task-state:${updated.id}:${updated.version}`;
      c.send(
        run.agentId,
        updated.work_id,
        target,
        `Mate task ${updated.id}: ${updated.status}; owner=${updated.owner ?? "unclaimed"}; version=${updated.version}; source=${updated.message_key ?? "message being published"}.`,
        outputId,
        { run, systemProjection: true },
      );
      c.tasks.markPublished(updated.id, outputId, updated.version);
    }
    s.db
      .prepare("UPDATE task_intents SET state='applied',hold_id=NULL,receipt=? WHERE id=?")
      .run(encode({ format: "mate.task-intent.v2", task: updated }), id);
    return this.describe(run.agentId, id);
  }
  /**
   * Create a task and publish it as a visible message, in one transaction. When the request names
   * the message the task is anchored to, the new task is already anchored; otherwise the intended
   * target becomes the anchor and the task waits for that message to be confirmed visible.
   */
  create(
    run: RunToken,
    workId: string,
    target: Target,
    title: string,
    viewToken?: string,
    anchor?: Ref,
  ): Task {
    return this.c.store.atomic(() => {
      const basis: SendBasis = { run, ...(viewToken ? { viewToken } : {}) },
        anchored = anchor ? this.anchorTarget(run.agentId, anchor) : undefined,
        id = this.c.createTask({
          agentId: run.agentId,
          workId,
          target: anchored ?? target,
          title,
          ...(anchor ? { messageKey: anchor.messageId } : {}),
          pendingOutboxId: `task-publish-reservation:${randomUUID()}`,
        });
      this.c.publishTask(run.agentId, id, title, basis);
      return this.c.task(id);
    });
  }
}
