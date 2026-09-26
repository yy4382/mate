/** File access audit records contain identity and relative paths only, never file bytes. */
export const workspaceAccessAuditSchemaV15 = `
CREATE TABLE owner_workspace_access_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('owner','agent')),
  actor_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT,
  operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 64),
  relative_paths TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('started','succeeded','failed','cancelled')),
  download_id TEXT UNIQUE,
  owner_session_hash TEXT,
  download_expires_at INTEGER,
  completed_at INTEGER,
  error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 64)
);
CREATE INDEX owner_workspace_access_audit_agent
  ON owner_workspace_access_audit(agent_id,at DESC);
CREATE INDEX owner_workspace_access_audit_actor
  ON owner_workspace_access_audit(actor_kind,actor_id,at DESC);
`;
