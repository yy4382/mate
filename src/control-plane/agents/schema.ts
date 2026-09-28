/**
 * The Agent directory and its logical session as the single-account release uses them. Preparation
 * happens in a workspace under the node's own account, so the per-Agent Linux account stages are
 * gone; `home_marker` and `model_ready` belong to this table and are declared here like every other
 * column. SQLite cannot relax a CHECK constraint in place, so an older database with the account
 * stages is not rebuilt or migrated: this format simply declares what it uses.
 */
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
  stage TEXT NOT NULL CHECK(stage IN ('queued','checking_account','preparing_workspace','verifying_workspace','complete','failed')),
  error TEXT,
  linux_username TEXT,
  uid INTEGER,
  gid INTEGER,
  home TEXT,
  home_marker TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  model_ready INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX owner_agents_status ON owner_agents(status,updated_at,id);
CREATE TABLE owner_agent_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL UNIQUE REFERENCES owner_agents(id),
  created_at INTEGER NOT NULL,
  verified_at INTEGER
);
`;
