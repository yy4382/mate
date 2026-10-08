import type Database from "better-sqlite3";

export interface AgentActivityEvent {
  sequence: number;
  kind: string;
  referenceId: string | null;
  summary: string;
  detail?: unknown;
  at: number;
}

/** The safe summary is stored separately from owner-only operation detail. */
export function recordAgentActivity(
  db: Database.Database,
  event: {
    agentId?: string;
    nodeId?: string;
    kind: string;
    referenceId?: string;
    summary: string;
    detail?: unknown;
    at: number;
  },
): void {
  db.prepare(
    `INSERT INTO owner_agent_activity(agent_id,node_id,kind,reference_id,summary,detail_json,created_at)
     VALUES(?,?,?,?,?,?,?)`,
  ).run(
    event.agentId ?? null,
    event.nodeId ?? null,
    event.kind,
    event.referenceId ?? null,
    event.summary,
    event.detail === undefined ? null : JSON.stringify(event.detail),
    event.at,
  );
}

export function listAgentActivity(
  db: Database.Database,
  agentId: string,
  before: number | null,
  limit: number,
  expanded: boolean,
): AgentActivityEvent[] | undefined {
  const agent = db
    .prepare<unknown[], { node_id: string }>("SELECT node_id FROM owner_agents WHERE id=?")
    .get(agentId);
  if (!agent) return undefined;
  const rows = db
    .prepare<
      unknown[],
      {
        seq: number;
        kind: string;
        reference_id: string | null;
        summary: string;
        detail_json: string | null;
        created_at: number;
      }
    >(
      `SELECT seq,kind,reference_id,summary,detail_json,created_at FROM owner_agent_activity
     WHERE (agent_id=? OR (agent_id IS NULL AND node_id=?)) AND seq<?
     ORDER BY seq DESC LIMIT ?`,
    )
    .all(agentId, agent.node_id, before ?? Number.MAX_SAFE_INTEGER, limit);
  return rows.map((row) => ({
    sequence: row.seq,
    kind: row.kind,
    referenceId: row.reference_id,
    summary: row.summary,
    at: row.created_at,
    ...(expanded && row.detail_json !== null ? { detail: JSON.parse(row.detail_json) } : {}),
  }));
}
