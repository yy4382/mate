import { receiptCorrectionMessage } from "../../prompts/index.js";
import { type ModelContextMessage } from "./input.js";
import { durableToolIdentity } from "../tools/identity.js";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/** SQLite owns the immutable model history; deliveries and operation receipts keep their own facts. */
export class AgentSession {
  constructor(private readonly db: Database.Database) {}

  /** Binds the upstream committed tool task to the existing business effect identity. */
  bindTool(
    agentId: string,
    sessionId: string,
    actionScopeId: string,
    taskId: string,
    operation: string,
    input: Record<string, unknown>,
  ): string {
    const identity = durableToolIdentity(actionScopeId, sessionId, taskId);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO owner_durable_tool_calls
      (agent_id,task_id,identity,action_scope_id,operation,input_json) VALUES(?,?,?,?,?,?)`,
      )
      .run(agentId, taskId, identity, actionScopeId, operation, JSON.stringify(input));
    const row = this.db
      .prepare<unknown[], { identity: string; operation: string; input_json: string }>(
        "SELECT identity,operation,input_json FROM owner_durable_tool_calls WHERE agent_id=? AND task_id=?",
      )
      .get(agentId, taskId);
    if (!row || row.operation !== operation || row.input_json !== JSON.stringify(input))
      throw new Error("Durable tool task binding differs");
    return row.identity;
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
      VALUES(?,?,?)`,
        )
        .run(id, agentId, JSON.stringify(receiptCorrectionMessage(fact, timestamp))).changes > 0
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
      recoveryFact: true,
    }));
  }

  /** Read the committed Durable tool task binding independently of the new run's delivery. */
  toolAction(
    agentId: string,
    identity: string,
  ): { actionScopeId: string; name: string; input: unknown } | undefined {
    const durable = this.db
      .prepare<unknown[], { action_scope_id: string; operation: string; input_json: string }>(
        "SELECT action_scope_id,operation,input_json FROM owner_durable_tool_calls WHERE agent_id=? AND identity=?",
      )
      .get(agentId, identity);
    if (durable)
      return {
        actionScopeId: durable.action_scope_id,
        name: durable.operation,
        input: JSON.parse(durable.input_json),
      };
    return undefined;
  }
}
