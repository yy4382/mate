import { Migrations } from "@mate/migrations";

/**
 * The chat database schema as an ascending list of migrations (ARCHITECTURE section 6). A new store runs all of them;
 * an existing store runs the ones after its `user_version`. Versions 1 and 2 never shipped, so a store stamped with
 * either is refused.
 */
export const CHAT_MIGRATIONS = new Migrations([
  {
    version: 3,
    sql: `
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

-- The owner's Web Push subscriptions. Pushes only ever go to the owner, so a subscription names no account.
-- AUTOINCREMENT: an answer arriving for a deleted subscription must never land on a newer one that reused its ID.
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL
) STRICT;

-- The push queue: one pending delivery of one message's push to one subscription.
CREATE TABLE push_deliveries (
  entry_id INTEGER NOT NULL REFERENCES entries (id),
  subscription_id INTEGER NOT NULL REFERENCES push_subscriptions (id) ON DELETE CASCADE,
  failures INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  PRIMARY KEY (entry_id, subscription_id)
) STRICT, WITHOUT ROWID;

-- The live event log the owner's browser follows. The triggers below append to it in the transaction that changes
-- the fact, so no write path can change what the browser shows without telling it. An event names its subject only;
-- its payload is read from the subject when the event is served. Its time comes from the chat app's clock through
-- chat_now(), which the chat app registers on its own connection, and decides how long it is kept. Another connection
-- (the sqlite3 shell, a test's raw connection) therefore cannot write the tables these triggers watch.
CREATE TABLE live_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('entry', 'conversation', 'account', 'read')),
  subject INTEGER NOT NULL
) STRICT;

-- The epoch is drawn once, when the store is created, so a cursor from a store that was reset names another epoch.
-- Every event up to pruned_through has been deleted.
CREATE TABLE live_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch TEXT NOT NULL,
  pruned_through INTEGER NOT NULL
) STRICT;
INSERT INTO live_state (id, epoch, pruned_through) VALUES (1, lower(hex(randomblob(16))), 0);

CREATE TRIGGER live_entry AFTER INSERT ON entries BEGIN
  INSERT INTO live_events (at, kind, subject) VALUES (chat_now(), 'entry', NEW.id);
END;
CREATE TRIGGER live_conversation_created AFTER INSERT ON conversations BEGIN
  INSERT INTO live_events (at, kind, subject) VALUES (chat_now(), 'conversation', NEW.id);
END;
CREATE TRIGGER live_conversation_changed AFTER UPDATE ON conversations BEGIN
  INSERT INTO live_events (at, kind, subject) VALUES (chat_now(), 'conversation', NEW.id);
END;
CREATE TRIGGER live_member_added AFTER INSERT ON memberships BEGIN
  INSERT INTO live_events (at, kind, subject) VALUES (chat_now(), 'conversation', NEW.conversation_id);
END;
CREATE TRIGGER live_member_removed AFTER DELETE ON memberships BEGIN
  INSERT INTO live_events (at, kind, subject) VALUES (chat_now(), 'conversation', OLD.conversation_id);
END;
CREATE TRIGGER live_account_created AFTER INSERT ON accounts BEGIN
  INSERT INTO live_events (at, kind, subject) VALUES (chat_now(), 'account', NEW.id);
END;
CREATE TRIGGER live_account_changed AFTER UPDATE ON accounts
  WHEN (NEW.display_name, NEW.handle, NEW.active) IS NOT (OLD.display_name, OLD.handle, OLD.active) BEGIN
  INSERT INTO live_events (at, kind, subject) VALUES (chat_now(), 'account', NEW.id);
END;
-- Only the owner's read positions are part of the owner's view.
CREATE TRIGGER live_owner_read_started AFTER INSERT ON read_positions
  WHEN NEW.account_id = (SELECT id FROM accounts WHERE role = 'owner') BEGIN
  INSERT INTO live_events (at, kind, subject) VALUES (chat_now(), 'read', NEW.timeline_id);
END;
CREATE TRIGGER live_owner_read_moved AFTER UPDATE ON read_positions
  WHEN NEW.seq > OLD.seq AND NEW.account_id = (SELECT id FROM accounts WHERE role = 'owner') BEGIN
  INSERT INTO live_events (at, kind, subject) VALUES (chat_now(), 'read', NEW.timeline_id);
END;

-- Who may read a conversation: the owner reads every one, anyone reads a public channel, members read the rest.
-- Every visibility test selects from this view, so the rule has one definition.
CREATE VIEW readable_conversations (account_id, conversation_id) AS
  SELECT a.id, c.id FROM accounts a CROSS JOIN conversations c
  WHERE a.role = 'owner' OR c.kind = 'public'
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.conversation_id = c.id AND m.account_id = a.id);

-- The timelines an account follows: the top level of every conversation it is a member of, and every thread it can
-- read whose root it wrote, in which it replied, or in which it was mentioned. A new message notifies the followers
-- of its timeline, and the unread summary lists the followed timelines, so the two cannot disagree.
CREATE VIEW followed_timelines (account_id, timeline_id) AS
  SELECT m.account_id, t.id FROM timelines t
  JOIN memberships m ON m.conversation_id = t.conversation_id
  WHERE t.root_entry_id IS NULL
  UNION
  SELECT p.account_id, p.timeline_id FROM (
    SELECT t.id AS timeline_id, r.author_id AS account_id FROM timelines t JOIN entries r ON r.id = t.root_entry_id
    UNION SELECT e.timeline_id, e.author_id FROM entries e WHERE e.kind = 'message'
    UNION SELECT e.timeline_id, mn.account_id FROM entries e JOIN mentions mn ON mn.entry_id = e.id
  ) p
  JOIN timelines t ON t.id = p.timeline_id AND t.root_entry_id IS NOT NULL
  JOIN readable_conversations rc ON rc.account_id = p.account_id AND rc.conversation_id = t.conversation_id;
`,
  },
  {
    version: 4,
    sql: `
-- Accounts are humans or Agents. The one owner of version 3 becomes a human and every member an Agent. SQLite cannot
-- change a CHECK constraint or drop a column that an index covers, so accounts is rebuilt (the 12-step procedure,
-- with foreign keys off, which database.ts guarantees). What reads accounts and is not rebuilt goes first and is
-- recreated after: the views and the triggers that name accounts. The triggers on accounts go with the table.
DROP VIEW followed_timelines;
DROP VIEW readable_conversations;
DROP TRIGGER live_owner_read_started;
DROP TRIGGER live_owner_read_moved;

CREATE TABLE accounts_v4 (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  handle TEXT NOT NULL,
  handle_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
) STRICT;
INSERT INTO accounts_v4 (id, external_id, display_name, handle, handle_key, kind, active)
  SELECT id, external_id, display_name, handle, handle_key,
         CASE role WHEN 'owner' THEN 'human' ELSE 'agent' END, active
  FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_v4 RENAME TO accounts;

CREATE TRIGGER live_account_created AFTER INSERT ON accounts BEGIN
  INSERT INTO live_events (at, kind, subject) VALUES (chat_now(), 'account', NEW.id);
END;
CREATE TRIGGER live_account_changed AFTER UPDATE ON accounts
  WHEN (NEW.display_name, NEW.handle, NEW.active) IS NOT (OLD.display_name, OLD.handle, OLD.active) BEGIN
  INSERT INTO live_events (at, kind, subject) VALUES (chat_now(), 'account', NEW.id);
END;

-- A live event is for every human (audience NULL) or for one account. A human's read position is that human's own.
-- Until now only the owner's read positions were logged, so every logged read is the one human's.
ALTER TABLE live_events ADD COLUMN audience INTEGER REFERENCES accounts (id);
UPDATE live_events SET audience = (SELECT id FROM accounts WHERE kind = 'human') WHERE kind = 'read';
CREATE TRIGGER live_read_started AFTER INSERT ON read_positions
  WHEN (SELECT kind FROM accounts WHERE id = NEW.account_id) = 'human' BEGIN
  INSERT INTO live_events (at, kind, subject, audience)
    VALUES (chat_now(), 'read', NEW.timeline_id, NEW.account_id);
END;
CREATE TRIGGER live_read_moved AFTER UPDATE ON read_positions
  WHEN NEW.seq > OLD.seq AND (SELECT kind FROM accounts WHERE id = NEW.account_id) = 'human' BEGIN
  INSERT INTO live_events (at, kind, subject, audience)
    VALUES (chat_now(), 'read', NEW.timeline_id, NEW.account_id);
END;

-- A human reads every conversation, anyone reads a public channel, members read the rest.
CREATE VIEW readable_conversations (account_id, conversation_id) AS
  SELECT a.id, c.id FROM accounts a CROSS JOIN conversations c
  WHERE a.kind = 'human' OR c.kind = 'public'
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.conversation_id = c.id AND m.account_id = a.id);

CREATE VIEW followed_timelines (account_id, timeline_id) AS
  SELECT m.account_id, t.id FROM timelines t
  JOIN memberships m ON m.conversation_id = t.conversation_id
  WHERE t.root_entry_id IS NULL
  UNION
  SELECT p.account_id, p.timeline_id FROM (
    SELECT t.id AS timeline_id, r.author_id AS account_id FROM timelines t JOIN entries r ON r.id = t.root_entry_id
    UNION SELECT e.timeline_id, e.author_id FROM entries e WHERE e.kind = 'message'
    UNION SELECT e.timeline_id, mn.account_id FROM entries e JOIN mentions mn ON mn.entry_id = e.id
  ) p
  JOIN timelines t ON t.id = p.timeline_id AND t.root_entry_id IS NOT NULL
  JOIN readable_conversations rc ON rc.account_id = p.account_id AND rc.conversation_id = t.conversation_id;

-- A Web Push subscription belongs to the human who subscribed. The existing ones are the owner's. The rebuild keeps
-- each ID and the AUTOINCREMENT counter, so an answer for a deleted subscription still cannot land on a newer one.
CREATE TABLE push_subscriptions_v4 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL
) STRICT;
INSERT INTO push_subscriptions_v4 (id, account_id, endpoint, p256dh, auth)
  SELECT id, (SELECT id FROM accounts WHERE kind = 'human'), endpoint, p256dh, auth FROM push_subscriptions;
DELETE FROM sqlite_sequence WHERE name = 'push_subscriptions_v4';
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'push_subscriptions_v4', seq FROM sqlite_sequence WHERE name = 'push_subscriptions';
DROP TABLE push_subscriptions;
ALTER TABLE push_subscriptions_v4 RENAME TO push_subscriptions;
CREATE INDEX push_subscriptions_account ON push_subscriptions (account_id);
`,
  },
  {
    version: 5,
    sql: `
CREATE TABLE push_subscriptions_v5 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  subscription_key TEXT NOT NULL UNIQUE,
  subscription_json TEXT NOT NULL CHECK (json_valid(subscription_json))
) STRICT;
INSERT INTO push_subscriptions_v5 (id, account_id, subscription_key, subscription_json)
  SELECT id, account_id, json_array('web', endpoint),
    json_object('endpoint', endpoint, 'keys', json_object('p256dh', p256dh, 'auth', auth))
  FROM push_subscriptions;
DELETE FROM sqlite_sequence WHERE name = 'push_subscriptions_v5';
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'push_subscriptions_v5', seq FROM sqlite_sequence WHERE name = 'push_subscriptions';
DROP TABLE push_subscriptions;
ALTER TABLE push_subscriptions_v5 RENAME TO push_subscriptions;
CREATE INDEX push_subscriptions_account ON push_subscriptions (account_id);
`,
  },
]);
