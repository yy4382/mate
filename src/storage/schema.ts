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
export const messageSchema = `
CREATE TABLE channel_access(agent_id TEXT NOT NULL REFERENCES agents(id), channel TEXT NOT NULL, active INTEGER NOT NULL, PRIMARY KEY(agent_id,channel));
CREATE TABLE messages(key TEXT PRIMARY KEY, channel TEXT NOT NULL, ts TEXT NOT NULL, thread TEXT NOT NULL, revision TEXT NOT NULL, body TEXT NOT NULL, deleted INTEGER NOT NULL);
CREATE TABLE message_revisions(key TEXT NOT NULL REFERENCES messages(key), revision TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(key,revision));
CREATE TABLE message_visibility(agent_id TEXT NOT NULL REFERENCES agents(id), key TEXT NOT NULL REFERENCES messages(key), PRIMARY KEY(agent_id,key));
CREATE TABLE message_observations(agent_id TEXT NOT NULL REFERENCES agents(id), key TEXT NOT NULL REFERENCES messages(key), revision TEXT NOT NULL, PRIMARY KEY(agent_id,key,revision));
CREATE TABLE thread_watches(agent_id TEXT NOT NULL REFERENCES agents(id), channel TEXT NOT NULL, thread TEXT NOT NULL, PRIMARY KEY(agent_id,channel,thread));
PRAGMA user_version=2;
`;
export const collaborationSchema = `
CREATE TABLE works(id TEXT PRIMARY KEY, origin TEXT NOT NULL UNIQUE, target TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active', max_runs INTEGER NOT NULL, max_tokens INTEGER NOT NULL, max_cost REAL NOT NULL, runs INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0);
CREATE TABLE work_runs(run_id TEXT PRIMARY KEY REFERENCES runs(id), work_id TEXT NOT NULL REFERENCES works(id), token_cap INTEGER NOT NULL, cost_cap REAL NOT NULL, settled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE delivery_work(delivery_id TEXT PRIMARY KEY REFERENCES deliveries(id), work_id TEXT NOT NULL REFERENCES works(id));
CREATE TABLE message_work(message_key TEXT PRIMARY KEY REFERENCES messages(key), work_id TEXT NOT NULL REFERENCES works(id));
CREATE TABLE output_work(output_id TEXT PRIMARY KEY REFERENCES outbox(id), work_id TEXT NOT NULL REFERENCES works(id));
CREATE TABLE tasks(id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id), parent_id TEXT REFERENCES tasks(id), target TEXT NOT NULL, title TEXT NOT NULL, owner TEXT REFERENCES agents(id), assigned_to TEXT REFERENCES agents(id), status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, waiting_on TEXT REFERENCES tasks(id), result TEXT, outbox_id TEXT REFERENCES outbox(id));
CREATE TABLE task_events(id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), at INTEGER NOT NULL, body TEXT NOT NULL);
CREATE TABLE schedules(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), work_id TEXT NOT NULL REFERENCES works(id), task_id TEXT REFERENCES tasks(id), target TEXT NOT NULL, next_at INTEGER NOT NULL, cron TEXT, timezone TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
PRAGMA user_version=3;
`;
export const policySchema = `
CREATE TABLE grants(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), work_id TEXT NOT NULL REFERENCES works(id), root TEXT NOT NULL, operations TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, exec_allowlist TEXT NOT NULL DEFAULT '[]');
CREATE TABLE approvals(id TEXT PRIMARY KEY REFERENCES actions(id), agent_id TEXT NOT NULL REFERENCES agents(id), work_id TEXT NOT NULL REFERENCES works(id), run_id TEXT NOT NULL REFERENCES runs(id), grant_id TEXT NOT NULL REFERENCES grants(id), request_hash TEXT NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', decision_by TEXT, policy_version TEXT NOT NULL, classification TEXT);
CREATE TABLE blocked_runs(run_id TEXT PRIMARY KEY REFERENCES runs(id));
PRAGMA user_version=4;
`;

export const runtimeSchema = `
CREATE TABLE inbox_reads(delivery_id TEXT PRIMARY KEY REFERENCES deliveries(id), agent_id TEXT NOT NULL REFERENCES agents(id), read_at INTEGER NOT NULL);
PRAGMA user_version=5;
`;
export const daemonSchema = `
CREATE TABLE runtime_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE admin_replies(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), channel TEXT NOT NULL, user_id TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE slack_cursors(agent_id TEXT NOT NULL REFERENCES agents(id), channel TEXT NOT NULL, ts TEXT NOT NULL, PRIMARY KEY(agent_id,channel));
PRAGMA user_version=6;
`;
/** One-way compatibility migration: retire review state without executing pending commands. */
export const scopedExecutionSchema = `
INSERT INTO audit(at,kind,body) SELECT CAST(strftime('%s','now') AS INTEGER)*1000,'retired_command_review',json_object('actionId',id,'status',status,'requestHash',request_hash) FROM approvals;
UPDATE grants SET revoked=1 WHERE EXISTS(SELECT 1 FROM json_each(grants.operations) WHERE value='exec');
UPDATE actions SET state='failed',receipt='{"reason":"command_review_removed; reauthorize scoped execution explicitly"}' WHERE state='prepared' AND json_extract(request,'$.operation.kind')='exec';
UPDATE deliveries SET status='handled' WHERE json_extract(payload,'$.kind')='approval' AND status!='handled';
UPDATE outbox SET state='failed',receipt='{"reason":"command_review_removed"}' WHERE id LIKE 'approval-notice:%' AND state='pending';
DROP TABLE blocked_runs;
DROP TABLE approvals;
ALTER TABLE grants DROP COLUMN exec_allowlist;
PRAGMA user_version=7;
`;

