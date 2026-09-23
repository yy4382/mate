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

export const reminderSchema = `
ALTER TABLE schedules ADD COLUMN content TEXT NOT NULL DEFAULT 'Legacy reminder: follow up on the referenced conversation or task.';
ALTER TABLE schedules ADD COLUMN anchor TEXT;
ALTER TABLE schedules ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE schedules ADD COLUMN legacy INTEGER NOT NULL DEFAULT 1;
CREATE TABLE reminder_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,reminder_id TEXT NOT NULL REFERENCES schedules(id),version INTEGER NOT NULL,kind TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL);
CREATE TABLE reminder_firings(id TEXT PRIMARY KEY,reminder_id TEXT NOT NULL REFERENCES schedules(id),due_at INTEGER NOT NULL,version INTEGER NOT NULL,delivery_id TEXT NOT NULL REFERENCES deliveries(id),output_id TEXT REFERENCES outbox(id),UNIQUE(reminder_id,due_at,version));
CREATE TABLE system_projections(output_id TEXT PRIMARY KEY REFERENCES outbox(id),kind TEXT NOT NULL CHECK(kind='reminder'),entity_id TEXT NOT NULL,version INTEGER NOT NULL);
UPDATE schedules SET anchor=(SELECT json_object('channel',json_extract(t.message_key,'$[1]'),'ts',json_extract(t.message_key,'$[2]')) FROM tasks t WHERE t.id=schedules.task_id AND t.message_key IS NOT NULL);
INSERT INTO reminder_events(reminder_id,version,kind,at,payload) SELECT id,version,'legacy_migrated',CAST(strftime('%s','now') AS INTEGER)*1000,json_object('active',active,'contentInferred',1) FROM schedules;
PRAGMA user_version=14;
`;

export const sessionLifecycleSchema = `
CREATE TABLE agent_checkpoints(agent_id TEXT PRIMARY KEY REFERENCES agents(id),text TEXT NOT NULL,version INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE session_resets(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id),source_session TEXT NOT NULL REFERENCES sessions(id),work_id TEXT NOT NULL REFERENCES works(id),delivery_id TEXT NOT NULL REFERENCES deliveries(id),checkpoint TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('requested','applied','superseded')),new_session TEXT REFERENCES sessions(id));
CREATE UNIQUE INDEX one_pending_reset ON session_resets(agent_id) WHERE state='requested';
PRAGMA user_version=15;
`;

/** Identity mappings only: message content and side-effect receipts retain one source of truth. */
export const referenceSchema = `
CREATE TABLE conversation_identities(
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('channel','dm')),
 authority TEXT NOT NULL CHECK(authority IN ('internal','external'))
);
CREATE TABLE conversation_bindings(
 provider TEXT NOT NULL,workspace TEXT NOT NULL,external_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL REFERENCES conversation_identities(id),
 mode TEXT NOT NULL CHECK(mode IN ('primary','projection')),
 PRIMARY KEY(provider,workspace,external_id)
);
CREATE UNIQUE INDEX one_primary_conversation_binding ON conversation_bindings(conversation_id) WHERE mode='primary';
CREATE TABLE message_identities(
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES conversation_identities(id),
 root_id TEXT REFERENCES message_identities(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE message_bindings(
 provider TEXT NOT NULL,workspace TEXT NOT NULL,external_conversation TEXT NOT NULL,external_message TEXT NOT NULL,
 message_id TEXT NOT NULL REFERENCES message_identities(id),
 PRIMARY KEY(provider,workspace,external_conversation,external_message),
 FOREIGN KEY(provider,workspace,external_conversation) REFERENCES conversation_bindings(provider,workspace,external_id)
);
CREATE TABLE canonical_targets(
 object_type TEXT NOT NULL,object_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL REFERENCES conversation_identities(id),
 thread_id TEXT REFERENCES message_identities(id),
 PRIMARY KEY(object_type,object_id)
);
PRAGMA user_version=16;
`;

/** Privileged requests are separate from ordinary Agent actions: approval may arrive after its run ended. */
export const systemOperationsSchema = `
CREATE TABLE system_requests(
 id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id),work_id TEXT NOT NULL REFERENCES works(id),
 request_hash TEXT NOT NULL,request TEXT NOT NULL,expires INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired','executing','succeeded','failed','unknown')),
 decision_by TEXT,receipt TEXT,notice_state TEXT NOT NULL DEFAULT 'pending' CHECK(notice_state IN ('pending','sending','sent','unknown'))
);
CREATE INDEX system_requests_pending ON system_requests(status,expires);
PRAGMA user_version=24;
`;
