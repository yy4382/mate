/** Conversation attachment metadata for the Linux-node release. */
export const workspaceSchemaV14 = `
CREATE TABLE owner_conversation_attachments (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES owner_channels(id),
  storage_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL CHECK(length(filename) BETWEEN 1 AND 255),
  content_type TEXT NOT NULL CHECK(length(content_type) BETWEEN 1 AND 160),
  size INTEGER NOT NULL CHECK(size >= 0),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  uploader_kind TEXT NOT NULL CHECK(uploader_kind IN ('human','agent')),
  uploader_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('uploading','ready','failed')),
  created_at INTEGER NOT NULL,
  CHECK((uploader_kind='human' AND uploader_id='owner') OR uploader_kind='agent')
);
CREATE INDEX owner_conversation_attachments_ready
  ON owner_conversation_attachments(channel_id,state,created_at,id);
`;
