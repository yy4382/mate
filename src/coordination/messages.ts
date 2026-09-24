import { randomUUID } from "node:crypto";
import type { Collaboration, Task } from "../collaboration/service.js";
import { encode, type RunToken } from "../storage/store.js";
import type { MessageDTO as NormalMessage } from "../domain/messages.js";
import type { ConversationTarget as Target } from "../domain/conversations.js";
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
export class MessageTasks {
  constructor(readonly c: Collaboration) {}
  private message(actor: string, ref: Ref): NormalMessage {
    const message = this.c.messages.message(actor, ref.messageId);
    if (message.deleted) throw new Error("Message not visible or deleted");
    return message;
  }
  find(actor: string, ref: Ref): Task | undefined {
    const m = this.message(actor, ref);
    this.c.activateDelegations();
    return this.c.store.db.prepare("SELECT * FROM tasks WHERE message_key=?").get(m.id) as
      Task | undefined;
  }
  private target(actor: string, args: any): Target {
    if (args.message) {
      const m = this.message(actor, args.message);
      if (!m.rootId) throw new Error("Message root is unknown");
      return { conversationId: m.conversationId, threadId: m.rootId };
    }
    this.c.board.read(actor, args.taskId);
    return JSON.parse(this.c.task(args.taskId).target);
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
    let task: Task;
    if (args.message) {
      const message = this.message(run.agentId, args.message),
        key = message.id,
        existing = this.find(run.agentId, args.message);
      if (existing) task = existing;
      else {
        if (args.expectedVersion !== 0) throw new Error("Task version conflict");
        const bound = s.db
          .prepare("SELECT work_id FROM message_work WHERE message_key=?")
          .get(key) as { work_id: string } | undefined;
        const work = bound?.work_id ?? i.work_id;
        c.assertActionWork(run, work);
        const taskId = c.createTask(
          run.agentId,
          work,
          target,
          message.text.slice(0, 500) || "Message task",
          undefined,
          { messageKey: key },
        );
        task = c.task(taskId);
      }
    } else task = c.task(args.taskId);
    c.assertActionWork(run, task.work_id);
    c.messages.requireAccess(run.agentId, JSON.parse(task.target).conversationId);
    if (task.version !== args.expectedVersion) throw new Error("Task version conflict");
    const previousVersion = task.version;
    switch (i.operation) {
      case "tasks.claim":
        c.claim(run.agentId, task.id, args.expectedVersion);
        break;
      case "tasks.wait":
        c.wait(run.agentId, task.id, args.dependencyId, args.expectedVersion);
        break;
      case "tasks.update":
        c.update(run.agentId, task.id, args.status, args.result, args.expectedVersion);
        break;
      case "tasks.unclaim":
        c.unclaim(run.agentId, task.id, args.expectedVersion);
        break;
      case "tasks.transfer":
        c.transfer(run.agentId, task.id, args.peerId, args.expectedVersion, args.reviewDisposition);
        break;
      default:
        throw new Error("Invalid task operation");
    }
    task = c.task(task.id);
    if (task.version !== previousVersion) {
      if (task.message_key) {
        const source = s.db
          .prepare("SELECT thread FROM messages WHERE key=?")
          .get(task.message_key) as { thread: string };
        s.db
          .prepare(
            "INSERT INTO conversation_events(channel,thread,message_key,revision,kind) VALUES(?,?,?,?,?)",
          )
          .run(
            target.conversationId,
            source.thread,
            task.message_key,
            `task:${task.version}`,
            "task",
          );
      }
      const outputId = `task-state:${task.id}:${task.version}`;
      c.send(
        run.agentId,
        task.work_id,
        target,
        `Mate task ${task.id}: ${task.status}; owner=${task.owner ?? "unclaimed"}; version=${task.version}; source=${task.message_key ? task.message_key : "legacy unanchored task"}.`,
        outputId,
        { run, systemProjection: true },
      );
      s.db
        .prepare("INSERT INTO task_projections VALUES(?,?,?)")
        .run(outputId, task.id, task.version);
    }
    s.db
      .prepare("UPDATE task_intents SET state='applied',hold_id=NULL,receipt=? WHERE id=?")
      .run(encode({ format: "mate.task-intent.v2", task }), id);
    return this.describe(run.agentId, id);
  }
  create(run: RunToken, workId: string, target: Target, title: string, viewToken?: string): Task {
    return this.c.store.atomic(() => {
      const id = this.c.createTask(run.agentId, workId, target, title),
        outputId = `task-create:${id}`;
      this.c.send(run.agentId, workId, target, title, outputId, { run, viewToken });
      return this.c.draftTask(run.agentId, id, outputId);
    });
  }
}
