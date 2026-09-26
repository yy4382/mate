/** Link durable operation results to the Agent's one recoverable session. */
export const recoverySchemaV16 = `
ALTER TABLE owner_agent_session_journal ADD COLUMN process_operation_id TEXT;
ALTER TABLE owner_agent_sessions ADD COLUMN model_session_id TEXT;
UPDATE owner_agent_sessions SET model_session_id=id;
CREATE TABLE owner_agent_session_snapshots (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES owner_agents(id),
  action_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  through_seq INTEGER NOT NULL,
  model_session_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(agent_id,action_id)
);
CREATE INDEX owner_agent_session_snapshots_latest ON owner_agent_session_snapshots(agent_id,through_seq,created_at);
CREATE UNIQUE INDEX owner_agent_session_process_result_once
  ON owner_agent_session_journal(session_id,tool_action_id)
  WHERE process_operation_id IS NOT NULL;
CREATE INDEX owner_agent_session_process_result
  ON owner_agent_session_journal(process_operation_id,seq);
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
  paused_reason TEXT CHECK(paused_reason IN ('manual','credentials')),
  temporary_failures INTEGER NOT NULL DEFAULT 0 CHECK(temporary_failures>=0),
  updated_at INTEGER NOT NULL
);
`;
