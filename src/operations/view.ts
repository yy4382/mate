import { z } from "zod";
import type Database from "better-sqlite3";
import type { TeamSettings } from "../domain/agents.js";
import type { AgentDirectory } from "../agents/directory.js";
import { encode, hash } from "../storage/store.js";
import { UsageLedger, type UsageSummary } from "../usage/ledger.js";

export const activitySourceSchema = z.enum([
  "task",
  "reminder_event",
  "reminder_firing",
  "run",
  "action",
  "output",
  "runtime",
  "internal_dm",
]);
export type ActivitySource = z.infer<typeof activitySourceSchema>;
const activityInputSchema = z
  .object({
    sources: z
      .array(activitySourceSchema)
      .min(1)
      .max(activitySourceSchema.options.length)
      .optional(),
    actorId: z.string().min(1).max(200).optional(),
    kinds: z.array(z.string().min(1).max(100)).max(30).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(20000).optional(),
  })
  .strict();

interface Position {
  at: number;
  id: string;
}
interface Cursor {
  signature: string;
  positions: Partial<Record<ActivitySource, Position>>;
}
export interface ActivityItem {
  at: number;
  source: ActivitySource;
  sourceId: string;
  kind: string;
  actorId: string | null;
  subject: { type: string; id: string };
  target: { type: string; id: string } | null;
  state: string | null;
  counts: Record<string, number>;
}
interface Row {
  at: number;
  source_id: string;
  kind: string;
  actor_id: string | null;
  subject_type: string;
  subject_id: string;
  target_type: string | null;
  target_id: string | null;
  state: string | null;
  counts: string;
}
interface Coverage {
  historicalComplete: boolean;
  availableSince: number | null;
  gapCount: number;
}
export interface OperationsPage<T> {
  items: T[];
  atLeast: number;
  truncated: boolean;
}
export interface OperationsStatus {
  at: number;
  agents: {
    id: string;
    registered: boolean;
    paused: boolean | null;
    generation: number | null;
    sessionId: string | null;
    activeRun: { id: string; createdAt: number; workId: string | null } | null;
    usage: UsageSummary;
  }[];
  works: OperationsPage<{ id: string; state: string }>;
  uncertainActions: OperationsPage<{ id: string; agentId: string; runId: string; state: string }>;
  uncertainOutputs: OperationsPage<{ id: string; agentId: string; state: string }>;
  heldDrafts: OperationsPage<{
    draftId: string;
    agentId: string;
    outputId: string;
    revision: number;
    state: string;
  }>;
  dueReminders: OperationsPage<{
    id: string;
    agentId: string;
    workId: string;
    taskId: string | null;
    nextAt: number;
    version: number;
    active: number;
    projection: string;
  }>;
}

