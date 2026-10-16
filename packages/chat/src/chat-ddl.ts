/**
 * The chat database schema. A store is created at this version and never migrated: a file stamped with any other
 * `user_version` is refused (see ADR-0002, first-release compatibility reset).
 */
export const CHAT_SCHEMA_VERSION = 1;

export const CHAT_DDL = `
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  handle TEXT NOT NULL,
  handle_key TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
) STRICT;
CREATE UNIQUE INDEX accounts_single_owner ON accounts (role) WHERE role = 'owner';

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('public', 'private', 'dm')),
  name TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  dm_low INTEGER REFERENCES accounts (id),
  dm_high INTEGER REFERENCES accounts (id),
  created_at INTEGER NOT NULL,
  CHECK (kind = 'dm' OR (name IS NOT NULL AND dm_low IS NULL AND dm_high IS NULL)),
  CHECK (kind <> 'dm' OR (name IS NULL AND dm_low < dm_high)),
  UNIQUE (dm_low, dm_high)
) STRICT;

CREATE TABLE memberships (
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  PRIMARY KEY (conversation_id, account_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX memberships_account ON memberships (account_id);

-- A conversation's top level is the timeline without a root; every top-level message roots its own thread timeline.
CREATE TABLE timelines (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  root_entry_id INTEGER REFERENCES entries (id),
  last_seq INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE UNIQUE INDEX timelines_top_level ON timelines (conversation_id) WHERE root_entry_id IS NULL;
CREATE UNIQUE INDEX timelines_thread ON timelines (root_entry_id) WHERE root_entry_id IS NOT NULL;

CREATE TABLE entries (
  id INTEGER PRIMARY KEY,
  timeline_id INTEGER NOT NULL REFERENCES timelines (id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'task')),
  author_id INTEGER NOT NULL REFERENCES accounts (id),
  created_at INTEGER NOT NULL,
  body TEXT,
  task_id INTEGER REFERENCES tasks (id),
  change TEXT CHECK (change IN ('created', 'claimed', 'yielded', 'transferred', 'completed')),
  task_owner_id INTEGER REFERENCES accounts (id),
  CHECK ((kind = 'message') = (body IS NOT NULL)),
  CHECK ((kind = 'task') = (task_id IS NOT NULL AND change IS NOT NULL)),
  UNIQUE (timeline_id, seq)
) STRICT;

CREATE TABLE attachments (
  entry_id INTEGER NOT NULL REFERENCES entries (id),
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  storage_key TEXT NOT NULL,
  PRIMARY KEY (entry_id, position)
) STRICT, WITHOUT ROWID;

CREATE TABLE mentions (
  entry_id INTEGER NOT NULL REFERENCES entries (id),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  PRIMARY KEY (entry_id, account_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX mentions_account ON mentions (account_id);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES entries (id),
  title TEXT NOT NULL,
  owner_id INTEGER REFERENCES accounts (id),
  status TEXT NOT NULL CHECK (status IN ('open', 'completed'))
) STRICT;

CREATE TABLE read_positions (
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  timeline_id INTEGER NOT NULL REFERENCES timelines (id),
  seq INTEGER NOT NULL,
  PRIMARY KEY (account_id, timeline_id)
) STRICT, WITHOUT ROWID;

-- AUTOINCREMENT: an event ID is never reused, so a consumer's "after" position stays meaningful.
CREATE TABLE inbox_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  entry_id INTEGER NOT NULL REFERENCES entries (id)
) STRICT;
CREATE INDEX inbox_events_account ON inbox_events (account_id, id);

CREATE TABLE receipts (
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY (account_id, request_id)
) STRICT, WITHOUT ROWID;
`;
