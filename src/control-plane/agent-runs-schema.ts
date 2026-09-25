/** Durable message journal and the one active model run allowed for each Agent. */
export const agentRunSchemaV7 = `
ALTER TABLE owner_agents
  ADD COLUMN model_ready INTEGER NOT NULL DEFAULT 0 CHECK(model_ready IN (0,1));
ALTER TABLE owner_messages
  ADD COLUMN author_kind TEXT NOT NULL DEFAULT 'human' CHECK(author_kind IN ('human','agent'));
ALTER TABLE owner_messages
  ADD COLUMN author_id TEXT NOT NULL DEFAULT 'owner';

CREATE TABLE owner_agent_direct_channels (
  agent_id TEXT PRIMARY KEY REFERENCES owner_agents(id),
  channel_id TEXT NOT NULL UNIQUE REFERENCES owner_channels(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE owner_agent_session_journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES owner_agent_sessions(id),
  agent_id TEXT NOT NULL REFERENCES owner_agents(id),
  channel_id TEXT NOT NULL REFERENCES owner_channels(id),
  message_id TEXT REFERENCES owner_messages(id),
  run_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id,message_id,role)
);
CREATE INDEX owner_agent_session_journal_context
  ON owner_agent_session_journal(session_id,seq);
CREATE UNIQUE INDEX owner_agent_session_journal_reply_once
  ON owner_agent_session_journal(run_id) WHERE role='assistant' AND run_id IS NOT NULL;
CREATE TABLE owner_agent_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES owner_agents(id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  delivery_id TEXT NOT NULL REFERENCES owner_message_deliveries(id),
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
`;

/** Persist the exact journal request identity so completed run replays can be verified. */
export const agentJournalReplaySchema = `
ALTER TABLE owner_agent_session_journal ADD COLUMN request_id TEXT;
ALTER TABLE owner_agent_session_journal ADD COLUMN content_hash TEXT;
CREATE UNIQUE INDEX owner_agent_session_journal_request_id
  ON owner_agent_session_journal(request_id) WHERE request_id IS NOT NULL;
`;

export const agentRunSchema = `${agentRunSchemaV7}\n${agentJournalReplaySchema}`;
