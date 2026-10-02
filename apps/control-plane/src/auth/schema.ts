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
`;
