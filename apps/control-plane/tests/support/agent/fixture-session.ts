import type Database from "better-sqlite3";
import { AgentSession } from "../../../src/runtime/session/service.js";
import {
  type ModelContextMessage,
  type SessionCommit,
} from "../../../src/runtime/session/record.js";
import type { AgentToolIdentity } from "../../../src/runtime/tools/entry.js";
interface SessionMessageRow {
  id: string;
  payload_json: string;
  action_scope_id: string;
}
/** Transitional synthetic domain-tool fixture; never used by the control plane runtime. */
export class FixtureSession extends AgentSession {
  constructor(private readonly database: Database.Database) {
    super(database);
  }
  append(
    { runId, nodeId, agentId }: Pick<AgentToolIdentity, "runId" | "nodeId" | "agentId">,
    entry: SessionCommit,
  ): boolean {
    return this.database
      .transaction(() => {
        const run = this.database
          .prepare<unknown[], { delivery_id: string }>(
            `SELECT delivery_id FROM owner_agent_runs
        WHERE id=? AND node_id=? AND agent_id=? AND state='running'`,
          )
          .get(runId, nodeId, agentId);
        if (!run) return false;
        const payload = JSON.stringify(entry);
        const old = this.database
          .prepare<unknown[], { agent_id: string; payload_json: string }>(
            "SELECT agent_id,payload_json FROM owner_agent_session_records WHERE id=?",
          )
          .get(entry.id);
        if (old) return old.agent_id === agentId && old.payload_json === payload;
        this.database
          .prepare(
            `INSERT INTO owner_agent_session_records(id,agent_id,run_id,action_scope_id,kind,payload_json,created_at)
        VALUES(?,?,?,?,?,?,?)`,
          )
          .run(entry.id, agentId, runId, run.delivery_id, entry.kind, payload, Date.now());
        this.database
          .prepare("DELETE FROM owner_agent_session_updates WHERE id=? AND agent_id=?")
          .run(entry.id, agentId);
        return true;
      })
      .immediate();
  }

  override pendingCorrections(agentId: string, actionScopeId: string) {
    return super
      .pendingCorrections(agentId, actionScopeId)
      .filter(
        (entry) =>
          !this.database
            .prepare("SELECT 1 FROM owner_agent_session_records WHERE id=?")
            .get(entry.id),
      );
  }
  read(agentId: string): ModelContextMessage[] {
    return this.database
      .prepare<unknown[], SessionMessageRow>(
        "SELECT id,payload_json,action_scope_id FROM owner_agent_session_records WHERE agent_id=? AND kind='message' ORDER BY seq",
      )
      .all(agentId)
      .map((row) => ({
        id: row.id,
        message: JSON.parse(row.payload_json).message,
        actionScopeId: row.action_scope_id,
      }));
  }
  context(agentId: string) {
    return this.read(agentId);
  }
}
