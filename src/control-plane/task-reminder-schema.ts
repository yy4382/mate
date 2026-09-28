/**
 * Message anchored work and Agent owned wakeups. A task's channel is its message's channel, and
 * no task row grants conversation membership.
 */
export const taskReminderSchemaV18 = `
CREATE TABLE owner_tasks (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES owner_messages(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','in_progress','done')),
  owner_agent_id TEXT REFERENCES owner_agents(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX owner_tasks_board ON owner_tasks(status,updated_at);
CREATE TABLE owner_task_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES owner_tasks(id),
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','agent')),
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX owner_task_events_task ON owner_task_events(task_id,seq);
CREATE TABLE owner_task_drafts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES owner_agents(id),
  task_id TEXT REFERENCES owner_tasks(id),
  action TEXT NOT NULL,
  input_json TEXT NOT NULL,
  input_end_seq INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('editing','kept','deferred','abandoned','ready','applied')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE owner_task_draft_reviews (
  draft_id TEXT NOT NULL REFERENCES owner_task_drafts(id),
  message_id TEXT NOT NULL REFERENCES owner_messages(id),
  PRIMARY KEY(draft_id,message_id)
);
CREATE TABLE owner_reminders (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES owner_agents(id),
  channel_id TEXT NOT NULL REFERENCES owner_channels(id),
  task_id TEXT REFERENCES owner_tasks(id),
  text TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','fired','cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX owner_reminders_due ON owner_reminders(state,due_at);
CREATE TABLE owner_reminder_firings (
  id TEXT PRIMARY KEY,
  reminder_id TEXT NOT NULL UNIQUE REFERENCES owner_reminders(id),
  agent_id TEXT NOT NULL REFERENCES owner_agents(id),
  fired_at INTEGER NOT NULL,
  delivery_id TEXT REFERENCES owner_message_deliveries(id),
  handled_at INTEGER
);
`;
