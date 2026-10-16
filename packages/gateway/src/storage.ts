import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  paired_at INTEGER NOT NULL,
  last_connected_at INTEGER
);
CREATE TABLE IF NOT EXISTS pairing_tokens (
  token_hash TEXT PRIMARY KEY,
  node_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
`;

export function openGatewayDatabase(dataDirectory: string): DatabaseSync {
  const path = `${dataDirectory}/nodes.sqlite`;
  const db = new DatabaseSync(path);
  db.exec(SCHEMA_SQL);

  const row = db.prepare("SELECT value FROM meta WHERE key='user_version'").get() as
    { value: string } | undefined;

  if (row === undefined) {
    db.prepare("INSERT INTO meta(key,value) VALUES('user_version',?)").run(String(SCHEMA_VERSION));
  } else if (Number(row.value) !== SCHEMA_VERSION) {
    throw new Error(
      `nodes.sqlite schema version mismatch: expected ${SCHEMA_VERSION}, got ${row.value}`,
    );
  }

  return db;
}

export function createPairingToken(
  db: DatabaseSync,
  now: () => number,
  ttlMs: number,
  nodeId?: string,
): { pairingToken: string; expiresAt: string } {
  const createdAt = now();
  const expiresAt = createdAt + ttlMs;
  const token = randomBytes(32).toString("base64url");
  const hash = hashToken(token);
  db.prepare(
    "INSERT INTO pairing_tokens(token_hash,node_id,created_at,expires_at) VALUES(?,?,?,?)",
  ).run(hash, nodeId ?? null, createdAt, expiresAt);
  return { pairingToken: token, expiresAt: new Date(expiresAt).toISOString() };
}

export function consumePairingToken(
  db: DatabaseSync,
  token: string,
  now: () => number,
): { ok: true; nodeId: string | null } | { ok: false } {
  const hash = hashToken(token);
  const row = db
    .prepare("SELECT node_id, expires_at, used FROM pairing_tokens WHERE token_hash=?")
    .get(hash) as { node_id: string | null; expires_at: number; used: number } | undefined;
  if (!row || row.used !== 0 || row.expires_at < now()) return { ok: false };
  db.prepare("UPDATE pairing_tokens SET used=1 WHERE token_hash=?").run(hash);
  return { ok: true, nodeId: row.node_id };
}

export function pairNode(
  db: DatabaseSync,
  nodeId: string,
  publicKey: string,
  now: () => number,
): void {
  db.prepare(
    `INSERT INTO nodes(id,public_key,paired_at) VALUES(?,?,?)
     ON CONFLICT(id) DO UPDATE SET public_key=excluded.public_key`,
  ).run(nodeId, publicKey, now());
}

export function nodePublicKey(db: DatabaseSync, nodeId: string): string | undefined {
  const row = db.prepare("SELECT public_key FROM nodes WHERE id=?").get(nodeId) as
    { public_key: string } | undefined;
  return row?.public_key;
}

export function touchNodeConnection(db: DatabaseSync, nodeId: string, now: () => number): void {
  db.prepare("UPDATE nodes SET last_connected_at=? WHERE id=?").run(now(), nodeId);
}

export function listNodes(db: DatabaseSync): NodeStatus[] {
  const rows = z
    .array(
      z.object({
        id: z.string(),
        last_connected_at: z.number().nullable(),
      }),
    )
    .parse(db.prepare("SELECT id, last_connected_at FROM nodes ORDER BY paired_at, id").all());
  return rows.map((row) => ({
    nodeId: row.id,
    lastConnectedAt:
      row.last_connected_at === null ? null : new Date(row.last_connected_at).toISOString(),
  }));
}

export interface NodeStatus {
  nodeId: string;
  lastConnectedAt: string | null;
}

export function isEd25519PublicKey(pem: string): boolean {
  try {
    const key = createPublicKey(pem);
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

export function verifyEd25519(
  publicKeyPem: string,
  nonce: string,
  signatureBase64url: string,
): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return verify(
      null,
      Buffer.from(nonce, "utf8"),
      key,
      Buffer.from(signatureBase64url, "base64url"),
    );
  } catch {
    return false;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
