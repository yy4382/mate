import { durableToolIdentity } from "../nodes/session-record.js";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ModelContextMessage,
  SessionCheckpoint,
  SessionCommit,
} from "../nodes/session-record.js";

export const agentSessionSchema = `
CREATE TABLE owner_agent_session_records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL REFERENCES owner_agents(id),
  run_id TEXT NOT NULL REFERENCES owner_agent_runs(id),
  action_scope_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('message','configuration','compaction','summary_usage')),
  payload_json TEXT NOT NULL,
  -- Rebuildable compact projection of the immutable payload, never a second usage authority.
  usage_json TEXT GENERATED ALWAYS AS (
    CASE WHEN kind='summary_usage' OR
      (kind='message' AND json_extract(payload_json,'$.modelRequest')=1)
    THEN json_object('reportedUsage',json(json_extract(payload_json,'$.reportedUsage')))
    ELSE NULL END
  ) STORED,
  created_at INTEGER NOT NULL
);
CREATE INDEX owner_agent_session_records_agent ON owner_agent_session_records(agent_id,seq);
CREATE INDEX owner_agent_session_records_usage ON owner_agent_session_records(agent_id,seq) WHERE usage_json IS NOT NULL;
CREATE TABLE owner_agent_session_updates (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES owner_agents(id),
  message_json TEXT NOT NULL
);
`;

/** SQLite owns the immutable model history; deliveries and operation receipts keep their own facts. */
export class AgentSession {
  constructor(private readonly db: Database.Database) {}

  append(runId: string, nodeId: string, agentId: string, entry: SessionCommit): boolean {
    return this.db
      .transaction(() => {
        const run = this.db
          .prepare(
            `SELECT delivery_id FROM owner_agent_runs
        WHERE id=? AND node_id=? AND agent_id=? AND state='running'`,
          )
          .get(runId, nodeId, agentId) as { delivery_id: string } | undefined;
        if (!run) return false;
        const payload = JSON.stringify(entry);
        const old = this.db
          .prepare("SELECT agent_id,payload_json FROM owner_agent_session_records WHERE id=?")
          .get(entry.id) as { agent_id: string; payload_json: string } | undefined;
        if (old) return old.agent_id === agentId && old.payload_json === payload;
        if (entry.kind === "compaction") {
          const bounds = this.db
            .prepare(
              `SELECT id,seq FROM owner_agent_session_records WHERE agent_id=? AND kind='message'
             AND id IN (?,?)`,
            )
            .all(agentId, entry.firstKeptEntryId, entry.throughEntryId) as Array<{
            id: string;
            seq: number;
          }>;
          const first = bounds.find((row) => row.id === entry.firstKeptEntryId);
          const through = bounds.find((row) => row.id === entry.throughEntryId);
          const latest = this.db
            .prepare(
              "SELECT seq FROM owner_agent_session_records WHERE agent_id=? AND kind='message' ORDER BY seq DESC LIMIT 1",
            )
            .get(agentId) as { seq: number } | undefined;
          const prior = this.latestCheckpoint(agentId);
          const priorFirst =
            prior &&
            (this.db
              .prepare("SELECT seq FROM owner_agent_session_records WHERE agent_id=? AND id=?")
              .get(agentId, prior.firstKeptEntryId) as { seq: number } | undefined);
          if (
            !first ||
            !through ||
            !latest ||
            first.seq > through.seq ||
            through.seq !== latest.seq ||
            (priorFirst && first.seq <= priorFirst.seq)
          )
            return false;
        }
        this.db
          .prepare(
            `INSERT INTO owner_agent_session_records(id,agent_id,run_id,action_scope_id,kind,payload_json,created_at)
        VALUES(?,?,?,?,?,?,?)`,
          )
          .run(entry.id, agentId, runId, run.delivery_id, entry.kind, payload, Date.now());
        this.db
          .prepare("DELETE FROM owner_agent_session_updates WHERE id=? AND agent_id=?")
          .run(entry.id, agentId);
        return true;
      })
      .immediate();
  }

  /** A restored receipt is pending information until a model actually consumes it. */
  queueCorrection(agentId: string, result: unknown, timestamp: number): void {
    this.db
      .prepare("INSERT INTO owner_agent_session_updates(id,agent_id,message_json) VALUES(?,?,?)")
      .run(
        randomUUID(),
        agentId,
        JSON.stringify({
          role: "user",
          content: `Mate 收据更正：${JSON.stringify(result)}`,
          timestamp,
        }),
      );
  }

  pendingCorrections(agentId: string, actionScopeId: string): ModelContextMessage[] {
    const rows = this.db
      .prepare(
        "SELECT id,message_json FROM owner_agent_session_updates WHERE agent_id=? ORDER BY rowid",
      )
      .all(agentId) as Array<{ id: string; message_json: string }>;
    return rows.map((row) => ({
      id: row.id,
      message: JSON.parse(row.message_json),
      actionScopeId,
      pending: true,
    }));
  }

  /** Prove a resumed call's identity from the immutable assistant observation, independently of the new run's delivery. */
  toolAction(
    agentId: string,
    identity: string,
  ): { actionScopeId: string; name: string; input: unknown } | undefined {
    for (const entry of this.read(agentId)) {
      if (entry.message.role !== "assistant") continue;
      for (const call of entry.message.content) {
        if (
          call.type === "toolCall" &&
          durableToolIdentity(entry.actionScopeId, entry.id, call.id) === identity
        )
          return { actionScopeId: entry.actionScopeId, name: call.name, input: call.arguments };
      }
    }
    return undefined;
  }

  read(agentId: string): ModelContextMessage[] {
    const checkpoint = this.latestCheckpoint(agentId);
    const rows = this.db
      .prepare(
        `SELECT id,payload_json,action_scope_id FROM owner_agent_session_records
      WHERE agent_id=? AND kind='message' ORDER BY seq`,
      )
      .all(agentId) as Array<{ id: string; payload_json: string; action_scope_id: string }>;
    return rows.map((row) => ({
      id: row.id,
      message: JSON.parse(row.payload_json).message,
      actionScopeId: row.action_scope_id,
      ...(row.id === checkpoint?.firstKeptEntryId ? { checkpoint } : {}),
    }));
  }

  private latestCheckpoint(agentId: string): SessionCheckpoint | undefined {
    const row = this.db
      .prepare(
        "SELECT payload_json FROM owner_agent_session_records WHERE agent_id=? AND kind='compaction' ORDER BY seq DESC LIMIT 1",
      )
      .get(agentId) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as SessionCheckpoint) : undefined;
  }
}
