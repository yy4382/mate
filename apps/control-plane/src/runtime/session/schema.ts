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

-- Only the cross-store input acknowledgment: no message or native checkpoint copy.
CREATE TABLE owner_durable_input_bindings (
  delivery_id TEXT PRIMARY KEY REFERENCES owner_message_deliveries(id),
  run_id TEXT NOT NULL REFERENCES owner_agent_runs(id),
  submission_id INTEGER NOT NULL
);
CREATE TABLE owner_agent_session_updates (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES owner_agents(id),
  message_json TEXT NOT NULL
);
`;
