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
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
`;

export function openGatewayDatabase(dataDirectory: string): DatabaseSync {
  const path = `${dataDirectory}/nodes.sqlite`;
  const db = new DatabaseSync(path);
  db.exec(SCHEMA_SQL);

  const row = z
    .object({ value: z.string() })
    .optional()
    .parse(db.prepare("SELECT value FROM meta WHERE key='user_version'").get());

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
): { pairingToken: string; expiresAt: string } {
  const createdAt = now();
  const expiresAt = createdAt + ttlMs;
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO pairing_tokens(token_hash,created_at,expires_at) VALUES(?,?,?)").run(
    hashToken(token),
    createdAt,
    expiresAt,
  );
  return { pairingToken: token, expiresAt: new Date(expiresAt).toISOString() };
}

/**
 * Pair a new node with a pairing token, using the token up. Pairing only ever adds a node: a node ID that is already
 * paired keeps its key, and the token stays unused. Returns false, changing nothing, when the token is unknown, used,
 * or expired, or the node is already paired.
 */
export function pairNode(
  db: DatabaseSync,
  token: string,
  nodeId: string,
  publicKey: string,
  now: () => number,
): boolean {
  const at = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const used = db
      .prepare("UPDATE pairing_tokens SET used=1 WHERE token_hash=? AND used=0 AND expires_at>=?")
      .run(hashToken(token), at);
    const added = db
      .prepare(
        "INSERT INTO nodes(id,public_key,paired_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(nodeId, publicKey, at);
    const paired = used.changes === 1 && added.changes === 1;
    db.exec(paired ? "COMMIT" : "ROLLBACK");
    return paired;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function nodePublicKey(db: DatabaseSync, nodeId: string): string | undefined {
  return z
    .object({ public_key: z.string() })
    .optional()
    .parse(db.prepare("SELECT public_key FROM nodes WHERE id=?").get(nodeId))?.public_key;
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
