// SQL stays explicit where atomic state transitions define the correctness boundary.
export const schema = `
CREATE TABLE agents(id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), config_version TEXT NOT NULL);
CREATE TABLE entries(session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL, key TEXT NOT NULL, message TEXT NOT NULL,
 PRIMARY KEY(session_id,seq), UNIQUE(session_id,key));
CREATE TABLE snapshots(session_id TEXT PRIMARY KEY REFERENCES sessions(id), watermark INTEGER NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE ingress(app_id TEXT NOT NULL, event_id TEXT NOT NULL, body TEXT NOT NULL, normalized INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(app_id,event_id));
CREATE TABLE deliveries(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), dedupe TEXT NOT NULL, payload TEXT NOT NULL,
 priority INTEGER NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','injected','handled')),
 run_id TEXT, UNIQUE(agent_id,dedupe));
CREATE TABLE runs(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), session_id TEXT NOT NULL REFERENCES sessions(id),
 generation INTEGER NOT NULL, delivery_id TEXT NOT NULL REFERENCES deliveries(id), state TEXT NOT NULL CHECK(state IN ('active','complete','failed','interrupted')),
 error TEXT, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX one_active_run ON runs(agent_id) WHERE state='active';
CREATE TABLE actions(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), run_id TEXT NOT NULL REFERENCES runs(id),
 request_hash TEXT NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','executing','succeeded','failed','unknown')), receipt TEXT);
CREATE TABLE outbox(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), request_hash TEXT NOT NULL, request TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','unknown','failed')), receipt TEXT);
CREATE TABLE audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);
PRAGMA user_version=1;
`;
