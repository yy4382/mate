/**
 * The Agent directory as the per-Agent Linux account release left it. Later revisions must not edit
 * this string: it is the template the migration machinery compares a real database against, so
 * changing it in place would silently widen what an older database is accepted as.
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

/**
 * The single-account release replaced per-Agent Linux account creation with workspace preparation
 * under the account that already runs the node, so `creating_account`, `preparing_home` and
 * `verifying_identity` no longer exist. SQLite cannot relax a CHECK constraint in place, so the
 * table is rebuilt; `foreign_keys` is disabled around this statement by the migration runner.
 */
export const singleAccountAgentSchemaV24 = `
CREATE TABLE owner_agents_v24 (
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
INSERT INTO owner_agents_v24(
  id,node_id,name,role,description,provider,model_id,initial_channel_id,request_json,
  request_hash,provision_request_id,status,stage,error,linux_username,uid,gid,home,
  home_marker,created_at,updated_at,model_ready
)
SELECT id,node_id,name,role,description,provider,model_id,initial_channel_id,request_json,
       request_hash,provision_request_id,
       -- The single account replaces the per-Agent account, so a recorded per-Agent identity no
       -- longer describes anything this release can verify. Such an Agent goes back to queued and
       -- is re-prepared on the node, which also keeps it from claiming a stale account forever.
       CASE WHEN linux_username IS NULL THEN status ELSE 'provisioning' END,
       CASE WHEN linux_username IS NULL
            THEN CASE stage WHEN 'creating_account' THEN 'queued'
                            WHEN 'preparing_home' THEN 'preparing_workspace'
                            WHEN 'verifying_identity' THEN 'verifying_workspace'
                            ELSE stage END
            ELSE 'queued' END,
       -- A failure message that named the removed account would contradict the queued state.
       CASE WHEN linux_username IS NULL THEN error ELSE NULL END,
       NULL,NULL,NULL,NULL,
       home_marker,created_at,updated_at,model_ready
FROM owner_agents;
DROP TABLE owner_agents;
ALTER TABLE owner_agents_v24 RENAME TO owner_agents;
CREATE INDEX owner_agents_status ON owner_agents(status,updated_at,id);
`;
