import { randomUUID } from "node:crypto";
import { encode, type Store } from "../storage/store.js";
import type { ConversationTarget } from "../domain/conversations.js";
import type { SendBasis } from "../conversations/freshness.js";

/** A task row as this module reads and writes it. */
export interface TaskRow {
  id: string;
  work_id: string;
  parent_id: string | null;
  target: string;
  title: string;
  owner: string | null;
  assigned_to: string | null;
  status: string;
  version: number;
  waiting_on: string | null;
  result: string | null;
  outbox_id: string | null;
  message_key: string | null;
  created_by: string | null;
}
export type TaskPatch = Partial<
  Pick<
    TaskRow,
    | "target"
    | "owner"
    | "assigned_to"
    | "status"
    | "waiting_on"
    | "result"
    | "outbox_id"
    | "message_key"
  >
>;
export interface TaskEvent {
  action: string;
  actor?: string;
  cause?: unknown;
}
/** What became of a task's publication. Unknown and failed are records, not new tasks. */
export type PublicationOutcome =
  | { state: "sent"; messageKey: string }
  | { state: "unknown"; reason: string }
  | { state: "failed"; reason: string };
/** Everything this module needs from the conversation side to anchor and publish tasks. */
export interface AnchorPorts {
  /** The canonical conversation a message identity belongs to. */
  messageConversation(messageKey: string): string;
  /** Task visibility for one anchor: the confirmed message, or the pending publication. */
  visibleAs(actor: string, task: TaskRow): boolean;
  requireAccess(actor: string, conversationId: string): void;
  /** Register the task row as a canonical target after it moves. */
  mutable(id: string): void;
  /** Queue the task's visible message inside the caller's transaction and bind it to the work. */
  queue(
    agentId: string,
    workId: string,
    id: string,
    target: ConversationTarget,
    text: string,
    basis?: SendBasis,
  ): void;
  /** Wake one task's assignee after its publication became visible. */
  notify(agentId: string, task: TaskRow): void;
}

/**
 * The task module owns a task's whole association with the message it is published as.
 *
 * Every task row change and its matching history row are written here, inside the caller's SQLite
 * transaction, so a message, its task and the task event advance together or not at all. A task has
 * exactly one anchor, and only two shapes count: a confirmed message (`message_key`), or the
 * publication that will produce one (`outbox_id`). Nothing else creates or moves task state, and no
 * task is left without an anchor.
 */
