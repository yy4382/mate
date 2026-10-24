import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openControlTables, type ControlTables } from "@mate/control-store";
import { Migrations } from "@mate/migrations";
import { NodeSystemSchema, type NodeSystem } from "@mate/node-protocol";
import { z } from "zod";
import { GatewayError } from "./gateway-error.ts";

const NodeNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);

const GATEWAY_TABLES: ControlTables = {
  module: "gateway",
  migrations: new Migrations([
    {
      version: 1,
      sql: `
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  paired_at INTEGER NOT NULL,
  last_connected_at INTEGER
);
CREATE TABLE pairing_tokens (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
`,
    },
    {
      version: 2,
      sql: `
CREATE TABLE nodes_next (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  paired_at INTEGER NOT NULL,
  last_connected_at INTEGER,
  name TEXT NOT NULL UNIQUE,
  system_json TEXT,
  reported_at INTEGER,
  CHECK ((system_json IS NULL) = (reported_at IS NULL))
);
INSERT INTO nodes_next (id, public_key, paired_at, last_connected_at, name)
SELECT id, public_key, paired_at, last_connected_at,
  'node-' || lower(substr(id, 1, 8)) || CASE WHEN ordinal = 1 THEN '' ELSE '-' || ordinal END
FROM (
  SELECT *, row_number() OVER (PARTITION BY lower(substr(id, 1, 8)) ORDER BY id) AS ordinal
  FROM nodes
);
DROP TABLE nodes;
ALTER TABLE nodes_next RENAME TO nodes;
`,
    },
  ]),
};

/** The gateway's own connection to the control store, holding the node registry and pairing tokens. */
export function openGatewayDatabase(dataDirectory: string): DatabaseSync {
  return openControlTables(dataDirectory, GATEWAY_TABLES);
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
  system: NodeSystem | undefined,
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
        `INSERT INTO nodes(id, public_key, paired_at, last_connected_at, name, system_json, reported_at)
         VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        nodeId,
        publicKey,
        at,
        at,
        availableName(db, system?.hostname ?? "", nodeId),
        system === undefined ? null : JSON.stringify(system),
        system === undefined ? null : at,
      );
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

export function recordNodeConnection(
  db: DatabaseSync,
  nodeId: string,
  system: NodeSystem | undefined,
  now: () => number,
): void {
  const at = now();
  if (system === undefined) {
    db.prepare("UPDATE nodes SET last_connected_at=? WHERE id=?").run(at, nodeId);
  } else {
    db.prepare("UPDATE nodes SET last_connected_at=?, system_json=?, reported_at=? WHERE id=?").run(
      at,
      JSON.stringify(system),
      at,
      nodeId,
    );
  }
}

export function renameNode(db: DatabaseSync, nodeId: string, name: string): void {
  if (!NodeNameSchema.safeParse(name).success) {
    throw new GatewayError(
      "invalid-input",
      "a node name must be 1 to 32 lowercase letters, digits or hyphens, starting with a letter or digit",
    );
  }
  const owner = db.prepare("SELECT id FROM nodes WHERE name=?").get(name);
  if (owner !== undefined && owner.id !== nodeId)
    throw new GatewayError("name-taken", `node name ${name} is already taken`);
  const updated = db.prepare("UPDATE nodes SET name=? WHERE id=?").run(name, nodeId);
  if (updated.changes === 0) throw new GatewayError("unknown-node", `no paired node ${nodeId}`);
}

function availableName(db: DatabaseSync, hostname: string, nodeId: string): string {
  const hostnameName = hostname
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+/, "")
    .slice(0, 32);
  const base = hostnameName || `node-${nodeId.slice(0, 8).toLowerCase()}`;
  let name = base;
  let ordinal = 2;
  const exists = db.prepare("SELECT id FROM nodes WHERE name=?");
  while (exists.get(name) !== undefined) {
    const suffix = `-${ordinal}`;
    name = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    ordinal += 1;
  }
  return name;
}

export function listNodes(db: DatabaseSync): NodeStatus[] {
  const rows = z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        last_connected_at: z.number().nullable(),
        system_json: z.string().nullable(),
      }),
    )
    .parse(
      db
        .prepare(
          "SELECT id, name, last_connected_at, system_json FROM nodes ORDER BY paired_at, id",
        )
        .all(),
    );
  return rows.map((row) => ({
    nodeId: row.id,
    name: row.name,
    lastConnectedAt:
      row.last_connected_at === null ? null : new Date(row.last_connected_at).toISOString(),
    system: row.system_json === null ? null : NodeSystemSchema.parse(JSON.parse(row.system_json)),
  }));
}

export interface NodeStatus {
  nodeId: string;
  name: string;
  lastConnectedAt: string | null;
  system: NodeSystem | null;
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
