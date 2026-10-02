import { receiptCorrectionMessage } from "../../prompts/index.js";
import { sessionCheckpointSchema } from "./record.js";
import { type ModelContextMessage, type SessionCheckpoint, type SessionCommit } from "./record.js";
import { durableToolIdentity } from "../tools/identity.js";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/** SQLite owns the immutable model history; deliveries and operation receipts keep their own facts. */
export class AgentSession {
  constructor(private readonly db: Database.Database) {}

  append(runId: string, nodeId: string, agentId: string, entry: SessionCommit): boolean {
    return this.db
      .transaction(() => {
        const run = this.db
          .prepare<unknown[], { delivery_id: string }>(
            `SELECT delivery_id FROM owner_agent_runs
        WHERE id=? AND node_id=? AND agent_id=? AND state='running'`,
          )
          .get(runId, nodeId, agentId);
        if (!run) return false;
        const payload = JSON.stringify(entry);
        const old = this.db
          .prepare<unknown[], { agent_id: string; payload_json: string }>(
            "SELECT agent_id,payload_json FROM owner_agent_session_records WHERE id=?",
          )
          .get(entry.id);
        if (old) return old.agent_id === agentId && old.payload_json === payload;
        if (entry.kind === "compaction") {
          const bounds = this.db
            .prepare<
              unknown[],
              {
                id: string;
                seq: number;
              }
            >(
              `SELECT id,seq FROM owner_agent_session_records WHERE agent_id=? AND kind='message'
             AND id IN (?,?)`,
            )
            .all(agentId, entry.firstKeptEntryId, entry.throughEntryId);
          const first = bounds.find((row) => row.id === entry.firstKeptEntryId);
          const through = bounds.find((row) => row.id === entry.throughEntryId);
          const latest = this.db
            .prepare<unknown[], { seq: number }>(
              "SELECT seq FROM owner_agent_session_records WHERE agent_id=? AND kind='message' ORDER BY seq DESC LIMIT 1",
            )
            .get(agentId);
          const prior = this.latestCheckpoint(agentId);
          const priorFirst =
            prior &&
            this.db
              .prepare<unknown[], { seq: number }>(
                "SELECT seq FROM owner_agent_session_records WHERE agent_id=? AND id=?",
              )
              .get(agentId, prior.firstKeptEntryId);
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
  queueCorrection(agentId: string, result: unknown, timestamp: number): boolean {
    // The immutable transcript retains this identity even after the pending update is consumed
    // or compacted. Time is presentation metadata, never part of a recovery fact's identity.
    const canonical = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonical);
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, canonical(child)]),
      );
    };
    const fact = JSON.stringify(canonical(result));
    const hex = createHash("sha256")
      .update(agentId + "\0" + fact)
      .digest("hex");
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO owner_agent_session_updates(id,agent_id,message_json)
      SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM owner_agent_session_records WHERE id=?)`,
        )
        .run(id, agentId, JSON.stringify(receiptCorrectionMessage(fact, timestamp)), id).changes > 0
    );
  }

  pendingCorrections(agentId: string, actionScopeId: string): ModelContextMessage[] {
    const rows = this.db
      .prepare<unknown[], { id: string; message_json: string }>(
        "SELECT id,message_json FROM owner_agent_session_updates WHERE agent_id=? ORDER BY rowid",
      )
      .all(agentId);
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
      .prepare<unknown[], { id: string; payload_json: string; action_scope_id: string }>(
        `SELECT id,payload_json,action_scope_id FROM owner_agent_session_records
      WHERE agent_id=? AND kind='message' ORDER BY seq`,
      )
      .all(agentId);
    return rows.map((row) => ({
      id: row.id,
      message: JSON.parse(row.payload_json).message,
      actionScopeId: row.action_scope_id,
      ...(row.id === checkpoint?.firstKeptEntryId ? { checkpoint } : {}),
    }));
  }

  /** Read only the retained projection; original transcript remains immutable and available. */
  context(agentId: string): ModelContextMessage[] {
    const checkpoint = this.latestCheckpoint(agentId);
    if (!checkpoint) return this.read(agentId);
    const rows = this.db
      .prepare<
        unknown[],
        {
          id: string;
          payload_json: string;
          action_scope_id: string;
        }
      >(
        `SELECT id,payload_json,action_scope_id FROM owner_agent_session_records
      WHERE agent_id=? AND kind='message' AND seq >= (SELECT seq FROM owner_agent_session_records WHERE id=?) ORDER BY seq`,
      )
      .all(agentId, checkpoint.firstKeptEntryId);
    return rows.map((row) => ({
      id: row.id,
      message: JSON.parse(row.payload_json).message,
      actionScopeId: row.action_scope_id,
      ...(row.id === checkpoint.firstKeptEntryId ? { checkpoint } : {}),
    }));
  }

  private latestCheckpoint(agentId: string): SessionCheckpoint | undefined {
    const row = this.db
      .prepare<unknown[], { payload_json: string }>(
        "SELECT payload_json FROM owner_agent_session_records WHERE agent_id=? AND kind='compaction' ORDER BY seq DESC LIMIT 1",
      )
      .get(agentId);
    return row ? sessionCheckpointSchema.parse(JSON.parse(row.payload_json)) : undefined;
  }
}
