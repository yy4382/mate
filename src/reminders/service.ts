import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import type { Collaboration } from "../collaboration/service.js";
import { encode } from "../storage/store.js";
import {
  conversationTargetSchema as targetSchema,
  type ConversationTarget as Target,
} from "../domain/conversations.js";
export interface Reminder {
  id: string;
  agent_id: string;
  work_id: string;
  task_id: string | null;
  target: string;
  next_at: number;
  cron: string | null;
  timezone: string;
  active: number;
  content: string;
  anchor: string | null;
  version: number;
  legacy: number;
  projection: "private" | "conversation_receipt";
}
export interface ReminderInput {
  target: Target;
  content: string;
  nextAt: number;
  timezone: string;
  cron?: string | undefined;
  taskId?: string | undefined;
  anchor?: { messageId: string } | undefined;
  projection?: "private" | "conversation_receipt" | undefined;
}
export class Reminders {
  constructor(readonly c: Collaboration) {}
  private validate(actor: string, input: ReminderInput): void {
    targetSchema.parse(input.target);
    this.c.messages.requireAccess(actor, input.target.conversationId);
    z.string().min(1).max(12000).parse(input.content);
    if (!input.content.trim()) throw new Error("Reminder purpose required");
    z.number().int().nonnegative().max(8640000000000000).parse(input.nextAt);
    new Intl.DateTimeFormat("en", { timeZone: input.timezone });
    if (input.cron)
      CronExpressionParser.parse(input.cron, {
        currentDate: input.nextAt,
        tz: input.timezone,
      }).next();
    if (input.taskId) this.c.board.read(actor, input.taskId);
    if (input.anchor && this.c.messages.message(actor, input.anchor.messageId).deleted)
      throw new Error("Reminder anchor is not visible");
    z.enum(["private", "conversation_receipt"]).parse(input.projection ?? "private");
  }
  private event(r: Reminder, kind: string, payload: unknown): void {
    const s = this.c.store;
    s.db
      .prepare(
        "INSERT INTO reminder_events(reminder_id,version,kind,at,payload,actor_id) VALUES(?,?,?,?,?,?)",
      )
      .run(r.id, r.version, kind, Date.now(), encode(payload), r.agent_id);
  }
  read(actor: string, id: string): Reminder {
    const r = this.c.store.db
      .prepare("SELECT * FROM schedules WHERE id=? AND agent_id=?")
      .get(id, actor) as Reminder | undefined;
    if (!r) throw new Error("Unknown owned reminder");
    this.c.messages.records.mutableTarget("schedules", id);
    this.c.messages.requireAccess(actor, JSON.parse(r.target).conversationId);
    return r;
  }
  /**
   * Work item of one firing this Agent owns, re-read with current target access so a firing
   * carried across an await cannot act after membership was withdrawn.
   */
  firingWork(actor: string, firingId: string): string {
    const row = this.c.store.db
      .prepare(
        "SELECT r.agent_id,r.work_id,r.target FROM reminder_firings f JOIN schedules r ON r.id=f.reminder_id WHERE f.id=?",
      )
      .get(firingId) as { agent_id: string; work_id: string; target: string } | undefined;
    if (!row || row.agent_id !== actor) throw new Error("Unknown owned reminder firing");
    this.c.messages.requireAccess(actor, JSON.parse(row.target).conversationId);
    return row.work_id;
  }
  list(actor: string, before = Number.MAX_SAFE_INTEGER): (Reminder & { cursor: number })[] {
    const rows = this.c.store.db
      .prepare(
        "SELECT r.*,r.rowid cursor FROM schedules r JOIN channel_access a ON a.agent_id=r.agent_id AND a.channel=json_extract(r.target,'$.conversationId') AND a.active=1 WHERE r.agent_id=? AND r.rowid<? ORDER BY r.rowid DESC LIMIT 100",
      )
      .all(actor, before) as (Reminder & { cursor: number })[];
    for (const row of rows) this.c.messages.records.mutableTarget("schedules", row.id);
    return rows;
  }
  create(actor: string, workId: string, input: ReminderInput): Reminder {
    this.c.active(workId);
    this.validate(actor, input);
    const s = this.c.store,
      id = randomUUID();
    return s.atomic(() => {
      s.db
        .prepare(
          "INSERT INTO schedules(id,agent_id,work_id,task_id,target,next_at,cron,timezone,content,anchor,legacy,projection) VALUES(?,?,?,?,?,?,?,?,?,?,0,?)",
        )
        .run(
          id,
          actor,
          workId,
          input.taskId ?? null,
          encode(input.target),
          input.nextAt,
          input.cron ?? null,
          input.timezone,
          input.content,
          input.anchor ? encode(input.anchor) : null,
          input.projection ?? "private",
        );
      s.db.prepare("INSERT INTO reminder_event_baselines VALUES(?,1,?)").run(id, Date.now());
      this.c.messages.writes.mutable("schedules", id);
      const reminder = this.read(actor, id);
      this.event(reminder, "created", {});
      return reminder;
    });
  }
  edit(actor: string, id: string, expectedVersion: number, input: ReminderInput): unknown {
    return this.c.store.atomic(() => {
      const r = this.read(actor, id);
      if (r.version !== expectedVersion) throw new Error("Reminder version conflict");
      this.c.active(r.work_id);
      this.validate(actor, input);
      this.c.store.db
        .prepare(
          "UPDATE schedules SET target=?,content=?,next_at=?,timezone=?,cron=?,task_id=?,anchor=?,projection=?,active=1,version=version+1,legacy=0 WHERE id=?",
        )
        .run(
          encode(input.target),
          input.content,
          input.nextAt,
          input.timezone,
          input.cron ?? null,
          input.taskId ?? null,
          input.anchor ? encode(input.anchor) : null,
          input.projection ?? r.projection,
          id,
        );
      this.c.messages.writes.mutable("schedules", id);
      const updated = this.read(actor, id);
      this.event(updated, "edited", { previousVersion: r.version });
      return { reminder: updated, previousFirings: this.firings(id) };
    });
  }
  cancel(actor: string, id: string, expectedVersion: number, cancelPending = false): unknown {
    return this.c.store.atomic(() => {
      const r = this.read(actor, id);
      if (r.version !== expectedVersion) throw new Error("Reminder version conflict");
      this.c.store.db.prepare("UPDATE schedules SET active=0,version=version+1 WHERE id=?").run(id);
      const withdrawn: string[] = [];
      let withdrawnCount = 0;
      if (cancelPending) {
        const pending = this.c.store.db
          .prepare(
            "SELECT d.id FROM deliveries d JOIN reminder_firings f ON f.delivery_id=d.id WHERE f.reminder_id=? AND d.status='pending' AND NOT EXISTS(SELECT 1 FROM runs run WHERE run.delivery_id=d.id AND run.state='active') LIMIT 100",
          )
          .all(id) as { id: string }[];
        withdrawn.push(...pending.map((row) => row.id));
        withdrawnCount = this.c.store.db
          .prepare(
            "UPDATE deliveries SET status='handled' WHERE status='pending' AND NOT EXISTS(SELECT 1 FROM runs run WHERE run.delivery_id=deliveries.id AND run.state='active') AND id IN(SELECT delivery_id FROM reminder_firings WHERE reminder_id=?)",
          )
          .run(id).changes;
      }
      const updated = this.read(actor, id);
      this.event(updated, "cancelled", {
        futureCancelled: true,
        withdrawn,
        withdrawnCount,
        inFlightNotCancelled: this.ongoing(id),
      });
      return {
        reminder: updated,
        futureCancelled: true,
        withdrawn,
        withdrawnCount,
        inFlightNotCancelled: this.ongoing(id),
        previousFirings: this.firings(id),
      };
    });
  }
  private ongoing(id: string): string[] {
    return (
      this.c.store.db
        .prepare(
          "SELECT d.id FROM deliveries d JOIN reminder_firings f ON f.delivery_id=d.id WHERE f.reminder_id=? AND (d.status='injected' OR EXISTS(SELECT 1 FROM runs run WHERE run.delivery_id=d.id AND run.state='active'))",
        )
        .all(id) as { id: string }[]
    ).map((row) => row.id);
  }
  private firings(id: string, before?: string, limit = 100): any[] {
    let cursor: { dueAt: number; version: number; id: string } | undefined;
    if (before) {
      try {
        cursor = JSON.parse(Buffer.from(before, "base64url").toString("utf8"));
      } catch {
        throw new Error("Invalid reminder firing cursor");
      }
    }
    return this.c.store.db
      .prepare(
        `SELECT f.id firing_id,f.delivery_id,d.status status,d.status delivery_status,d.run_id,run.state run_status,f.due_at,f.version,f.output_id,o.state receipt_status,f.result_status,f.result_summary,f.result_at,
   EXISTS(SELECT 1 FROM runs run WHERE run.delivery_id=d.id AND run.state='active') running
   FROM reminder_firings f JOIN deliveries d ON d.id=f.delivery_id LEFT JOIN runs run ON run.id=d.run_id LEFT JOIN outbox o ON o.id=f.output_id
   WHERE f.reminder_id=? AND (? IS NULL OR f.due_at<? OR (f.due_at=? AND (f.version<? OR (f.version=? AND f.id<?))))
   ORDER BY f.due_at DESC,f.version DESC,f.id DESC LIMIT ?`,
      )
      .all(
        id,
        cursor?.dueAt ?? null,
        cursor?.dueAt ?? null,
        cursor?.dueAt ?? null,
        cursor?.version ?? null,
        cursor?.version ?? null,
        cursor?.id ?? null,
        limit,
      ) as any[];
  }
  log(actor: string, id: string, eventBefore?: number, firingBefore?: string): unknown {
    this.read(actor, id);
    const events = this.c.store.db
        .prepare(
          "SELECT * FROM reminder_events WHERE reminder_id=? AND seq<? ORDER BY seq DESC LIMIT 51",
        )
        .all(id, eventBefore ?? Number.MAX_SAFE_INTEGER) as any[],
      firings = this.firings(id, firingBefore, 51),
      eventPage = events.slice(0, 50),
      firingPage = firings.slice(0, 50),
      last = firingPage.at(-1);
    return {
      events: eventPage,
      firings: firingPage,
      eventCursor: events.length > 50 ? eventPage.at(-1)!.seq : null,
      firingCursor:
        firings.length > 50 && last
          ? Buffer.from(
              encode({ dueAt: last.due_at, version: last.version, id: last.firing_id }),
            ).toString("base64url")
          : null,
    };
  }
  finish(
    actor: string,
    firingId: string,
    status: "completed" | "failed" | "deferred",
    summary?: string,
  ): unknown {
    return this.c.store.atomic(() => {
      z.enum(["completed", "failed", "deferred"]).parse(status);
      if (summary !== undefined) z.string().max(12000).parse(summary);
      const row = this.c.store.db
        .prepare(
          "SELECT f.*,r.agent_id,r.target FROM reminder_firings f JOIN schedules r ON r.id=f.reminder_id WHERE f.id=?",
        )
        .get(firingId) as any;
      if (!row || row.agent_id !== actor) throw new Error("Unknown owned reminder firing");
      this.c.messages.requireAccess(actor, JSON.parse(row.target).conversationId);
      if (row.result_status) {
        if (row.result_status !== status || (row.result_summary ?? null) !== (summary ?? null))
          throw new Error("Reminder firing result conflict");
        return {
          firingId,
          status: row.result_status,
          summary: row.result_summary,
          resultAt: row.result_at,
          deferredDoesNotReschedule: true,
        };
      }
      const at = Date.now();
      this.c.store.db
        .prepare(
          "UPDATE reminder_firings SET result_status=?,result_summary=?,result_at=? WHERE id=? AND result_status IS NULL",
        )
        .run(status, summary ?? null, at, firingId);
      const reminder = this.read(actor, row.reminder_id);
      this.event(reminder, "finished", { firingId, status });
      return {
        firingId,
        status,
        summary: summary ?? null,
        resultAt: at,
        deferredDoesNotReschedule: true,
      };
    });
  }
  cancelWork(workId: string): void {
    for (const r of this.c.store.db
      .prepare("SELECT * FROM schedules WHERE work_id=? AND active=1")
      .all(workId) as Reminder[]) {
      this.c.store.db
        .prepare("UPDATE schedules SET active=0,version=version+1 WHERE id=?")
        .run(r.id);
      this.event({ ...r, version: r.version + 1 }, "owner_work_cancelled", {});
    }
  }
  tick(now: number): void {
    const c = this.c,
      s = c.store;
    const due = s.db
      .prepare(
        "SELECT r.* FROM schedules r JOIN works w ON w.id=r.work_id JOIN agents a ON a.id=r.agent_id JOIN channel_access acl ON acl.agent_id=r.agent_id AND acl.channel=json_extract(r.target,'$.conversationId') AND acl.active=1 WHERE r.active=1 AND r.next_at<=? AND w.state='active' AND a.paused=0 ORDER BY r.next_at,r.id LIMIT 100",
      )
      .all(now) as Reminder[];
    for (const r of due) {
      c.messages.records.mutableTarget("schedules", r.id);
      const target = JSON.parse(r.target) as Target;
      if (!c.messages.access(r.agent_id, target.conversationId)) continue;
      const firing = `reminder:${r.id}:${r.version}:${r.next_at}`;
      const delivery = c.enqueue(r.agent_id, r.work_id, firing, {
        kind: "reminder",
        firingId: firing,
        reminderId: r.id,
        version: r.version,
        content: r.content,
        taskId: r.task_id,
        anchor: r.anchor ? JSON.parse(r.anchor) : null,
        target,
        dueAt: r.next_at,
        receivedAt: now,
      });
      let output: string | null = null;
      if (r.projection === "conversation_receipt") {
        output = `${firing}:receipt`;
        c.messages.writes.queueOutput(r.agent_id, output, {
          target,
          text: `Reminder ${r.id} fired for ${r.agent_id} (version ${r.version}, due ${new Date(r.next_at).toISOString()}).`,
        });
        s.db.prepare("INSERT INTO output_work VALUES(?,?)").run(output, r.work_id);
        s.db
          .prepare("INSERT INTO system_projections VALUES(?,'reminder',?,?)")
          .run(output, r.id, r.version);
        c.output.gate?.queued(r.agent_id, output);
      }
      s.db
        .prepare(
          "INSERT INTO reminder_firings(id,reminder_id,due_at,version,delivery_id,output_id,actor_id) VALUES(?,?,?,?,?,?,?)",
        )
        .run(firing, r.id, r.next_at, r.version, delivery, output, r.agent_id);
      if (r.cron)
        s.db
          .prepare("UPDATE schedules SET next_at=?,version=version+1 WHERE id=?")
          .run(
            CronExpressionParser.parse(r.cron, { currentDate: now, tz: r.timezone })
              .next()
              .getTime(),
            r.id,
          );
      else s.db.prepare("UPDATE schedules SET active=0,version=version+1 WHERE id=?").run(r.id);
      this.event({ ...r, version: r.version + 1 }, "fired", {
        dueAt: r.next_at,
        deliveryId: delivery,
        outputId: output,
        catchUp: "coalesce_to_one",
      });
    }
  }
}
