/**
 * The Agent directory and its logical session as the single-account release uses them. Preparation
 * happens in a workspace under the node's own account, so the per-Agent Linux account stages are
 * gone; `home` and `home_marker` belong to this table and are declared here like every other column.
 * Readiness is not stored: `stage` is the one durable preparation state, and whether the Agent can
 * run is asked of the provider's current credential row when the owner reads or schedules it.
 * SQLite cannot relax a CHECK constraint in place, so an older database with the account stages is
 * not rebuilt or migrated: this format simply declares what it uses.
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
  thinking_level TEXT NOT NULL DEFAULT 'default' CHECK(thinking_level IN ('default','low','medium','high')),
  initial_channel_id TEXT REFERENCES owner_channels(id),
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
  provision_request_id TEXT NOT NULL UNIQUE,
  stage TEXT NOT NULL CHECK(stage IN ('queued','checking_account','preparing_workspace','verifying_workspace','complete','failed')),
  error TEXT,
  home TEXT,
  home_marker TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX owner_agents_stage ON owner_agents(stage,updated_at,id);
CREATE TABLE owner_agent_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL UNIQUE REFERENCES owner_agents(id),
  created_at INTEGER NOT NULL
);
`;
