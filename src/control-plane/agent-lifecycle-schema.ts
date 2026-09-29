/** One durable stop request per owner deactivation; node receipts use the same operation ID. */
export const agentLifecycleSchema = `
CREATE TABLE owner_agent_stop_intents (
  operation_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES owner_agents(id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  state TEXT NOT NULL CHECK(state IN ('executing','succeeded','failed','unknown')),
  receipt_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  node_receipt_revision INTEGER CHECK(node_receipt_revision IS NULL OR node_receipt_revision >= 1)
);
CREATE INDEX owner_agent_stop_intents_agent ON owner_agent_stop_intents(agent_id,created_at);
`;
