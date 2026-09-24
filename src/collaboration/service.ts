import { ConfiguredAgents, type AgentDirectory } from "../agents/directory.js";
import { CanonicalOutput as Output } from "../conversations/output.js";
import { Reminders, type Reminder } from "../reminders/service.js";
import type { SendBasis } from "../conversations/freshness.js";
import { ReviewSeats } from "../conversations/review-seats.js";
import { CanonicalAttention as Attention } from "../conversations/attention.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store, encode, type Delivery, type RunToken } from "../storage/store.js";
import { Conversations as Messages } from "../conversations/messages.js";
import {
  conversationTargetSchema as targetSchema,
  type ConversationTarget as Target,
} from "../domain/conversations.js";
import type { TeamSettings } from "../domain/agents.js";
import { TaskBoard } from "../coordination/board.js";
import { TaskAnchors, taskAnchors, type TaskRow } from "../coordination/tasks.js";
import { OperationsView } from "../operations/view.js";
import { UsageLedger } from "../usage/ledger.js";

export interface Work {
  id: string;
  target: string;
  state: string;
}
/** One task row, with the anchor that makes it the canonical task for a message. */
export type Task = TaskRow;
/** The conversation a delivery's own payload names, when it names one at all. */
function deliveryDestination(payload: string): string | undefined {
  return JSON.parse(payload).target?.conversationId;
}
export class Collaboration {
  readonly agents: AgentDirectory;
  readonly reminders: Reminders;
  readonly seats: ReviewSeats;
  readonly usage: UsageLedger;
  readonly board: TaskBoard;
  readonly operations: OperationsView;
  readonly tasks: TaskAnchors;
  constructor(
    readonly store: Store,
    readonly messages: Messages,
    readonly output: Output,
    readonly config: TeamSettings,
    /** One attention instance per application; the freshness gate and this service share it. */
    readonly attention: Attention = new Attention(messages),
    /** One task module per application, built by the assembly so freshness can reach it too. */
    taskModule?: TaskAnchors,
  ) {
    this.agents = new ConfiguredAgents(config.agents);
    this.config = {
      agents: this.agents.list(),
      ownerUserIds: [...config.ownerUserIds],
      runTimeoutMs: config.runTimeoutMs,
    };
    this.reminders = new Reminders(this);
    this.usage = new UsageLedger(store);
    this.seats = new ReviewSeats(messages, config.ownerUserIds);
    this.board = new TaskBoard(this);
    this.tasks =
      taskModule ??
      taskAnchors(store, {
        messages: this.messages,
        output: this.output,
        board: { visible: (actor, task) => this.board.visible(actor, task) },
        bindOutputWork: (outputId, workId) => this.bindOutputWork(outputId, workId),
        notify: (agentId, task) => this.notifyTaskAssignee(agentId, task),
      });
    this.operations = new OperationsView(this);
    // A revised publication must reach the tasks that follow it. When the caller supplied the
    // application's task module the gate already knows it; an embedded caller that let this
    // service build its own module gets the same wiring here.
    if (!taskModule) this.output.gate?.attachRevisions(this.tasks);
  }
  /** The one rule for what may own a child task: same work, same owner, still open. */
  private requireParent(agentId: string, workId: string, parentId: string | undefined): void {
    if (!parentId) return;
    this.board.read(agentId, parentId);
    const parent = this.task(parentId);
    if (
      parent.work_id !== workId ||
      parent.owner !== agentId ||
      !["doing", "waiting", "review"].includes(parent.status)
    )
      throw new Error("Invalid parent task");
  }
  /** Bind a queued publication to the activity that owns it. */
  bindOutputWork(outputId: string, workId: string): void {
    const old = this.store.db
      .prepare("SELECT work_id FROM output_work WHERE output_id=?")
      .get(outputId) as { work_id: string } | undefined;
    if (old && old.work_id !== workId) throw new Error("Output work conflict");
    this.store.db
      .prepare("INSERT INTO output_work VALUES(?,?) ON CONFLICT DO NOTHING")
      .run(outputId, workId);
  }
  /** The durable wakeup a newly visible delegated task owes its assignee. */
  notifyTaskAssignee(assignee: string, task: Task): void {
    this.enqueue(assignee, task.work_id, `delegate:${task.id}`, {
      kind: "delegation",
      taskId: task.id,
      target: JSON.parse(task.target),
      receivedAt: Date.now(),
    });
  }
  work(id: string): Work {
    const work = this.store.db.prepare("SELECT id,target,state FROM works WHERE id=?").get(id) as
      Work | undefined;
    if (!work) throw new Error("Unknown work");
    this.messages.records.mutableTarget("works", id);
    return work;
  }
  task(id: string): Task {
    return this.tasks.task(id);
  }
  list(agentId: string): Task[] {
    if (this.messages.isolated(agentId)) return [];
    return this.board
      .list(agentId, { relation: "all-visible", limit: 100 })
      .items.map((item) => this.task(item.id));
  }
  currentWork(run: RunToken, fallback: string): string {
    this.store.assertRun(run);
    return (
      (
        this.store.db.prepare("SELECT work_id FROM run_context WHERE run_id=?").get(run.id) as
          { work_id: string } | undefined
      )?.work_id ?? fallback
    );
  }
  assertActionWork(run: RunToken, workId: string): void {
    this.store.assertRun(run);
    this.active(workId);
  }
  selectWork(run: RunToken, workId: string): void {
    this.assertActionWork(run, workId);
    const work = this.active(workId);
    this.messages.requireAccess(run.agentId, JSON.parse(work.target).conversationId);
    this.store.atomic(() => {
      this.store.db
        .prepare(
          "INSERT INTO run_context VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET work_id=excluded.work_id",
        )
        .run(run.id, workId);
      this.store.db
        .prepare(
          "INSERT INTO delivery_context VALUES(?,?) ON CONFLICT(delivery_id) DO UPDATE SET work_id=excluded.work_id",
        )
        .run(run.deliveryId, workId);
    });
  }
  active(workId: string): Work {
    const work = this.work(workId);
    if (work.state !== "active") throw new Error("Work paused or cancelled");
    return work;
  }
  /** Work identifies an activity and its owner-controlled lifecycle. */
  createWork(origin: string, target: Target): string {
    targetSchema.parse(target);
    return this.store.atomic(() => {
      const old = this.store.db.prepare("SELECT id FROM works WHERE origin=?").get(origin) as
        { id: string } | undefined;
      if (old) return old.id;
      const id = randomUUID();
      this.store.db
        .prepare("INSERT INTO works(id,origin,target) VALUES(?,?,?)")
        .run(id, origin, encode(target));
      this.messages.writes.mutable("works", id);
      return id;
    });
  }
  bindDelivery(deliveryId: string, workId: string): void {
    this.work(workId);
    const old = this.store.db
      .prepare("SELECT work_id FROM delivery_work WHERE delivery_id=?")
      .get(deliveryId) as { work_id: string } | undefined;
    if (old && old.work_id !== workId) throw new Error("Delivery work conflict");
    this.store.db
      .prepare("INSERT INTO delivery_work VALUES(?,?) ON CONFLICT DO NOTHING")
      .run(deliveryId, workId);
  }
  enqueue(agentId: string, workId: string, key: string, payload: unknown): string {
    return this.store.atomic(() => {
      this.active(workId);
      const id = this.messages.writes.enqueue(agentId, key, payload, 50);
      this.bindDelivery(id, workId);
      return id;
    });
  }
  /**
   * This Agent's own durable deliveries that are still relevant under its current access. It is
   * content-free metadata: another Agent's delivery never appears, and one whose target this Agent
   * may no longer read drops out instead of staying as a stale reference.
   */
  inbox(agentId: string): { id: string; status: string; kind: unknown }[] {
    return (
      this.store.db
        .prepare(
          "SELECT id,payload,status FROM deliveries WHERE agent_id=? AND status!='handled' ORDER BY created_at LIMIT 50",
        )
        .all(agentId) as { id: string; payload: string; status: string }[]
    )
      .map((row) => ({ row, payload: JSON.parse(row.payload) as Record<string, unknown> }))
      .filter(({ payload }) => {
        const target = payload.target as { conversationId?: string } | undefined;
        return !target?.conversationId || this.messages.access(agentId, target.conversationId);
      })
      .map(({ row, payload }) => ({ id: row.id, status: row.status, kind: payload.kind }));
  }
  /** One own delivery with its payload decoded, re-read under the Agent's current target access. */
  ownDelivery(
    agentId: string,
    deliveryId: string,
  ): Omit<Delivery, "payload"> & { payload: unknown } {
    const delivery = this.store.delivery(deliveryId);
    if (delivery.agent_id !== agentId) throw new Error("Private inbox");
    const destination = deliveryDestination(delivery.payload);
    if (destination) this.messages.requireAccess(agentId, destination);
    return { ...delivery, payload: JSON.parse(delivery.payload) };
  }
  send(
    agentId: string,
    workId: string,
    target: Target,
    text: string,
    id: string = randomUUID(),
    basis?: SendBasis,
  ): string {
    return this.store.atomic(() => {
      this.active(workId);
      this.output.queue(agentId, target, text, id, basis);
      this.bindOutputWork(id, workId);
      return id;
    });
  }
  /** Bind a run to its delivery's activity without granting access or imposing a quota. */
  bindRunWork(run: RunToken, workId: string): void {
    this.store.atomic(() => {
      this.store.assertRun(run);
      this.active(workId);
      if (this.store.db.prepare("SELECT 1 FROM work_runs WHERE run_id=?").get(run.id))
        throw new Error("Run already bound");
      const binding = this.store.db
        .prepare(
          "SELECT COALESCE(dc.work_id,dw.work_id) work_id FROM delivery_work dw LEFT JOIN delivery_context dc ON dc.delivery_id=dw.delivery_id WHERE dw.delivery_id=?",
        )
        .get(run.deliveryId) as { work_id: string } | undefined;
      if (!binding || binding.work_id !== workId) throw new Error("Run work mismatch");
      this.store.db
        .prepare("INSERT INTO run_context VALUES(?,?) ON CONFLICT DO NOTHING")
        .run(run.id, workId);
      this.store.db
        .prepare("INSERT INTO work_runs(run_id,work_id) VALUES(?,?)")
        .run(run.id, workId);
    });
  }
  /**
   * Create a task anchored to the message it will own, or to the publication that will produce it.
   * The caller supplies the reserved publication identity, so the anchor exists before the message
   * does and a retry cannot produce a second canonical task.
   */
  createTask(input: {
    agentId: string;
    workId: string;
    target: Target;
    title: string;
    parentId?: string | undefined;
    messageKey?: string | undefined;
    pendingOutboxId: string;
  }): string {
    targetSchema.parse(input.target);
    z.string().min(1).max(500).parse(input.title);
    if (!input.messageKey && !input.pendingOutboxId)
      throw new Error("Task requires a message anchor or a queued publication");
    return this.store.atomic(() => {
      this.active(input.workId);
      this.requireParent(input.agentId, input.workId, input.parentId);
      return this.tasks.create(input);
    });
  }
  claim(agentId: string, id: string, expectedVersion?: number): Task {
    return this.store.atomic(() => {
      this.board.read(agentId, id);
      const task = this.task(id);
      this.active(task.work_id);
      if (expectedVersion !== undefined && task.version !== expectedVersion)
        throw new Error("Task version conflict");
      if (
        task.owner !== null ||
        !["todo", "review"].includes(task.status) ||
        (task.assigned_to !== null && task.assigned_to !== agentId)
      )
        throw new Error("Task already claimed or unavailable");
      return this.tasks.change(
        task,
        { owner: agentId, status: task.status === "review" ? "review" : "doing" },
        { action: "claim", actor: agentId },
      );
    });
  }
  /** The precondition a claim must still satisfy at the version the caller inspected. */
  claimable(agentId: string, id: string): boolean {
    this.board.read(agentId, id);
    const task = this.task(id);
    this.active(task.work_id);
    return (
      task.owner === null &&
      ["todo", "review"].includes(task.status) &&
      (task.assigned_to === null || task.assigned_to === agentId)
    );
  }
  owned(agentId: string, id: string): Task {
    this.board.read(agentId, id);
    const task = this.task(id);
    this.active(task.work_id);
    if (task.owner !== agentId || ["done", "cancelled", "failed", "draft"].includes(task.status))
      throw new Error("Task not owned or terminal");
    return task;
  }
  delegate(
    agentId: string,
    parentId: string,
    peerId: string,
    title: string,
    basis?: SendBasis,
  ): string {
    return this.store.atomic(() => {
      const parent = this.owned(agentId, parentId),
        target = JSON.parse(parent.target) as Target;
      const peer = this.messages.agent(peerId);
      if (peerId === agentId) throw new Error("Cannot delegate to self");
      this.messages.requireAccess(peerId, target.conversationId);
      const outputId = `delegate:${randomUUID()}`,
        id = this.createTask({
          agentId,
          workId: parent.work_id,
          target,
          title,
          parentId,
          pendingOutboxId: outputId,
        });
      this.tasks.change(
        this.task(id),
        { status: "draft", assigned_to: peerId, outbox_id: outputId },
        { action: "delegation_draft", actor: agentId, cause: { peerId } },
      );
      this.send(
        agentId,
        parent.work_id,
        target,
        `${peer.name}: ${title}\nMate task: ${id}`,
        outputId,
        basis,
      );
      // The task module's own poll links the task to the message once the publication is
      // confirmed, so a failed, unknown or restarted publication never produces a second task.
      return id;
    });
  }
  /**
   * Create a task that waits for its own publication to become visible: anchored to the reserved
   * publication, unclaimable and invisible to other Agents until then.
   */
  draftTask(input: {
    agentId: string;
    workId: string;
    target: Target;
    title: string;
    parentId?: string | undefined;
    assignedTo?: string | undefined;
    pendingOutboxId: string;
  }): string {
    targetSchema.parse(input.target);
    return this.store.atomic(() => {
      this.active(input.workId);
      this.requireParent(input.agentId, input.workId, input.parentId);
      return this.tasks.draft(input);
    });
  }
  /**
   * Attach an already-queued visible publication to the task it publishes, so the task and its
   * event move with the message in one transaction. The publication must not already anchor
   * another task.
   */
  attachPublication(agentId: string, id: string, outboxId: string): Task {
    return this.store.atomic(() => {
      const task = this.task(id);
      if (task.created_by !== agentId) throw new Error("Task creator only");
      if (this.tasks.findForOutbox(outboxId).length)
        throw new Error("Publication already anchors a task");
      return this.tasks.change(
        task,
        { status: "draft", outbox_id: outboxId },
        { action: "draft", actor: agentId, cause: { outputId: outboxId } },
      );
    });
  }
  /** Link one confirmed publication to the task that anchored it, whatever produced it. */
  private confirmPublication(agentId: string, outboxId: string, wake = true): void {
    if (this.store.output(outboxId)?.state !== "sent") return;
    const task = this.tasks.findForOutbox(outboxId)[0];
    if (!task) return;
    const messageKey = this.messages.records.confirmedMessageId(outboxId),
      reconciled = this.tasks.confirm(
        agentId,
        outboxId,
        messageKey,
        JSON.parse(task.target).conversationId,
      );
    // A paused or cancelled activity still gets the anchor, so its task cannot be created twice;
    // only a runnable assignee is woken.
    if (!wake) return;
    for (const row of reconciled)
      if (row.id === task.id && row.parent_id && row.assigned_to)
        this.tasks.notifyAssignee(row.assigned_to, row);
  }
  /**
   * The task module's own poll: a task whose publication became visible gets its confirmed anchor,
   * and one whose publication is known not to have arrived stops waiting. Idempotent, so a restart
   * or a repeated pass cannot create a second task.
   */
  activateDelegations(): void {
    this.store.atomic(() => {
      // Every task whose publication has not produced a message is reconciled, whatever its work
      // item is doing: which message a task is anchored to is not a scheduling decision. The
      // index on `outbox_id` plus `message_key IS NULL` keeps this to the publications in flight.
      const unreconciled = this.store.db
        .prepare(
          "SELECT t.*,o.agent_id publisher,o.state outbox_state,o.receipt outbox_receipt,w.state work_state FROM tasks t JOIN outbox o ON o.id=t.outbox_id JOIN works w ON w.id=t.work_id WHERE t.message_key IS NULL AND o.state IN ('sent','failed','unknown')",
        )
        .all() as (Task & {
        publisher: string;
        outbox_state: string;
        outbox_receipt: string | null;
        work_state: string;
      })[];
      for (const task of unreconciled) {
        if (task.outbox_state === "sent") {
          this.confirmPublication(task.publisher, task.outbox_id!, task.work_state === "active");
          continue;
        }
        const receipt = JSON.parse(task.outbox_receipt ?? "null") as { reason?: string } | null,
          reason = receipt?.reason ?? "publication_outcome_unknown",
          failed = this.tasks.reflectUndelivered(task.publisher, task.outbox_id!, {
            state: task.outbox_state === "unknown" ? "unknown" : "failed",
            reason,
          });
        for (const row of failed)
          if (row.id === task.id && task.work_state === "active") this.wakeDependents(row);
      }
    });
  }
  private wakeDependents(task: Task): void {
    const waiters = this.store.db
      .prepare("SELECT * FROM tasks WHERE waiting_on=? AND status='waiting'")
      .all(task.id) as Task[];
    for (const waiter of waiters) {
      this.tasks.change(
        waiter,
        { status: "doing", waiting_on: null },
        {
          action: "dependency_wake",
          cause: { dependencyId: task.id, dependencyVersion: task.version },
        },
      );
      const delivery = this.messages.writes.enqueue(
        waiter.owner!,
        `dependency:${waiter.id}:${task.id}:${task.version}`,
        {
          kind: "dependency",
          taskId: waiter.id,
          dependencyId: task.id,
          target: JSON.parse(waiter.target),
        },
        50,
      );
      this.bindDelivery(delivery, waiter.work_id);
    }
  }
  wait(agentId: string, taskId: string, dependencyId: string, expectedVersion?: number): void {
    this.store.atomic(() => {
      const task = this.owned(agentId, taskId);
      this.board.read(agentId, dependencyId);
      const dependency = this.task(dependencyId);
      if (expectedVersion !== undefined && task.version !== expectedVersion)
        throw new Error("Task version conflict");
      if (taskId === dependencyId) throw new Error("Invalid dependency");
      const queue = [dependency.id],
        visited = new Set<string>();
      while (queue.length) {
        const current = queue.pop()!;
        if (current === taskId) throw new Error("Dependency cycle");
        if (visited.has(current)) continue;
        visited.add(current);
        const node = this.task(current);
        if (node.waiting_on) queue.push(node.waiting_on);
        const children = this.store.db
          .prepare(
            "SELECT id FROM tasks WHERE parent_id=? AND status NOT IN ('done','cancelled','failed')",
          )
          .all(current) as { id: string }[];
        queue.push(...children.map((c) => c.id));
      }
      if (["done", "cancelled", "failed"].includes(dependency.status)) {
        if (task.status === "waiting")
          this.tasks.change(
            task,
            { status: "doing", waiting_on: null },
            { action: "dependency_already_terminal", actor: agentId, cause: { dependencyId } },
          );
        this.enqueue(
          agentId,
          task.work_id,
          `dependency:${taskId}:${dependencyId}:${dependency.version}`,
          { kind: "dependency", taskId, dependencyId, target: JSON.parse(task.target) },
        );
        return;
      }
      this.tasks.change(
        task,
        { status: "waiting", waiting_on: dependencyId },
        { action: "wait", actor: agentId, cause: { dependencyId } },
      );
    });
  }
  update(
    agentId: string,
    id: string,
    status: "doing" | "review" | "done" | "cancelled" | "failed",
    result?: string,
    expectedVersion?: number,
  ): void {
    this.store.atomic(() => {
      this.board.read(agentId, id);
      let task = this.task(id);
      if (
        task.status === "draft" &&
        status === "cancelled" &&
        task.parent_id &&
        this.owned(agentId, task.parent_id).work_id === task.work_id
      ) {
        const output = task.outbox_id ? this.store.output(task.outbox_id) : undefined;
        if (output?.state === "pending")
          this.store.transitionOutput(output.id, "pending", "failed", {
            reason: "delegation_cancelled",
          });
      } else task = this.owned(agentId, id);
      if (expectedVersion !== undefined && task.version !== expectedVersion)
        throw new Error("Task version conflict");
      if ((status === "done" || status === "review") && !result?.trim())
        throw new Error("Evidence/result required");
      if (
        status === "done" &&
        this.store.db
          .prepare(
            "SELECT 1 FROM tasks WHERE parent_id=? AND status NOT IN ('done','cancelled','failed')",
          )
          .get(id)
      )
        throw new Error("Unfinished child tasks");
      const updated = this.tasks.change(
        task,
        { status, result: result ?? task.result, waiting_on: null },
        { action: status, actor: agentId },
      );
      if (["done", "cancelled", "failed"].includes(status)) {
        this.wakeDependents(updated);
      }
    });
  }
  /** Publish a freshly created task as its own visible message, in one transaction. */
  publishTask(agentId: string, id: string, text: string, basis?: SendBasis): Task {
    return this.store.atomic(() => {
      const outboxId = this.tasks.publish(agentId, id, text, basis);
      this.tasks.markPublished(id, outboxId, this.task(id).version);
      return this.task(id);
    });
  }
  /** Release ownership and hand the task to whoever claims it next. */
  unclaim(agentId: string, id: string, expectedVersion: number): Task {
    return this.store.atomic(() => {
      const task = this.owned(agentId, id);
      return this.tasks.change(
        task,
        {
          owner: null,
          assigned_to: null,
          status: task.status === "review" ? "review" : "todo",
          waiting_on: null,
        },
        { action: "tasks.unclaim", actor: agentId },
        expectedVersion,
      );
    });
  }
  /** Hand work to a peer with the same versioned transition and its event. */
  transfer(
    agentId: string,
    id: string,
    peerId: string,
    expectedVersion: number,
    reviewDisposition?: "preserve_review" | "return_for_changes",
  ): Task {
    return this.store.atomic(() => {
      const task = this.owned(agentId, id),
        target = JSON.parse(task.target) as Target;
      this.board.read(peerId, id);
      if (task.status === "review" && !reviewDisposition)
        throw new Error("Review transfer requires disposition");
      if (task.status !== "review" && reviewDisposition)
        throw new Error("Review disposition applies only to review tasks");
      const status =
        task.status === "review" && reviewDisposition === "preserve_review" ? "review" : "doing";
      const updated = this.tasks.change(
        task,
        { owner: peerId, assigned_to: null, status, waiting_on: null },
        {
          action: "tasks.transfer",
          actor: agentId,
          cause: { peerId, reviewDisposition: reviewDisposition ?? null },
        },
        expectedVersion,
      );
      this.enqueue(peerId, task.work_id, `transfer:${task.id}:${updated.version}`, {
        kind: "task_transfer",
        taskId: task.id,
        target,
      });
      return updated;
    });
  }
  schedule(
    agentId: string,
    workId: string,
    target: Target,
    nextAt: number,
    timezone: string,
    cron?: string,
    taskId?: string,
  ): string {
    return this.reminders.create(agentId, workId, {
      target,
      nextAt,
      timezone,
      cron,
      taskId,
      content: "Follow up on the referenced conversation or task.",
    }).id;
  }
  cancelSchedule(agentId: string, id: string): void {
    const r = this.reminders.read(agentId, id);
    this.reminders.cancel(agentId, id, r.version);
  }
  reschedule(agentId: string, id: string, nextAt: number): void {
    const r = this.reminders.read(agentId, id);
    this.reminders.edit(agentId, id, r.version, {
      target: JSON.parse(r.target),
      content: r.content,
      nextAt,
      timezone: r.timezone,
      cron: r.cron ?? undefined,
      taskId: r.task_id ?? undefined,
      anchor: r.anchor ? JSON.parse(r.anchor) : undefined,
    });
  }
  schedules(agentId: string): Reminder[] {
    return this.reminders.list(agentId);
  }
  tick(now = Date.now()): void {
    this.store.atomic(() => {
      const deferred = this.store.db
        .prepare(
          "SELECT agent_id,target,deferred_until,muted FROM attention_state WHERE deferred_until>0 AND deferred_until<=?",
        )
        .all(now) as { agent_id: string; target: string; deferred_until: number; muted: number }[];
      for (const item of deferred) {
        const target = JSON.parse(item.target) as Target;
        this.store.db
          .prepare("UPDATE attention_state SET deferred_until=0 WHERE agent_id=? AND target=?")
          .run(item.agent_id, item.target);
        const channelMuted = this.store.db
          .prepare("SELECT 1 FROM attention_state WHERE agent_id=? AND target=? AND muted=1")
          .get(item.agent_id, encode({ conversationId: target.conversationId }));
        if (!this.messages.access(item.agent_id, target.conversationId)) continue;
        if (
          (item.muted || channelMuted) &&
          !this.attention.peek(item.agent_id, now, target).some((item) => "target" in item)
        )
          continue;
        const work = this.createWork(`attention:${item.agent_id}:${item.target}`, target);
        if (this.work(work).state === "active")
          this.enqueue(item.agent_id, work, `defer:${item.target}:${item.deferred_until}`, {
            kind: "attention_due",
            target,
          });
      }
      this.reminders.tick(now);
    });
  }
  /** Returns affected run IDs for the supervisor's independent abort channel. */
  control(ownerId: string, workId: string, operation: "pause" | "resume" | "cancel"): string[] {
    if (!this.config.ownerUserIds.includes(ownerId)) throw new Error("Owner only");
    return this.store.atomic(() => {
      const work = this.work(workId);
      if (work.state === "cancelled") throw new Error("Cancelled work cannot resume");
      const runs = this.store.db
        .prepare(
          "SELECT r.id,r.agent_id FROM runs r LEFT JOIN run_context rc ON rc.run_id=r.id JOIN delivery_work dw ON dw.delivery_id=r.delivery_id WHERE COALESCE(rc.work_id,dw.work_id)=? AND r.state='active'",
        )
        .all(workId) as { id: string; agent_id: string }[];
      this.store.db
        .prepare("UPDATE works SET state=? WHERE id=?")
        .run(
          operation === "resume" ? "active" : operation === "pause" ? "paused" : "cancelled",
          workId,
        );
      if (operation !== "resume") {
        for (const run of runs) {
          this.store.db
            .prepare("UPDATE agents SET generation=generation+1 WHERE id=?")
            .run(run.agent_id);
          this.store.transitionRun(run.id, "interrupted", "work_stopped");
          this.store.db
            .prepare("UPDATE actions SET state='unknown' WHERE run_id=? AND state='executing'")
            .run(run.id);
        }
      }
      if (operation === "cancel") {
        this.reminders.cancelWork(workId);
        const tasks = this.store.db
          .prepare(
            "SELECT * FROM tasks WHERE work_id=? AND status NOT IN ('done','cancelled','failed')",
          )
          .all(workId) as Task[];
        for (const task of tasks)
          this.tasks.change(
            task,
            { status: "cancelled", waiting_on: null },
            { action: "work_cancelled", cause: { ownerId } },
          );
      }
      this.store.audit("work_control", { ownerId, workId, operation });
      return runs.map((r) => r.id);
    });
  }
}
