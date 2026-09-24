import { z } from "zod";
import type { Collaboration, Task } from "../collaboration/service.js";
import { encode, hash } from "../storage/store.js";
import type { ConversationTarget } from "../domain/conversations.js";

export const taskRelationSchema = z.enum(["owned", "assigned", "available", "all-visible"]);
export type TaskRelation = z.infer<typeof taskRelationSchema>;
export interface TaskListInput {
  relation: TaskRelation;
  status?: string | undefined;
  target?: ConversationTarget | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}
export interface TaskDTO {
  id: string;
  workId: string;
  parentId: string | null;
  target: ConversationTarget;
  title: string;
  owner: string | null;
  assignedTo: string | null;
  createdBy: string | null;
  status: string;
  version: number;
  waitingOn: string | null;
  result: string | null;
  messageId: string | null;
  legacy: boolean;
}

interface Cursor {
  signature: string;
  before: string;
}
interface TaskRow extends Task {
  created_by: string | null;
}
const rawScanLimit = 200;

export class TaskBoard {
  constructor(readonly c: Collaboration) {}
  private signature(
    actor: string,
    input: {
      relation: TaskRelation;
      status: string | null;
      target: ConversationTarget | null;
      limit: number;
    },
  ): string {
    return hash(encode({ actor, ...input }));
  }
  private decode(cursor: string | undefined, signature: string): string | undefined {
    if (!cursor) return;
    let parsed: Cursor;
    try {
      parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Cursor;
    } catch {
      throw new Error("Invalid task cursor");
    }
    if (parsed.signature !== signature || typeof parsed.before !== "string")
      throw new Error("Task cursor query mismatch");
    return parsed.before;
  }
  private encode(signature: string, before: string): string {
    return Buffer.from(encode({ signature, before } satisfies Cursor)).toString("base64url");
  }
  private visible(actor: string, row: TaskRow): boolean {
    if (this.c.messages.isolated(actor))
      throw new Error("Independent review seat isolates task board");
    const target = JSON.parse(row.target) as ConversationTarget;
    if (!this.c.messages.access(actor, target.conversationId)) return false;
    if (row.status === "draft" && row.created_by !== actor && row.assigned_to !== actor)
      return false;
    if (
      !row.message_key &&
      row.outbox_id &&
      row.created_by !== actor &&
      row.assigned_to !== actor &&
      row.owner !== actor
    )
      return false;
    if (row.message_key) {
      const conversation = this.c.messages.references.conversation(target.conversationId);
      if (conversation.authority === "internal" && conversation.kind === "channel") return true;
      try {
        return !this.c.messages.message(actor, row.message_key).deleted;
      } catch {
        return false;
      }
    }
    return row.status !== "draft" || row.created_by === actor || row.assigned_to === actor;
  }
  private dto(row: TaskRow): TaskDTO {
    this.c.messages.records.mutableTarget("tasks", row.id);
    return {
      id: row.id,
      workId: row.work_id,
      parentId: row.parent_id,
      target: JSON.parse(row.target),
      title: row.title,
      owner: row.owner,
      assignedTo: row.assigned_to,
      createdBy: row.created_by,
      status: row.status,
      version: row.version,
      waitingOn: row.waiting_on,
      result: row.result,
      messageId: row.message_key,
      legacy: Boolean(row.legacy),
    };
  }
  list(
    actor: string,
    input: TaskListInput,
  ): {
    items: TaskDTO[];
    cursor: string | null;
    coverage: { historicalComplete: boolean; legacyUnanchored: number };
  } {
    this.c.messages.agent(actor);
    this.c.messages.requireReadable(actor);
    const relation = taskRelationSchema.parse(input.relation),
      limit = z
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(input.limit ?? 20);
    if (input.target) this.c.messages.references.validateTarget(input.target);
    const bound = { relation, status: input.status ?? null, target: input.target ?? null, limit },
      signature = this.signature(actor, bound),
      before = this.decode(input.cursor, signature);
    const clauses = ["(? IS NULL OR id<?)"],
      params: unknown[] = [before ?? null, before ?? null];
    if (input.status) {
      clauses.push("status=?");
      params.push(input.status);
    }
    if (input.target) {
      clauses.push("json_extract(target,'$.conversationId')=?");
      params.push(input.target.conversationId);
      if (input.target.threadId) {
        clauses.push("json_extract(target,'$.threadId')=?");
        params.push(input.target.threadId);
      }
    }
    if (relation === "owned") {
      clauses.push("owner=?");
      params.push(actor);
    } else if (relation === "assigned") {
      clauses.push("assigned_to=? AND (owner IS NULL OR owner!=?)");
      params.push(actor, actor);
    } else if (relation === "available") {
      clauses.push(
        "owner IS NULL AND status IN ('todo','review') AND (assigned_to IS NULL OR assigned_to=?)",
      );
      params.push(actor);
    }
    const items: TaskDTO[] = [];
    let scanBefore = before,
      more = false,
      scanned = 0,
      exhausted = false;
    scan: while (items.length < limit && scanned < rawScanLimit) {
      const index =
        relation === "owned"
          ? "task_list_owner"
          : relation === "assigned"
            ? "task_list_assigned"
            : relation === "available"
              ? "task_list_available"
              : input.target?.threadId
                ? "task_list_thread"
                : input.target
                  ? "task_list_conversation"
                  : input.status
                    ? "task_list_status"
                    : "sqlite_autoindex_tasks_1";
      const batchLimit = Math.min(101, rawScanLimit - scanned),
        sql = `SELECT * FROM tasks INDEXED BY ${index} WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ${batchLimit}`;
      const batch = this.c.store.db.prepare(sql).all(...params) as TaskRow[];
      if (!batch.length) {
        exhausted = true;
        break;
      }
      for (const row of batch) {
        const visible = this.visible(actor, row);
        if (visible && items.length === limit) {
          more = true;
          break scan;
        }
        scanned++;
        scanBefore = row.id;
        if (visible) items.push(this.dto(row));
      }
      if (batch.length < batchLimit) {
        exhausted = true;
        break;
      }
      params[0] = scanBefore;
      params[1] = scanBefore;
    }
    if (!exhausted && (scanned >= rawScanLimit || items.length === limit)) more = true;
    const returned = items,
      cursor = more && scanBefore ? this.encode(signature, scanBefore) : null;
    const gaps = this.c.store.db
      .prepare(
        `SELECT COUNT(*) n FROM tasks t JOIN task_event_baselines b ON b.task_id=t.id WHERE b.historical_complete=0 AND t.id IN (${returned.map(() => "?").join(",") || "''"})`,
      )
      .get(...returned.map((item) => item.id)) as { n: number };
    return {
      items: returned,
      cursor,
      coverage: {
        historicalComplete: gaps.n === 0,
        legacyUnanchored: returned.filter((item) => item.legacy && !item.messageId).length,
      },
    };
  }
  read(actor: string, id: string): TaskDTO {
    this.c.messages.agent(actor);
    this.c.messages.requireReadable(actor);
    const row = this.c.store.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as
      TaskRow | undefined;
    if (!row || !this.visible(actor, row)) throw new Error("Task not visible");
    return this.dto(row);
  }
  events(
    actor: string,
    id: string,
    cursor?: string,
    limitInput = 50,
  ): {
    items: { id: number; at: number; event: unknown }[];
    cursor: string | null;
    coverage: { historicalComplete: boolean; completeAfterVersion: number };
  } {
    this.read(actor, id);
    const limit = z.number().int().min(1).max(100).parse(limitInput),
      signature = hash(encode({ actor, id, limit }));
    let before: undefined | number;
    if (cursor) {
      let parsed: Cursor;
      try {
        parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Cursor;
      } catch {
        throw new Error("Invalid task event cursor");
      }
      if (parsed.signature !== signature) throw new Error("Task event cursor query mismatch");
      before = Number(parsed.before);
      if (!Number.isSafeInteger(before)) throw new Error("Invalid task event cursor");
    }
    const rows = this.c.store.db
      .prepare(
        "SELECT id,at,body FROM task_events WHERE task_id=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?",
      )
      .all(id, before ?? null, before ?? null, limit + 1) as {
      id: number;
      at: number;
      body: string;
    }[];
    const baseline = this.c.store.db
      .prepare(
        "SELECT complete_after_version,historical_complete FROM task_event_baselines WHERE task_id=?",
      )
      .get(id) as { complete_after_version: number; historical_complete: number };
    return {
      items: rows
        .slice(0, limit)
        .map((row) => ({ id: row.id, at: row.at, event: JSON.parse(row.body) })),
      cursor: rows.length > limit ? this.encode(signature, String(rows[limit - 1]!.id)) : null,
      coverage: {
        historicalComplete: Boolean(baseline.historical_complete),
        completeAfterVersion: baseline.complete_after_version,
      },
    };
  }
  recovery(
    actor: string,
    limit = 20,
  ): {
    categories: Record<TaskRelation, { items: unknown[]; atLeast: number; cursor: string | null }>;
    coverage: { historicalComplete: boolean; legacyUnanchored: number };
  } {
    const categories = {} as Record<
      TaskRelation,
      { items: unknown[]; atLeast: number; cursor: string | null }
    >;
    let complete = true,
      legacy = 0;
    for (const relation of taskRelationSchema.options) {
      const page = this.list(actor, { relation, limit }),
        items = page.items.map((item) => ({
          id: item.id,
          workId: item.workId,
          owner: item.owner,
          assignedTo: item.assignedTo,
          status: item.status,
          version: item.version,
          title: item.title.slice(0, 100),
          waitingOn: item.waitingOn,
          legacy: item.legacy,
        }));
      categories[relation] = {
        items,
        atLeast: items.length + (page.cursor ? 1 : 0),
        cursor: page.cursor,
      };
      complete &&= page.coverage.historicalComplete;
      legacy += page.coverage.legacyUnanchored;
    }
    return { categories, coverage: { historicalComplete: complete, legacyUnanchored: legacy } };
  }
}