export class TaskAnchors {
  constructor(
    readonly store: Store,
    readonly ports: AnchorPorts,
  ) {}
  task(id: string): TaskRow {
    const task = this.store.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as
      TaskRow | undefined;
    if (!task) throw new Error("Unknown task");
    this.ports.mutable(id);
    return task;
  }
  /** The one canonical task anchored to this message, or undefined. */
  findForMessage(messageKey: string): TaskRow | undefined {
    const row = this.store.db.prepare("SELECT * FROM tasks WHERE message_key=?").get(messageKey) as
      TaskRow | undefined;
    if (row) this.ports.mutable(row.id);
    return row;
  }
  /** Tasks whose publication is still pending on this outbox. */
  findForOutbox(outboxId: string): TaskRow[] {
    const rows = this.store.db
      .prepare("SELECT * FROM tasks WHERE outbox_id=?")
      .all(outboxId) as TaskRow[];
    for (const row of rows) this.ports.mutable(row.id);
    return rows;
  }
  /**
   * Wake a delegated task's assignee once its publication is visible. The caller supplies the
   * durable-delivery side; this module only decides that the task is now claimable.
   */
  notifyAssignee(assignee: string, task: TaskRow): void {
    this.ports.notify(assignee, task);
  }
  private state(task: TaskRow): Record<string, unknown> {
    return {
      owner: task.owner,
      assignedTo: task.assigned_to,
      status: task.status,
      waitingOn: task.waiting_on,
      messageId: task.message_key,
      outboxId: task.outbox_id,
      targetChanged: false,
    };
  }
  /** Record the task's creation and open its history baseline. */
  created(task: TaskRow, actor: string): void {
    this.store.atomic(() => this.writeCreated(task, actor));
  }
  private writeCreated(task: TaskRow, actor: string): void {
    const at = Date.now();
    this.store.db.prepare("INSERT INTO task_event_baselines VALUES(?,0,1,?)").run(task.id, at);
    this.store.db
      .prepare("INSERT INTO task_events(task_id,at,body) VALUES(?,?,?)")
      .run(task.id, at, encode({ action: "create", actor, version: 0, to: this.state(task) }));
  }
  /**
   * The only runtime writer for task state and its matching event. A patch that moves nothing
   * returns the original row, so repeating a publication stays idempotent.
   */
  change(
    task: TaskRow,
    patch: TaskPatch,
    event: TaskEvent,
    expectedVersion = task.version,
  ): TaskRow {
    return this.store.atomic(() => this.apply(task, patch, event, expectedVersion));
  }
  private apply(
    task: TaskRow,
    patch: TaskPatch,
    event: TaskEvent,
    expectedVersion: number,
  ): TaskRow {
    if (task.version !== expectedVersion) throw new Error("Task version conflict");
    const next = { ...task, ...patch };
    if (
      task.target === next.target &&
      task.owner === next.owner &&
      task.assigned_to === next.assigned_to &&
      task.status === next.status &&
      task.waiting_on === next.waiting_on &&
      task.result === next.result &&
      task.outbox_id === next.outbox_id &&
      task.message_key === next.message_key
    )
      return task;
    const version = task.version + 1;
    const changed = this.store.db
      .prepare(
        "UPDATE tasks SET target=?,owner=?,assigned_to=?,status=?,waiting_on=?,result=?,outbox_id=?,message_key=?,version=? WHERE id=? AND version=?",
      )
      .run(
        next.target,
        next.owner,
        next.assigned_to,
        next.status,
        next.waiting_on,
        next.result,
        next.outbox_id,
        next.message_key,
        version,
        task.id,
        task.version,
      ).changes;
    if (changed !== 1) throw new Error("Task version conflict");
    const updated = { ...next, version };
    const from = this.state(task),
      to = this.state(updated);
    from.targetChanged = task.target !== updated.target;
    to.targetChanged = task.target !== updated.target;
    this.store.db
      .prepare("INSERT INTO task_events(task_id,at,body) VALUES(?,?,?)")
      .run(
        task.id,
        Date.now(),
        encode({ ...event, version, from, to, resultChanged: task.result !== updated.result }),
      );
    return updated;
  }
  /**
   * Create a task anchored to exactly one thing: a confirmed message, or a reserved publication
   * identity that will produce one. A second call for the same confirmed message returns the
   * existing task, so recovery and retries cannot produce a second canonical task.
   */
  create(input: {
    agentId: string;
    workId: string;
    target: ConversationTarget;
    title: string;
    parentId?: string | undefined;
    messageKey?: string | undefined;
    pendingOutboxId: string;
  }): string {
    return this.store.atomic(() => this.write(input));
  }
  private write(input: {
    agentId: string;
    workId: string;
    target: ConversationTarget;
    title: string;
    parentId?: string | undefined;
    messageKey?: string | undefined;
    pendingOutboxId: string;
  }): string {
    const messageKey = input.messageKey;
    if (messageKey && this.ports.messageConversation(messageKey) !== input.target.conversationId)
      throw new Error("Task anchor belongs to another conversation");
    this.ports.requireAccess(input.agentId, input.target.conversationId);
    if (messageKey) {
      const existing = this.findForMessage(messageKey);
      if (existing) return existing.id;
    }
    const queued = this.findForOutbox(input.pendingOutboxId);
    if (queued.length) return queued[0]!.id;
    if (messageKey) {
      const id = randomUUID();
      this.store.db
        .prepare(
          "INSERT INTO tasks(id,work_id,parent_id,target,title,status,created_by,message_key,outbox_id) VALUES(?,?,?,?,?,'todo',?,?,?) ON CONFLICT(message_key) DO NOTHING",
        )
        .run(
          id,
          input.workId,
          input.parentId ?? null,
          encode(input.target),
          input.title,
          input.agentId,
          messageKey,
          input.pendingOutboxId,
        );
      const row = this.store.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as
        TaskRow | undefined;
      if (row) {
        this.ports.mutable(id);
        this.writeCreated(row, input.agentId);
        return id;
      }
      // Another writer won the anchor between the read and the insert; its task is canonical.
      const winner = this.findForMessage(messageKey);
      if (!winner) throw new Error("Task anchor could not be established");
      return winner.id;
    }
    // Waiting for a publication to produce its message is what "draft" means here, so the task is
    // born unclaimable instead of relying on each caller to demote it.
    const id = randomUUID();
    this.store.db
      .prepare(
        "INSERT INTO tasks(id,work_id,parent_id,target,title,status,created_by,message_key,outbox_id) VALUES(?,?,?,?,?,'draft',?,NULL,?)",
      )
      .run(
        id,
        input.workId,
        input.parentId ?? null,
        encode(input.target),
        input.title,
        input.agentId,
        input.pendingOutboxId,
      );
    this.ports.mutable(id);
    this.writeCreated(this.task(id), input.agentId);
    return id;
  }
  /**
   * Reserve a task for a publication that has not produced a message yet. It is anchored to that
   * reservation, carries no confirmed message, and is visible only to the actors arranging it,
   * until the publication confirms and this module gives it the message anchor.
   */
  draft(input: {
    agentId: string;
    workId: string;
    target: ConversationTarget;
    title: string;
    parentId?: string | undefined;
    assignedTo?: string | undefined;
    pendingOutboxId: string;
  }): string {
    const id = this.create(input);
    const task = this.task(id);
    if (task.assigned_to !== input.assignedTo)
      this.change(
        task,
        { assigned_to: input.assignedTo ?? task.assigned_to },
        { action: "draft", actor: input.agentId, cause: { outputId: input.pendingOutboxId } },
      );
    return id;
  }
  /**
   * Queue the task's visible publication. The task module fixes the publication identity before
   * the message exists, so the message, the task and its event advance in the caller's one
   * transaction while the network wait stays outside it. A task that reserved a different
   * publication identity for itself moves onto this one in the same transition.
   */
  publish(agentId: string, taskId: string, text: string, basis?: SendBasis): string {
    return this.store.atomic(() => this.writePublication(agentId, taskId, text, basis));
  }
  private writePublication(
    agentId: string,
    taskId: string,
    text: string,
    basis?: SendBasis,
  ): string {
    const task = this.task(taskId);
    if (task.created_by !== agentId) throw new Error("Task creator only");
    const outboxId = `task-publish:${taskId}`;
    if (task.message_key) throw new Error("Task is already published");
    this.ports.queue(agentId, task.work_id, outboxId, JSON.parse(task.target), text, basis);
    const updated = this.change(
      task,
      { outbox_id: outboxId },
      { action: "publication_queued", actor: agentId, cause: { outputId: outboxId } },
    );
    if (updated.version !== task.version) this.ports.mutable(taskId);
    return outboxId;
  }
  /**
   * A task that is still unpublished follows the publication that replaces its own, as one task
   * transition with its event. A task that already has a confirmed message keeps that anchor.
   */
  republish(
    actor: string,
    previousOutboxId: string,
    nextOutboxId: string,
    target: ConversationTarget,
  ): void {
    this.store.atomic(() => this.writeRepublish(actor, previousOutboxId, nextOutboxId, target));
  }
  private writeRepublish(
    actor: string,
    previousOutboxId: string,
    nextOutboxId: string,
    target: ConversationTarget,
  ): void {
    for (const task of this.findForOutbox(previousOutboxId)) {
      if (task.status !== "draft") continue;
      this.ports.requireAccess(actor, target.conversationId);
      this.change(
        task,
        { outbox_id: nextOutboxId, target: encode(target) },
        { action: "draft_revised", actor, cause: { previousOutboxId } },
      );
      this.ports.mutable(task.id);
    }
  }
  /**
   * Record that this publication produced a message. The first correct report gives the task its
   * confirmed anchor; repeating the same report changes nothing, and a different task already
   * owning that message is refused rather than silently displaced.
   */
  confirm(
    agentId: string,
    outboxId: string,
    messageKey: string,
    conversationId: string,
  ): TaskRow[] {
    return this.store.atomic(() =>
      this.writeConfirmation(agentId, outboxId, messageKey, conversationId),
    );
  }
  private writeConfirmation(
    agentId: string,
    outboxId: string,
    messageKey: string,
    conversationId: string,
  ): TaskRow[] {
    const tasks = this.findForOutbox(outboxId);
    for (const task of tasks) {
      if (task.message_key === messageKey) continue;
      const owner = this.findForMessage(messageKey);
      if (owner && owner.id !== task.id)
        throw new Error("Conflicting task anchor for this publication");
      if (this.ports.messageConversation(messageKey) !== conversationId)
        throw new Error("Publication message belongs to another conversation");
      let updated = this.change(
        task,
        { message_key: messageKey },
        {
          action: "publication_confirmed",
          actor: agentId,
          cause: { outputId: outboxId, messageId: messageKey },
        },
      );
      if (updated.status === "draft")
        updated = this.change(
          updated,
          { status: "todo" },
          { action: "visible_publication", cause: { outputId: outboxId, messageId: messageKey } },
        );
      this.ports.mutable(task.id);
    }
    return tasks;
  }
  /**
   * Record that a queued publication did not become a message, without inventing a second task.
   * A refused or unknown external result is evidence on the task's own history: a task still
   * waiting to be published is released as failed so it stops pretending to be in flight, while
   * one that already moved on keeps its state.
   */
  reflectUndelivered(
    actor: string,
    outboxId: string,
    outcome: Extract<PublicationOutcome, { state: "unknown" | "failed" }>,
  ): TaskRow[] {
    return this.store.atomic(() => this.writeUndelivered(actor, outboxId, outcome));
  }
  private writeUndelivered(
    actor: string,
    outboxId: string,
    outcome: Extract<PublicationOutcome, { state: "unknown" | "failed" }>,
  ): TaskRow[] {
    const tasks = this.findForOutbox(outboxId).filter((task) => task.status === "draft");
    for (const task of tasks) {
      this.change(
        task,
        { status: "failed", result: "Publication not delivered" },
        {
          action: `publication_${outcome.state}`,
          actor,
          cause: { outputId: outboxId, reason: outcome.reason },
        },
      );
      this.ports.mutable(task.id);
    }
    return tasks;
  }
  /**
   * Record that this publication carries the task's own state, so a later reader knows the message
   * speaks for a task rather than for a participant.
   */
  markPublished(taskId: string, outboxId: string, version: number): void {
    this.store.db
      .prepare(
        "INSERT INTO task_projections VALUES(?,?,?) ON CONFLICT(output_id) DO UPDATE SET version=excluded.version",
      )
      .run(outboxId, taskId, version);
  }
}

