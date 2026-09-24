import { encode, type Store } from "../storage/store.js";

export interface TransitionTask {
  id: string;
  target: string;
  owner: string | null;
  assigned_to: string | null;
  status: string;
  version: number;
  waiting_on: string | null;
  message_key: string | null;
  outbox_id: string | null;
  result: string | null;
}
export type TaskPatch = Partial<
  Pick<
    TransitionTask,
    | "target"
    | "owner"
    | "assigned_to"
    | "status"
    | "waiting_on"
    | "message_key"
    | "outbox_id"
    | "result"
  >
>;

/** The only runtime writer for task state and its matching event. */
export class TaskTransitions {
  constructor(readonly store: Store) {}
  private state(task: TransitionTask): unknown {
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
  created(task: TransitionTask, actor: string): void {
    this.store.atomic(() => {
      const at = Date.now();
      this.store.db.prepare("INSERT INTO task_event_baselines VALUES(?,0,1,?)").run(task.id, at);
      this.store.db
        .prepare("INSERT INTO task_events(task_id,at,body) VALUES(?,?,?)")
        .run(task.id, at, encode({ action: "create", actor, version: 0, to: this.state(task) }));
    });
  }
  change<T extends TransitionTask>(
    task: T,
    patch: TaskPatch,
    event: { action: string; actor?: string; cause?: unknown },
    expectedVersion = task.version,
  ): T {
    return this.store.atomic(() => {
      if (task.version !== expectedVersion) throw new Error("Task version conflict");
      const next = { ...task, ...patch };
      if (
        task.target === next.target &&
        task.owner === next.owner &&
        task.assigned_to === next.assigned_to &&
        task.status === next.status &&
        task.waiting_on === next.waiting_on &&
        task.message_key === next.message_key &&
        task.outbox_id === next.outbox_id &&
        task.result === next.result
      )
        return task;
      const version = task.version + 1;
      const changed = this.store.db
        .prepare(
          "UPDATE tasks SET target=?,owner=?,assigned_to=?,status=?,waiting_on=?,message_key=?,outbox_id=?,result=?,version=? WHERE id=? AND version=?",
        )
        .run(
          next.target,
          next.owner,
          next.assigned_to,
          next.status,
          next.waiting_on,
          next.message_key,
          next.outbox_id,
          next.result,
          version,
          task.id,
          task.version,
        ).changes;
      if (changed !== 1) throw new Error("Task version conflict");
      const updated = { ...next, version } as T;
      const from = this.state(task) as Record<string, unknown>,
        to = this.state(updated) as Record<string, unknown>;
      from.targetChanged = task.target !== updated.target;
      to.targetChanged = task.target !== updated.target;
      this.store.db.prepare("INSERT INTO task_events(task_id,at,body) VALUES(?,?,?)").run(
        task.id,
        Date.now(),
        encode({
          ...event,
          version,
          from,
          to,
          resultChanged: task.result !== updated.result,
        }),
      );
      return updated;
    });
  }
}
