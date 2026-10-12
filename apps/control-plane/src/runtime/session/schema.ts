export const agentSessionSchema = `
CREATE TABLE owner_durable_session_bindings (
  agent_id TEXT PRIMARY KEY REFERENCES owner_agents(id)
);

CREATE TABLE owner_durable_tool_calls (
  agent_id TEXT NOT NULL REFERENCES owner_agents(id),
  task_id TEXT NOT NULL,
  identity TEXT NOT NULL UNIQUE,
  action_scope_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  input_json TEXT NOT NULL,
  PRIMARY KEY(agent_id,task_id)
);

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