export const conversationSchema = `
CREATE TABLE conversation_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,channel TEXT NOT NULL,thread TEXT NOT NULL,message_key TEXT NOT NULL,revision TEXT NOT NULL,kind TEXT NOT NULL);
CREATE INDEX conversation_event_target ON conversation_events(channel,thread,seq);
INSERT INTO conversation_events(channel,thread,message_key,revision,kind) SELECT channel,thread,key,revision,CASE WHEN deleted=1 THEN 'delete' ELSE 'message' END FROM messages ORDER BY rowid;
PRAGMA user_version=8;
`;

export const budgetSchema = `
CREATE TABLE budget_accounts(agent_id TEXT PRIMARY KEY REFERENCES agents(id),max_runs INTEGER NOT NULL,max_tokens INTEGER NOT NULL,max_cost REAL NOT NULL,runs INTEGER NOT NULL DEFAULT 0,tokens INTEGER NOT NULL DEFAULT 0,cost REAL NOT NULL DEFAULT 0);
CREATE TABLE budget_runs(run_id TEXT PRIMARY KEY REFERENCES runs(id),agent_id TEXT NOT NULL REFERENCES agents(id),token_cap INTEGER NOT NULL,cost_cap REAL NOT NULL,settled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE delivery_context(delivery_id TEXT PRIMARY KEY REFERENCES deliveries(id),work_id TEXT NOT NULL REFERENCES works(id));
CREATE TABLE run_context(run_id TEXT PRIMARY KEY REFERENCES runs(id),work_id TEXT NOT NULL REFERENCES works(id));
PRAGMA user_version=9;
`;

export const attentionSchema = `
ALTER TABLE conversation_events ADD COLUMN audience TEXT;
ALTER TABLE sessions ADD COLUMN context_epoch INTEGER NOT NULL DEFAULT 0;
CREATE TABLE attention_views(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id),session_id TEXT NOT NULL REFERENCES sessions(id),epoch INTEGER NOT NULL,target TEXT NOT NULL,revision INTEGER NOT NULL,pages TEXT NOT NULL,complete INTEGER NOT NULL);
CREATE TABLE attention_presented(view_id TEXT NOT NULL REFERENCES attention_views(id),page INTEGER NOT NULL,PRIMARY KEY(view_id,page));
CREATE TABLE attention_seen(agent_id TEXT NOT NULL,key TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(agent_id,key));
CREATE TABLE attention_state(agent_id TEXT NOT NULL,target TEXT NOT NULL,resolved INTEGER NOT NULL DEFAULT 0,deferred_until INTEGER NOT NULL DEFAULT 0,muted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(agent_id,target));
CREATE TABLE channel_watches(agent_id TEXT NOT NULL,channel TEXT NOT NULL,PRIMARY KEY(agent_id,channel));
PRAGMA user_version=10;
`;

export const freshnessSchema = `
CREATE TABLE outbox_next(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), request_hash TEXT NOT NULL, request TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('held','pending','sending','sent','unknown','failed')),receipt TEXT);
INSERT INTO outbox_next SELECT * FROM outbox;
DROP TABLE outbox;
ALTER TABLE outbox_next RENAME TO outbox;
CREATE TABLE drafts(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id),outbox_id TEXT NOT NULL REFERENCES outbox(id),revision INTEGER NOT NULL DEFAULT 1,hold_id TEXT,reason TEXT,accepted_revision INTEGER,continue_until INTEGER NOT NULL DEFAULT 0);
PRAGMA user_version=11;
`;

export const reviewSeatSchema = `
CREATE TABLE review_seats(agent_id TEXT PRIMARY KEY REFERENCES agents(id),target TEXT NOT NULL,brief TEXT NOT NULL,workspace TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
PRAGMA user_version=12;
`;

export const messageTaskSchema = `
ALTER TABLE tasks ADD COLUMN message_key TEXT REFERENCES messages(key);
CREATE UNIQUE INDEX canonical_message_task ON tasks(message_key) WHERE message_key IS NOT NULL;
CREATE TABLE task_intents(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,work_id TEXT NOT NULL,operation TEXT NOT NULL,args TEXT NOT NULL,target TEXT NOT NULL,state TEXT NOT NULL,hold_id TEXT,receipt TEXT);
CREATE TABLE task_projections(output_id TEXT PRIMARY KEY REFERENCES outbox(id),task_id TEXT NOT NULL REFERENCES tasks(id),version INTEGER NOT NULL);
PRAGMA user_version=13;
`;
