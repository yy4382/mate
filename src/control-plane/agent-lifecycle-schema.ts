/** One durable stop request per owner deactivation; node receipts use the same operation ID. */
export const agentLifecycleSchemaV19 = `
ALTER TABLE owner_agents ADD COLUMN home_marker TEXT;
ALTER TABLE owner_agent_process_operations ADD COLUMN node_receipt_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(node_receipt_confirmed IN (0,1));
CREATE TABLE owner_agent_stop_intents (
  operation_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES owner_agents(id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  state TEXT NOT NULL CHECK(state IN ('executing','succeeded','failed','unknown')),
  receipt_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX owner_agent_stop_intents_agent ON owner_agent_stop_intents(agent_id,created_at);
`;