/** Owner-only, platform-neutral projection over authoritative operational state. */
export class OperationsView {
  constructor(
    readonly c: { config: TeamSettings; agents: AgentDirectory; store: { db: Database.Database } },
  ) {}
  private owner(owner: string): void {
    if (!this.c.config.ownerUserIds.includes(owner)) throw new Error("Owner only");
  }
  status(owner: string): OperationsStatus {
    this.owner(owner);
    const s = this.c.store,
      now = Date.now(),
      cap = 100;
    type RuntimeRow = {
      id: string;
      session_id: string;
      paused: number;
      generation: number;
      run_id: string | null;
      run_created: number | null;
      work_id: string | null;
    };
    const runtime = new Map(
      (
        s.db
          .prepare(
            `SELECT a.id,a.session_id,a.paused,a.generation,r.id run_id,r.created_at run_created,rc.work_id
      FROM agents a LEFT JOIN runs r ON r.agent_id=a.id AND r.state='active' LEFT JOIN run_context rc ON rc.run_id=r.id`,
          )
          .all() as RuntimeRow[]
      ).map((row) => [row.id, row]),
    );
    const agents = this.c.config.agents.map((agent) => {
      const row = runtime.get(agent.id);
      return {
        id: agent.id,
        registered: Boolean(row),
        paused: row ? Boolean(row.paused) : null,
        generation: row?.generation ?? null,
        sessionId: row?.session_id ?? null,
        activeRun: row?.run_id
          ? { id: row.run_id, createdAt: row.run_created!, workId: row.work_id ?? null }
          : null,
        usage: UsageLedger.summaryFrom(s.db, agent.id),
      };
    });
    const page = <T>(sql: string, ...args: unknown[]): OperationsPage<T> => {
      const rows = s.db.prepare(sql).all(...args) as T[];
      return {
        items: rows.slice(0, cap),
        atLeast: rows.length > cap ? cap + 1 : rows.length,
        truncated: rows.length > cap,
      };
    };
    const works = page<OperationsStatus["works"]["items"][number]>(
      "SELECT id,state FROM works ORDER BY id DESC LIMIT ?",
      cap + 1,
    );
    const uncertainActions = page<OperationsStatus["uncertainActions"]["items"][number]>(
      "SELECT id,agent_id agentId,run_id runId,state FROM actions WHERE state IN ('executing','unknown') ORDER BY id DESC LIMIT ?",
      cap + 1,
    );
    const uncertainOutputs = page<OperationsStatus["uncertainOutputs"]["items"][number]>(
      "SELECT id,agent_id agentId,state FROM outbox WHERE state='unknown' ORDER BY id DESC LIMIT ?",
      cap + 1,
    );
    const heldDrafts = page<OperationsStatus["heldDrafts"]["items"][number]>(
      "SELECT d.id draftId,d.agent_id agentId,d.outbox_id outputId,d.revision,o.state FROM outbox o INDEXED BY output_held_status JOIN drafts d INDEXED BY draft_output_lookup ON d.outbox_id=o.id WHERE o.state='held' ORDER BY o.id DESC LIMIT ?",
      cap + 1,
    );
    const dueReminders = page<OperationsStatus["dueReminders"]["items"][number]>(
      `SELECT r.id,r.agent_id agentId,r.work_id workId,r.task_id taskId,r.next_at nextAt,r.version,r.active,r.projection
      FROM schedules r WHERE r.active=1 AND r.next_at<=? ORDER BY r.next_at,r.id LIMIT ?`,
      now,
      cap + 1,
    );
    return { at: now, agents, works, uncertainActions, uncertainOutputs, heldDrafts, dueReminders };
  }
  activity(
    owner: string,
    input: unknown = {},
  ): {
    items: ActivityItem[];
    cursor: string | null;
    sources: Record<string, { position: Position | null; hasMore: boolean; coverage: Coverage }>;
  } {
    this.owner(owner);
    const parsed = activityInputSchema.parse(input),
      sources = [...new Set(parsed.sources ?? activitySourceSchema.options)],
      limit = parsed.limit ?? 50;
    if (parsed.actorId) this.c.agents.get(parsed.actorId);
    const bound = {
        owner,
        sources: [...sources].sort(),
        actorId: parsed.actorId ?? null,
        kinds: [...(parsed.kinds ?? [])].sort(),
        limit,
      },
      signature = hash(encode(bound));
    let positions: Cursor["positions"] = {};
    if (parsed.cursor) {
      let cursor: Cursor;
      try {
        cursor = JSON.parse(Buffer.from(parsed.cursor, "base64url").toString("utf8")) as Cursor;
      } catch {
        throw new Error("Invalid activity cursor");
      }
      if (
        cursor.signature !== signature ||
        typeof cursor.positions !== "object" ||
        cursor.positions === null
      )
        throw new Error("Activity cursor query mismatch");
      for (const [source, position] of Object.entries(cursor.positions)) {
        if (
          !activitySourceSchema.safeParse(source).success ||
          !position ||
          typeof position !== "object" ||
          !Number.isSafeInteger((position as Position).at) ||
          typeof (position as Position).id !== "string" ||
          !(position as Position).id
        )
          throw new Error("Invalid activity cursor");
      }
      positions = cursor.positions;
    }
    const fetched = new Map<ActivitySource, ActivityItem[]>();
    for (const source of sources)
      fetched.set(
        source,
        this.fetch(source, positions[source], limit + 1, parsed.actorId, parsed.kinds),
      );
    const candidates = [...fetched.values()].flat().sort(compareActivity),
      items = candidates.slice(0, limit),
      nextPositions = { ...positions };
    for (const source of sources) {
      const emitted = items.filter((item) => item.source === source);
      if (emitted.length) {
        const last = emitted.at(-1)!;
        nextPositions[source] = { at: last.at, id: last.sourceId };
      }
    }
    const sourceState = {} as Record<
      string,
      { position: Position | null; hasMore: boolean; coverage: Coverage }
    >;
    let more = false;
    for (const source of sources) {
      const rows = fetched.get(source)!,
        emitted = items.filter((item) => item.source === source).length,
        hasMore = rows.length > emitted;
      more ||= hasMore;
      sourceState[source] = {
        position: nextPositions[source] ?? null,
        hasMore,
        coverage: this.coverage(source),
      };
    }
    return {
      items,
      cursor: more
        ? Buffer.from(encode({ signature, positions: nextPositions } satisfies Cursor)).toString(
            "base64url",
          )
        : null,
      sources: sourceState,
    };
  }
  private fetch(
    source: ActivitySource,
    before: Position | undefined,
    limit: number,
    actor: string | undefined,
    kinds: string[] | undefined,
  ): ActivityItem[] {
    const s = this.c.store,
      params: unknown[] = [];
    let sql = "",
      idNumeric = false;
    const fixedKind: { [K in ActivitySource]?: string } = {
      reminder_firing: "reminder.firing",
      run: "run.status",
      action: "action.status",
      output: "output.status",
    };
    if (kinds?.length && fixedKind[source] && !kinds.includes(fixedKind[source]!)) return [];
    let sourceKinds = kinds;
    if (
      kinds?.length &&
      (source === "reminder_event" || source === "runtime" || source === "internal_dm")
    ) {
      const prefix = source === "reminder_event" ? "reminder." : `${source}.`;
      sourceKinds = kinds
        .filter((kind) => kind.startsWith(prefix))
        .map((kind) => kind.slice(prefix.length));
      if (!sourceKinds.length) return [];
    }
    const where = (at: string, id: string, actorColumn: string, kind: string) => {
      const clauses: string[] = [];
      if (before) {
        clauses.push(`(${at}<? OR (${at}=? AND ${id}<?))`);
        params.push(before.at, before.at, idNumeric ? Number(before.id) : before.id);
      }
      if (actor) {
        clauses.push(`${actorColumn}=?`);
        params.push(actor);
      }
      if (sourceKinds?.length) {
        clauses.push(`${kind} IN (${sourceKinds.map(() => "?").join(",")})`);
        params.push(...sourceKinds);
      }
      return clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    };
    switch (source) {
      case "task":
        idNumeric = true;
        sql = `SELECT e.at,e.id source_id,'task.'||json_extract(e.body,'$.action') kind,COALESCE(json_extract(e.body,'$.actor'),json_extract(e.body,'$.agentId')) actor_id,'task' subject_type,e.task_id subject_id,'work' target_type,t.work_id target_id,json_extract(e.body,'$.to.status') state,'{}' counts FROM task_events e JOIN tasks t ON t.id=e.task_id${where("e.at", "e.id", "COALESCE(json_extract(e.body,'$.actor'),json_extract(e.body,'$.agentId'))", "'task.'||json_extract(e.body,'$.action')")} ORDER BY e.at DESC,e.id DESC LIMIT ?`;
        break;
      case "reminder_event":
        idNumeric = true;
        sql = `SELECT e.at,e.seq source_id,'reminder.'||e.kind kind,e.actor_id,'reminder' subject_type,e.reminder_id subject_id,'work' target_type,r.work_id target_id,CASE WHEN r.active=1 THEN 'active' ELSE 'inactive' END state,'{}' counts FROM reminder_events e JOIN schedules r ON r.id=e.reminder_id${where("e.at", "e.seq", "e.actor_id", "e.kind")} ORDER BY e.at DESC,e.seq DESC LIMIT ?`;
        break;
      case "reminder_firing":
        sql = `SELECT f.due_at at,f.id source_id,'reminder.firing' kind,f.actor_id,'reminder' subject_type,f.reminder_id subject_id,'work' target_type,r.work_id target_id,COALESCE(f.result_status,d.status) state,json_object('version',f.version) counts FROM reminder_firings f JOIN schedules r ON r.id=f.reminder_id JOIN deliveries d ON d.id=f.delivery_id${where("f.due_at", "f.id", "f.actor_id", "'reminder.firing'")} ORDER BY f.due_at DESC,f.id DESC LIMIT ?`;
        break;
      case "run":
        sql = `SELECT r.created_at at,r.id source_id,'run.status' kind,r.agent_id actor_id,'run' subject_type,r.id subject_id,CASE WHEN rc.work_id IS NULL THEN NULL ELSE 'work' END target_type,rc.work_id target_id,r.state state,'{}' counts FROM runs r LEFT JOIN run_context rc ON rc.run_id=r.id${where("r.created_at", "r.id", "r.agent_id", "'run.status'")} ORDER BY r.created_at DESC,r.id DESC LIMIT ?`;
        break;
      case "action":
        sql = `SELECT a.created_at at,a.id source_id,'action.status' kind,a.agent_id actor_id,'action' subject_type,a.id subject_id,'run' target_type,a.run_id target_id,a.state state,'{}' counts FROM actions a${where("a.created_at", "a.id", "a.agent_id", "'action.status'")}${before || actor || kinds?.length ? " AND" : " WHERE"} a.created_at IS NOT NULL ORDER BY a.created_at DESC,a.id DESC LIMIT ?`;
        break;
      case "output":
        sql = `SELECT o.created_at at,o.id source_id,'output.status' kind,o.agent_id actor_id,'output' subject_type,o.id subject_id,CASE WHEN ow.work_id IS NULL THEN NULL ELSE 'work' END target_type,ow.work_id target_id,o.state state,'{}' counts FROM outbox o LEFT JOIN output_work ow ON ow.output_id=o.id${where("o.created_at", "o.id", "o.agent_id", "'output.status'")}${before || actor || kinds?.length ? " AND" : " WHERE"} o.created_at IS NOT NULL ORDER BY o.created_at DESC,o.id DESC LIMIT ?`;
        break;
      case "runtime":
      case "internal_dm":
        idNumeric = true;
        sql = `SELECT f.at,f.seq source_id,f.source||'.'||f.kind kind,f.actor_id,f.subject_type,f.subject_id,f.target_type,f.target_id,NULL state,f.counts FROM operational_facts f${where("f.at", "f.seq", "f.actor_id", "f.kind")}${before || actor || sourceKinds?.length ? " AND" : " WHERE"} f.source=? ORDER BY f.at DESC,f.seq DESC LIMIT ?`;
        params.push(source);
        break;
    }
    params.push(limit);
    return (s.db.prepare(sql).all(...params) as Row[]).map((row) => ({
      at: row.at,
      source,
      sourceId: String(row.source_id),
      kind: row.kind,
      actorId: row.actor_id,
      subject: { type: row.subject_type, id: row.subject_id },
      target:
        row.target_type && row.target_id ? { type: row.target_type, id: row.target_id } : null,
      state: row.state,
      counts: JSON.parse(row.counts),
    }));
  }
  private coverage(source: ActivitySource): Coverage {
    const s = this.c.store,
      mark =
        Number(
          (
            s.db
              .prepare("SELECT value FROM runtime_meta WHERE key='operations_view_since'")
              .get() as { value: string } | undefined
          )?.value ?? 0,
        ) || null;
    switch (source) {
      case "task": {
        const { n } = s.db
          .prepare("SELECT COUNT(*) n FROM task_event_baselines WHERE historical_complete=0")
          .get() as { n: number };
        return { historicalComplete: n === 0, availableSince: null, gapCount: n };
      }
      case "reminder_event":
      case "reminder_firing": {
        const { n } = s.db
          .prepare("SELECT COUNT(*) n FROM reminder_event_baselines WHERE historical_complete=0")
          .get() as { n: number };
        return { historicalComplete: n === 0, availableSince: null, gapCount: n };
      }
      case "action": {
        const { n } = s.db
          .prepare("SELECT COUNT(*) n FROM actions WHERE created_at IS NULL")
          .get() as { n: number };
        return { historicalComplete: n === 0, availableSince: mark, gapCount: n };
      }
      case "output": {
        const { n } = s.db
          .prepare("SELECT COUNT(*) n FROM outbox WHERE created_at IS NULL")
          .get() as { n: number };
        return { historicalComplete: n === 0, availableSince: mark, gapCount: n };
      }
      case "runtime":
      case "internal_dm":
        return { historicalComplete: false, availableSince: mark, gapCount: 0 };
      case "run":
        return { historicalComplete: true, availableSince: null, gapCount: 0 };
    }
  }
}

function compareActivity(a: ActivityItem, b: ActivityItem): number {
  const time = b.at - a.at;
  if (time) return time;
  const source = a.source === b.source ? 0 : a.source < b.source ? 1 : -1;
  if (source) return source;
  // The stable sort preserves each source query's native SQLite id order and collation.
  return 0;
}
