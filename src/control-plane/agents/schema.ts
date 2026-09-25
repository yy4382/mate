export const agentDirectorySchema = `
CREATE TABLE owner_agents (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  initial_channel_id TEXT REFERENCES owner_channels(id),
  request_json TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
  provision_request_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('provisioning','waiting_credentials','failed')),
  stage TEXT NOT NULL CHECK(stage IN ('queued','checking_account','creating_account','preparing_home','verifying_identity','complete','failed')),
  error TEXT,
  linux_username TEXT,
  uid INTEGER,
  gid INTEGER,
  home TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX owner_agents_status ON owner_agents(status,updated_at,id);
CREATE TABLE owner_agent_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL UNIQUE REFERENCES owner_agents(id),
  created_at INTEGER NOT NULL,
  verified_at INTEGER
);
`;
