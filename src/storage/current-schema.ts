/**
 * The one schema a Mate first-release database is created from.
 *
 * A database is created at its current shape in a single step; there is no
 * chain of history to replay. `application_id` marks the file as this release's
 * format and `user_version` records the schema revision, so an older database
 * (built by the removed migration chain, or by another application) is reported
 * as unsupported instead of being read as current.
 *
 * Constraints and indexes below are part of the format, not decoration: they are
 * what makes the single SQLite transaction the correctness boundary for messages,
 * tasks, deliveries, reminders, usage, drafts and operation results.
 *
 * `user_version` identifies the structures this release requires, not every
 * structure a file may hold. Gaining a structure or changing what an existing one
 * means requires a bump, because an older file must not be read as current.
 * Dropping a structure this release no longer uses does not: `initialize` tolerates
 * structures an earlier build of the same revision left behind and never rewrites
 * them, so an upgraded file keeps every row while this program stops using them.
 */
export const FORMAT_APPLICATION_ID = 0x4d415445; // "MATE"
export const FORMAT_REVISION = 27;

export const currentFormatSchema = `
-- Agents, sessions and the durable conversation journal.
-- The last three columns are the Agent's own automatic-resume state: the earliest instant its next
-- attempt may start (0 = now), how many transient failures it has already waited out, and the
-- disposition its channel is waiting or held for (NULL while it is running or open). A restart reads them
-- instead of retrying densely, a held Agent waits for a person, and paused still outranks both.
CREATE TABLE agents(id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, resume_attempt INTEGER NOT NULL DEFAULT 0, resume_hold TEXT
 CHECK(resume_hold IN ('retry_backoff','human_action','verify_effect','no_retry')));
CREATE TABLE sessions(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), config_version TEXT NOT NULL, context_epoch INTEGER NOT NULL DEFAULT 0);
CREATE TABLE entries(session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL, key TEXT NOT NULL, message TEXT NOT NULL,
 PRIMARY KEY(session_id,seq), UNIQUE(session_id,key));
CREATE TABLE snapshots(session_id TEXT PRIMARY KEY REFERENCES sessions(id), watermark INTEGER NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE agent_checkpoints(agent_id TEXT PRIMARY KEY REFERENCES agents(id),text TEXT NOT NULL,version INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE session_resets(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id),source_session TEXT NOT NULL REFERENCES sessions(id),work_id TEXT NOT NULL REFERENCES works(id),delivery_id TEXT NOT NULL REFERENCES deliveries(id),checkpoint TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('requested','applied','superseded')),new_session TEXT REFERENCES sessions(id));
CREATE UNIQUE INDEX one_pending_reset ON session_resets(agent_id) WHERE state='requested';
CREATE TABLE review_seats(agent_id TEXT PRIMARY KEY REFERENCES agents(id),target TEXT NOT NULL,brief TEXT NOT NULL,workspace TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);

-- Conversation history: one stored body per revision, per-Agent visibility and reads.
CREATE TABLE channel_access(agent_id TEXT NOT NULL REFERENCES agents(id), channel TEXT NOT NULL, active INTEGER NOT NULL, PRIMARY KEY(agent_id,channel));
CREATE TABLE channel_watches(agent_id TEXT NOT NULL,channel TEXT NOT NULL,PRIMARY KEY(agent_id,channel));
CREATE TABLE thread_watches(agent_id TEXT NOT NULL REFERENCES agents(id), channel TEXT NOT NULL, thread TEXT NOT NULL, PRIMARY KEY(agent_id,channel,thread));
CREATE TABLE messages(key TEXT PRIMARY KEY, channel TEXT NOT NULL, ts TEXT NOT NULL, revision TEXT NOT NULL, body TEXT NOT NULL, deleted INTEGER NOT NULL, thread TEXT);
CREATE TABLE message_revisions(key TEXT NOT NULL REFERENCES messages(key), revision TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(key,revision));
CREATE TABLE message_visibility(
 agent_id TEXT NOT NULL REFERENCES agents(id),key TEXT NOT NULL REFERENCES messages(key),revision TEXT NOT NULL,body TEXT NOT NULL,
 PRIMARY KEY(agent_id,key),FOREIGN KEY(key,revision) REFERENCES message_revisions(key,revision));
CREATE TABLE message_observations(agent_id TEXT NOT NULL REFERENCES agents(id), key TEXT NOT NULL REFERENCES messages(key), revision TEXT NOT NULL, PRIMARY KEY(agent_id,key,revision));
CREATE TABLE conversation_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,channel TEXT NOT NULL,message_key TEXT NOT NULL,revision TEXT NOT NULL,kind TEXT NOT NULL,audience TEXT,thread TEXT);
CREATE INDEX conversation_event_target ON conversation_events(channel,thread,seq);
CREATE INDEX message_history_conversation ON messages(channel,length(ts) DESC,ts DESC,key DESC);
CREATE INDEX message_history_thread ON messages(channel,thread,length(ts) DESC,ts DESC,key DESC);

-- Canonical conversation and message identities: one source of truth for routing.
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

-- Internal conversations: members, room ordering and local input dedupe.
CREATE TABLE internal_dm_pairs(pair TEXT PRIMARY KEY,conversation_id TEXT NOT NULL UNIQUE REFERENCES conversation_identities(id));
CREATE TABLE internal_members(conversation_id TEXT NOT NULL REFERENCES conversation_identities(id),kind TEXT NOT NULL CHECK(kind IN ('agent','human')),principal_id TEXT NOT NULL,PRIMARY KEY(conversation_id,kind,principal_id));
CREATE TABLE internal_sequence(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL);
INSERT INTO internal_sequence(id,value) VALUES(1,0);
CREATE TABLE local_inputs(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES message_identities(id));

-- Attention: paged snapshots, presented records and per-Agent choices.
CREATE TABLE attention_views(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id),session_id TEXT NOT NULL REFERENCES sessions(id),epoch INTEGER NOT NULL,target TEXT NOT NULL,revision INTEGER NOT NULL,pages TEXT NOT NULL,complete INTEGER NOT NULL);
CREATE TABLE attention_presented(view_id TEXT NOT NULL REFERENCES attention_views(id),page INTEGER NOT NULL,PRIMARY KEY(view_id,page));
CREATE TABLE attention_seen(agent_id TEXT NOT NULL,key TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(agent_id,key));
CREATE TABLE attention_state(agent_id TEXT NOT NULL,target TEXT NOT NULL,resolved INTEGER NOT NULL DEFAULT 0,deferred_until INTEGER NOT NULL DEFAULT 0,muted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(agent_id,target));

-- Work items, tasks and the message-anchored task lifecycle.
CREATE TABLE works(id TEXT PRIMARY KEY, origin TEXT NOT NULL UNIQUE, target TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active');
CREATE TABLE work_runs(run_id TEXT PRIMARY KEY REFERENCES runs(id), work_id TEXT NOT NULL REFERENCES works(id));
CREATE TABLE message_work(message_key TEXT PRIMARY KEY REFERENCES messages(key), work_id TEXT NOT NULL REFERENCES works(id));
-- A task is anchored to a confirmed message or to the publication that will produce one; the
-- publication anchor is the task's own reservation, so it is deliberately not a foreign key.
CREATE TABLE tasks(id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id), parent_id TEXT REFERENCES tasks(id), target TEXT NOT NULL, title TEXT NOT NULL, owner TEXT REFERENCES agents(id), assigned_to TEXT REFERENCES agents(id), status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, waiting_on TEXT REFERENCES tasks(id), result TEXT, outbox_id TEXT, message_key TEXT REFERENCES messages(key), created_by TEXT REFERENCES agents(id), CHECK(message_key IS NOT NULL OR outbox_id IS NOT NULL));
CREATE UNIQUE INDEX canonical_message_task ON tasks(message_key);
CREATE INDEX task_message_lookup ON tasks(message_key);
CREATE INDEX task_publication_lookup ON tasks(outbox_id);
CREATE TABLE task_events(id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), at INTEGER NOT NULL, body TEXT NOT NULL);
CREATE TABLE task_event_baselines(
 task_id TEXT PRIMARY KEY REFERENCES tasks(id),
 complete_after_version INTEGER NOT NULL,
 historical_complete INTEGER NOT NULL CHECK(historical_complete IN (0,1)),
 migrated_at INTEGER NOT NULL);
CREATE INDEX task_baseline_gaps ON task_event_baselines(task_id) WHERE historical_complete=0;
CREATE TABLE task_intents(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,work_id TEXT NOT NULL,operation TEXT NOT NULL,args TEXT NOT NULL,target TEXT NOT NULL,state TEXT NOT NULL,hold_id TEXT,receipt TEXT);
CREATE TABLE task_projections(output_id TEXT PRIMARY KEY REFERENCES outbox(id),task_id TEXT NOT NULL REFERENCES tasks(id),version INTEGER NOT NULL);
CREATE INDEX task_list_owner ON tasks(owner,id DESC);
CREATE INDEX task_list_assigned ON tasks(assigned_to,id DESC);
CREATE INDEX task_list_available ON tasks(id DESC,assigned_to) WHERE owner IS NULL AND status IN ('todo','review');
CREATE INDEX task_list_status ON tasks(status,id DESC);
CREATE INDEX task_list_conversation ON tasks(json_extract(target,'$.conversationId'),id DESC);
CREATE INDEX task_list_thread ON tasks(json_extract(target,'$.conversationId'),json_extract(target,'$.threadId'),id DESC);
CREATE INDEX task_events_page ON task_events(task_id,id DESC);
CREATE INDEX task_conversation ON tasks(json_extract(target,'$.conversationId'));
CREATE INDEX intent_conversation ON task_intents(json_extract(target,'$.conversationId'));
CREATE INDEX work_conversation ON works(json_extract(target,'$.conversationId'));

-- Reminders stay owned by their author and outlive the task they mention.
CREATE TABLE schedules(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), work_id TEXT NOT NULL REFERENCES works(id), task_id TEXT REFERENCES tasks(id), target TEXT NOT NULL, next_at INTEGER NOT NULL, cron TEXT, timezone TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, content TEXT NOT NULL, anchor TEXT, version INTEGER NOT NULL DEFAULT 1, projection TEXT NOT NULL
 CHECK(projection IN ('private','conversation_receipt')));
CREATE TABLE reminder_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,reminder_id TEXT NOT NULL REFERENCES schedules(id),version INTEGER NOT NULL,kind TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL,actor_id TEXT REFERENCES agents(id));
CREATE TABLE reminder_firings(id TEXT PRIMARY KEY,reminder_id TEXT NOT NULL REFERENCES schedules(id),due_at INTEGER NOT NULL,version INTEGER NOT NULL,delivery_id TEXT NOT NULL REFERENCES deliveries(id),output_id TEXT REFERENCES outbox(id),result_status TEXT
 CHECK(result_status IN ('completed','failed','deferred')),result_summary TEXT,result_at INTEGER,actor_id TEXT REFERENCES agents(id),UNIQUE(reminder_id,due_at,version));
CREATE TABLE system_projections(output_id TEXT PRIMARY KEY REFERENCES outbox(id),kind TEXT NOT NULL CHECK(kind='reminder'),entity_id TEXT NOT NULL,version INTEGER NOT NULL);
CREATE INDEX schedule_conversation ON schedules(json_extract(target,'$.conversationId'));
CREATE INDEX schedule_due_status ON schedules(active,next_at,id);
CREATE INDEX reminder_events_page ON reminder_events(reminder_id,seq DESC);
CREATE INDEX reminder_firings_page ON reminder_firings(reminder_id,due_at DESC,version DESC,id DESC);

-- Deliveries and runs: the persistent inbox and its fenced execution token.
CREATE TABLE deliveries(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), dedupe TEXT NOT NULL, payload TEXT NOT NULL,
 priority INTEGER NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','injected','handled')),
 run_id TEXT, UNIQUE(agent_id,dedupe));
CREATE TABLE delivery_work(delivery_id TEXT PRIMARY KEY REFERENCES deliveries(id), work_id TEXT NOT NULL REFERENCES works(id));
CREATE TABLE delivery_context(delivery_id TEXT PRIMARY KEY REFERENCES deliveries(id),work_id TEXT NOT NULL REFERENCES works(id));
CREATE TABLE runs(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), session_id TEXT NOT NULL REFERENCES sessions(id),
 generation INTEGER NOT NULL, delivery_id TEXT NOT NULL REFERENCES deliveries(id), state TEXT NOT NULL CHECK(state IN ('active','complete','failed','interrupted','yielded')),
 stop_reason TEXT CHECK(stop_reason IN ('complete','turn_budget','external_wait','model_failure','owner_pause','work_stopped','interrupted')),
 error TEXT, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX one_active_run ON runs(agent_id) WHERE state='active';
CREATE TABLE run_context(run_id TEXT PRIMARY KEY REFERENCES runs(id),work_id TEXT NOT NULL REFERENCES works(id));

-- Outbound messages, drafts and the freshness hold around them.
CREATE TABLE outbox(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), request_hash TEXT NOT NULL, request TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('held','pending','sending','sent','unknown','failed')),receipt TEXT, target TEXT NOT NULL DEFAULT '{}', created_at INTEGER);
CREATE INDEX outbox_scope ON outbox(json_extract(target,'$.conversationId'),json_extract(target,'$.threadId'),state);
CREATE TABLE output_work(output_id TEXT PRIMARY KEY REFERENCES outbox(id), work_id TEXT NOT NULL REFERENCES works(id));
CREATE TABLE drafts(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id),outbox_id TEXT NOT NULL REFERENCES outbox(id),revision INTEGER NOT NULL DEFAULT 1,hold_id TEXT,reason TEXT,accepted_revision INTEGER,continue_until INTEGER NOT NULL DEFAULT 0);
CREATE INDEX draft_output_lookup ON drafts(outbox_id,id DESC);
CREATE TRIGGER outbox_target_required BEFORE INSERT ON outbox WHEN json_type(NEW.target,'$.conversationId') IS NOT 'text'
 OR NOT EXISTS(SELECT 1 FROM conversation_identities WHERE id=json_extract(NEW.target,'$.conversationId'))
 OR (json_type(NEW.target,'$.threadId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM message_identities WHERE id=json_extract(NEW.target,'$.threadId') AND root_id=id AND conversation_id=json_extract(NEW.target,'$.conversationId')))
 BEGIN SELECT RAISE(ABORT,'Canonical output routing required'); END;
CREATE TRIGGER outbox_target_immutable BEFORE UPDATE OF target ON outbox WHEN NEW.target IS NOT OLD.target
 BEGIN SELECT RAISE(ABORT,'Output target is immutable'); END;

-- Ordinary Agent actions and privileged requests: both survive an interrupted run.
CREATE TABLE actions(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), run_id TEXT NOT NULL REFERENCES runs(id),
 request_hash TEXT NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','executing','succeeded','failed','unknown')), receipt TEXT, created_at INTEGER);
CREATE TABLE system_requests(
 id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id),work_id TEXT NOT NULL REFERENCES works(id),
 request_hash TEXT NOT NULL,request TEXT NOT NULL,expires INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired','executing','succeeded','failed','unknown')),
 decision_by TEXT,receipt TEXT,notice_state TEXT NOT NULL DEFAULT 'pending' CHECK(notice_state IN ('pending','sending','sent','unknown'))
);
CREATE INDEX system_requests_pending ON system_requests(status,expires);

-- Projection of internal conversations into Slack, including controlled import.
CREATE TABLE projection_bindings(
 id TEXT PRIMARY KEY,provider TEXT NOT NULL,workspace TEXT NOT NULL,external_id TEXT NOT NULL,
 publisher TEXT NOT NULL REFERENCES agents(id),enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),imports TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0,
 UNIQUE(provider,workspace,external_id),
 FOREIGN KEY(provider,workspace,external_id) REFERENCES conversation_bindings(provider,workspace,external_id));
CREATE TABLE projection_outbox(
 id TEXT PRIMARY KEY,binding_id TEXT NOT NULL REFERENCES projection_bindings(id),message_id TEXT NOT NULL REFERENCES message_identities(id),
 source_revision TEXT NOT NULL,text TEXT NOT NULL,anchor INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL CHECK(state IN ('pending','held','sending','unknown','sent','failed')),
 reason TEXT,wire TEXT,request_hash TEXT,receipt TEXT,retry_at INTEGER NOT NULL DEFAULT 0,drift TEXT,
 UNIQUE(binding_id,message_id));
CREATE TABLE projection_imports(
 binding_id TEXT NOT NULL REFERENCES projection_bindings(id),external_id TEXT NOT NULL,
 external_revision TEXT NOT NULL,root_external TEXT NOT NULL,body TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending_dependency','applied','rejected')),reason TEXT,
 message_id TEXT REFERENCES message_identities(id),PRIMARY KEY(binding_id,external_id));
CREATE INDEX projection_pending ON projection_outbox(state,binding_id);
CREATE INDEX projection_import_pending ON projection_imports(status,binding_id);
CREATE TRIGGER projection_binding_identity BEFORE UPDATE OF provider,workspace,external_id,publisher ON projection_bindings
 WHEN NEW.provider IS NOT OLD.provider OR NEW.workspace IS NOT OLD.workspace OR NEW.external_id IS NOT OLD.external_id OR NEW.publisher IS NOT OLD.publisher
 BEGIN SELECT RAISE(ABORT,'Projection binding identity is immutable'); END;
CREATE TRIGGER projection_intent_identity BEFORE UPDATE OF binding_id,message_id,source_revision,text,anchor ON projection_outbox
 WHEN NEW.binding_id IS NOT OLD.binding_id OR NEW.message_id IS NOT OLD.message_id OR NEW.source_revision IS NOT OLD.source_revision OR NEW.text IS NOT OLD.text OR NEW.anchor IS NOT OLD.anchor
 BEGIN SELECT RAISE(ABORT,'Projection intent is immutable'); END;
CREATE TRIGGER projection_wire_identity BEFORE UPDATE OF wire,request_hash ON projection_outbox
 WHEN OLD.wire IS NOT NULL AND (NEW.wire IS NOT OLD.wire OR NEW.request_hash IS NOT OLD.request_hash)
 BEGIN SELECT RAISE(ABORT,'Projection wire is immutable'); END;

-- Durable model usage: one row per provider call, known or unknown.
CREATE TABLE model_usage(
 run_id TEXT NOT NULL REFERENCES runs(id), call_index INTEGER NOT NULL,
 agent_id TEXT NOT NULL REFERENCES agents(id), work_id TEXT REFERENCES works(id),
 provider TEXT NOT NULL, model_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('unknown','known')),
 input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
 total_tokens INTEGER, estimated_cost_usd REAL,
 source TEXT NOT NULL CHECK(source IN ('runtime','journal_backfill')),
 PRIMARY KEY(run_id,call_index)
);

-- Owner-facing activity, operational facts and daemon bookkeeping.
CREATE TABLE operational_facts(
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 at INTEGER NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('runtime','internal_dm')),
 source_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('run_completed','run_failed','run_yielded','run_interrupted','internal_dm_created')),
 actor_id TEXT REFERENCES agents(id),
 subject_type TEXT NOT NULL CHECK(subject_type IN ('run','internal_dm')),
 subject_id TEXT NOT NULL,
 target_type TEXT,
 target_id TEXT,
 counts TEXT NOT NULL DEFAULT '{}',
 CHECK(
  source='runtime' AND kind IN ('run_completed','run_failed','run_yielded','run_interrupted') AND actor_id IS NOT NULL
   AND subject_type='run' AND target_type IS NULL AND target_id IS NULL AND counts='{}'
  OR source='internal_dm' AND kind='internal_dm_created' AND actor_id IS NOT NULL
   AND subject_type='internal_dm' AND target_type IS NULL AND target_id IS NULL
   AND json_valid(counts) AND json_type(counts,'$.members')='integer' AND json_extract(counts,'$.members')=2
   AND json_remove(counts,'$.members')='{}'
 ),
 UNIQUE(source,source_id)
);
CREATE TABLE audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE runtime_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE ingress(app_id TEXT NOT NULL, event_id TEXT NOT NULL, body TEXT NOT NULL, normalized INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(app_id,event_id));
CREATE TABLE admin_replies(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), channel TEXT NOT NULL, user_id TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE slack_cursors(agent_id TEXT NOT NULL REFERENCES agents(id), channel TEXT NOT NULL, ts TEXT NOT NULL, PRIMARY KEY(agent_id,channel));

CREATE INDEX action_activity ON actions(created_at DESC,id DESC) WHERE created_at IS NOT NULL;
CREATE INDEX output_activity ON outbox(created_at DESC,id DESC) WHERE created_at IS NOT NULL;
CREATE INDEX run_activity ON runs(created_at DESC,id DESC);
CREATE INDEX run_activity_actor ON runs(agent_id,created_at DESC,id DESC);
CREATE INDEX action_activity_actor ON actions(agent_id,created_at DESC,id DESC) WHERE created_at IS NOT NULL;
CREATE INDEX output_activity_actor ON outbox(agent_id,created_at DESC,id DESC) WHERE created_at IS NOT NULL;
CREATE INDEX action_uncertain_status ON actions(id DESC) WHERE state IN ('executing','unknown');
CREATE INDEX output_unknown_status ON outbox(id DESC) WHERE state='unknown';
CREATE INDEX output_held_status ON outbox(id DESC) WHERE state='held';
CREATE INDEX action_missing_activity_time ON actions(id) WHERE created_at IS NULL;
CREATE INDEX output_missing_activity_time ON outbox(id) WHERE created_at IS NULL;
CREATE INDEX operational_fact_activity ON operational_facts(at DESC,seq DESC);
CREATE INDEX operational_fact_source_activity ON operational_facts(source,at DESC,seq DESC);
CREATE INDEX operational_fact_actor_activity ON operational_facts(actor_id,at DESC,seq DESC);
CREATE INDEX operational_fact_source_actor_activity ON operational_facts(source,actor_id,at DESC,seq DESC);
CREATE INDEX operational_fact_kind_activity ON operational_facts(source,kind,at DESC,seq DESC);
CREATE INDEX operational_fact_actor_kind_activity ON operational_facts(source,actor_id,kind,at DESC,seq DESC);
CREATE INDEX reminder_activity ON reminder_events(at DESC,seq DESC);
CREATE INDEX reminder_activity_actor ON reminder_events(actor_id,at DESC,seq DESC);
CREATE INDEX reminder_activity_kind ON reminder_events(kind,at DESC,seq DESC);
CREATE INDEX reminder_activity_actor_kind ON reminder_events(actor_id,kind,at DESC,seq DESC);
CREATE INDEX reminder_firing_activity ON reminder_firings(due_at DESC,id DESC);
CREATE INDEX reminder_firing_activity_actor ON reminder_firings(actor_id,due_at DESC,id DESC);
CREATE INDEX task_activity ON task_events(at DESC,id DESC);
CREATE INDEX task_activity_actor ON task_events(COALESCE(json_extract(body,'$.actor'),json_extract(body,'$.agentId')),at DESC,id DESC);
CREATE INDEX task_activity_kind ON task_events(('task.'||json_extract(body,'$.action')),at DESC,id DESC);
CREATE INDEX task_activity_actor_kind ON task_events(COALESCE(json_extract(body,'$.actor'),json_extract(body,'$.agentId')),('task.'||json_extract(body,'$.action')),at DESC,id DESC);
CREATE INDEX model_usage_agent ON model_usage(agent_id,run_id);
CREATE INDEX model_usage_work ON model_usage(work_id,run_id);

-- Markers read by the running application, present from the first open. Runtime and
-- internal-DM activity is a going-forward record, so its owner view reports coverage
-- from this database's creation instant rather than claiming earlier history.
INSERT INTO runtime_meta(key,value) VALUES('conversation_format','mate.conversations.v2');
INSERT INTO runtime_meta(key,value) VALUES('operations_view_since',CAST(strftime('%s','now') AS INTEGER)*1000);

PRAGMA application_id = ${FORMAT_APPLICATION_ID};
PRAGMA user_version = ${FORMAT_REVISION};
`;
