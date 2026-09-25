export const nodeDirectorySchema = `
CREATE TABLE node_pairing_tokens (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  CHECK(expires_at > created_at)
);
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL UNIQUE,
  paired_at INTEGER NOT NULL,
  last_connected_at INTEGER
);
`;
