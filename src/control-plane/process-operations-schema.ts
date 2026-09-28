/** Control-plane intent records for ordinary Agent commands and process controls. */
export const agentProcessOperationsSchemaV13 = `
CREATE TABLE owner_agent_process_operations (
  operation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES owner_agent_runs(id),
  agent_id TEXT NOT NULL REFERENCES owner_agents(id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  action_scope_id TEXT NOT NULL,
  stable_action_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  request_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('executing','succeeded','failed','unknown')),
  receipt_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  node_receipt_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(node_receipt_confirmed IN (0,1)),
  node_receipt_revision INTEGER CHECK(node_receipt_revision IS NULL OR node_receipt_revision >= 1)
);
CREATE INDEX owner_agent_process_operations_agent
  ON owner_agent_process_operations(agent_id,created_at);
CREATE INDEX owner_agent_process_operations_run
  ON owner_agent_process_operations(run_id,created_at);
`;