/**
 * The one place the task module is wired to the conversation side. Both the application assembly
 * and the collaboration service use it, so an embedded caller cannot end up with a second task
 * owner.
 */
export function taskAnchors(
  store: Store,
  ports: {
    messages: {
      references: { message(id: string): { conversationId: string } };
      requireAccess(actor: string, conversationId: string): void;
      records: { mutableTarget(type: "tasks", id: string): void };
    };
    output: {
      queue(
        actor: string,
        target: ConversationTarget,
        text: string,
        id?: string,
        basis?: SendBasis,
      ): string;
    };
    board: { visible(actor: string, task: TaskRow): boolean };
    bindOutputWork(outputId: string, workId: string): void;
    notify(agentId: string, task: TaskRow): void;
  },
): TaskAnchors {
  return new TaskAnchors(store, {
    messageConversation: (messageKey) =>
      ports.messages.references.message(messageKey).conversationId,
    visibleAs: (actor, task) => ports.board.visible(actor, task),
    requireAccess: (actor, conversationId) => ports.messages.requireAccess(actor, conversationId),
    mutable: (id) => ports.messages.records.mutableTarget("tasks", id),
    queue: (agentId, workId, id, target, text, basis) => {
      ports.output.queue(agentId, target, text, id, basis);
      ports.bindOutputWork(id, workId);
    },
    notify: (agentId, task) => ports.notify(agentId, task),
  });
}
