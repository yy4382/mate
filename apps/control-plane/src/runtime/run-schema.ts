/** Run authorization, input bounds and durable business action receipts. */
export const agentRunSchema = `
CREATE TABLE owner_agent_direct_channels (
  agent_id TEXT PRIMARY KEY REFERENCES owner_agents(id),
  channel_id TEXT NOT NULL UNIQUE REFERENCES owner_channels(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE owner_agent_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES owner_agents(id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  delivery_id TEXT NOT NULL REFERENCES owner_message_deliveries(id),
  input_end_seq INTEGER NOT NULL DEFAULT 0,
  context_history_end_seq INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK(state IN ('running','completed','failed')),
  error_code TEXT,
  retry_at INTEGER,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE UNIQUE INDEX owner_agent_runs_one_active
  ON owner_agent_runs(agent_id) WHERE state='running';
CREATE INDEX owner_agent_runs_retry
  ON owner_agent_runs(state,retry_at,started_at);
CREATE INDEX owner_agent_runs_delivery
  ON owner_agent_runs(delivery_id,started_at);
CREATE TABLE owner_agent_tool_actions (
  session_id TEXT NOT NULL REFERENCES owner_agent_sessions(id),
  action_id TEXT NOT NULL CHECK(length(action_id) BETWEEN 1 AND 500),
  agent_id TEXT NOT NULL REFERENCES owner_agents(id),
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(session_id,action_id)
);
CREATE INDEX owner_agent_tool_actions_agent ON owner_agent_tool_actions(agent_id,created_at);
CREATE TABLE owner_agent_peer_direct_channels (
  channel_id TEXT PRIMARY KEY REFERENCES owner_channels(id),
  first_agent_id TEXT NOT NULL REFERENCES owner_agents(id),
  second_agent_id TEXT NOT NULL REFERENCES owner_agents(id),
  created_at INTEGER NOT NULL,
  CHECK(first_agent_id < second_agent_id),
  UNIQUE(first_agent_id,second_agent_id)
);
CREATE INDEX owner_agent_peer_direct_channels_second
  ON owner_agent_peer_direct_channels(second_agent_id,first_agent_id);
`;
