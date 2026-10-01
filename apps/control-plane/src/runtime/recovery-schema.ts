/** Agent activity and scheduling controls are independent from model history. */
export const recoverySchema = `
CREATE TABLE owner_agent_activity (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT REFERENCES owner_agents(id),
  node_id TEXT REFERENCES nodes(id),
  kind TEXT NOT NULL,
  reference_id TEXT,
  summary TEXT NOT NULL,
  detail_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX owner_agent_activity_agent ON owner_agent_activity(agent_id,seq);
CREATE INDEX owner_agent_activity_node ON owner_agent_activity(node_id,seq);
CREATE TABLE owner_agent_run_control (
  agent_id TEXT PRIMARY KEY REFERENCES owner_agents(id),
  paused_reason TEXT CHECK(paused_reason IN ('manual','credentials','context')),
  temporary_failures INTEGER NOT NULL DEFAULT 0 CHECK(temporary_failures>=0),
  updated_at INTEGER NOT NULL
);
`;
