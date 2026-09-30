export const ownerAuthSchema = `
CREATE TABLE owner_credentials (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  password_hash TEXT NOT NULL CHECK(password_hash LIKE '$argon2id$%'),
  created_at INTEGER NOT NULL
);
CREATE TABLE owner_sessions (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK(expires_at > created_at)
);
CREATE INDEX owner_sessions_expiry ON owner_sessions(expires_at);

CREATE TABLE owner_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('public','private')),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX owner_channels_order ON owner_channels(archived,created_at,id);
-- Membership writers and message delivery snapshotting share this transactional fact table.
CREATE TABLE owner_channel_memberships (
  channel_id TEXT NOT NULL REFERENCES owner_channels(id),
  principal_kind TEXT NOT NULL CHECK(principal_kind IN ('human','agent')),
  principal_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(channel_id,principal_kind,principal_id)
);
CREATE INDEX owner_channel_memberships_active ON owner_channel_memberships(channel_id,active,principal_kind,principal_id);
CREATE TABLE owner_messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES owner_channels(id),
  order_seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  author_kind TEXT NOT NULL DEFAULT 'human' CHECK(author_kind IN ('human','agent')),
  author_id TEXT NOT NULL DEFAULT 'owner',
  root_id TEXT REFERENCES owner_messages(id),
  quote_id TEXT REFERENCES owner_messages(id),
  internal_kind TEXT,
  UNIQUE(channel_id,order_seq)
);
CREATE TABLE owner_message_deliveries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL REFERENCES owner_messages(id),
  channel_id TEXT NOT NULL,
  recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('human','agent')),
  recipient_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','handled')),
  created_at INTEGER NOT NULL,
  handled_at INTEGER,
  UNIQUE(message_id,recipient_kind,recipient_id),
  FOREIGN KEY(channel_id,recipient_kind,recipient_id)
    REFERENCES owner_channel_memberships(channel_id,principal_kind,principal_id)
);
CREATE INDEX owner_message_deliveries_pending ON owner_message_deliveries(recipient_kind,recipient_id,state,seq);
CREATE TABLE owner_chat_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES owner_channels(id),
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;
