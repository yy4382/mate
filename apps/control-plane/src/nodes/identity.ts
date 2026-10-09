import type { AgentWorkspaceIdentity, NodeRequest } from "@mate/protocol";
import type Database from "better-sqlite3";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { z } from "zod";
/** The one ordinary Linux account a paired node runs every one of its Agents under. */
export type NodeAccount = Pick<AgentWorkspaceIdentity, "username" | "uid" | "gid">;

/** A node reported an account that is not the one its Agents already run under. */
export class NodeAccountConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeAccountConflict";
  }
}

/**
 * A complete account read from node columns, or undefined while the node has not completed a
 * preparation yet. Rows read through a LEFT JOIN carry all three columns as nullable, so this is
 * the one place that decides whether a partial row counts as an account at all.
 */
export function nodeAccountOf(row: {
  linux_username: string | null;
  uid: number | null;
  gid: number | null;
}): NodeAccount | undefined {
  if (row.linux_username === null || row.uid === null || row.gid === null) return undefined;
  return { username: row.linux_username, uid: row.uid, gid: row.gid };
}

export class NodeIdentity {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => number,
    private readonly pairingTokenTtlMs: number,
  ) {}
  createPairingToken(): { pairingToken: string; expiresAt: string } {
    const createdAt = this.now();
    const expiresAt = createdAt + this.pairingTokenTtlMs;
    const pairingToken = randomBytes(32).toString("base64url");
    this.database
      .prepare("INSERT INTO node_pairing_tokens(token_hash, created_at, expires_at) VALUES(?,?,?)")
      .run(hashToken(pairingToken), createdAt, expiresAt);
    return { pairingToken, expiresAt: new Date(expiresAt).toISOString() };
  }
  /** The node account is absent until its first successful workspace preparation. */
  account(nodeId: string): NodeAccount | undefined {
    const row = z
      .looseObject({ linux_username: z.string(), uid: z.number(), gid: z.number() })
      .optional()
      .parse(
        this.database
          .prepare(
            "SELECT linux_username,uid,gid FROM nodes WHERE id=? AND linux_username IS NOT NULL AND uid IS NOT NULL AND gid IS NOT NULL",
          )
          .get(nodeId),
      );
    return row ? { username: row.linux_username, uid: row.uid, gid: row.gid } : undefined;
  }
  /** Record or match the node account inside the caller's workspace-preparation transaction. */
  recordAccount(nodeId: string, account: NodeAccount): void {
    const recorded = this.database
      .prepare(
        `UPDATE nodes SET linux_username=?,uid=?,gid=?
         WHERE id=? AND (linux_username IS NULL OR (linux_username=? AND uid=? AND gid=?))`,
      )
      .run(
        account.username,
        account.uid,
        account.gid,
        nodeId,
        account.username,
        account.uid,
        account.gid,
      );
    if (recorded.changes === 1) return;
    if (!this.database.prepare("SELECT 1 FROM nodes WHERE id=?").get(nodeId))
      throw new NodeAccountConflict("节点尚未配对，无法记录它运行 Agent 的账号。");
    throw new NodeAccountConflict(
      "同一节点上的 Agent 必须共用该节点运行账号；节点返回了不同账号，请检查节点部署。",
    );
  }
  publicKey(nodeId: string): string | undefined {
    return z
      .looseObject({ public_key: z.string() })
      .optional()
      .parse(this.database.prepare("SELECT public_key FROM nodes WHERE id=?").get(nodeId))
      ?.public_key;
  }
  pair(request: Extract<NodeRequest, { type: "node.pair" }>): boolean {
    const now = this.now();
    try {
      return this.database
        .transaction(() => {
          const result = this.database
            .prepare(
              "UPDATE node_pairing_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?",
            )
            .run(now, hashToken(request.pairingToken), now);
          if (result.changes !== 1) return false;
          this.database
            .prepare("INSERT INTO nodes(id,public_key,paired_at,last_connected_at) VALUES(?,?,?,?)")
            .run(request.nodeId, request.publicKey, now, now);
          return true;
        })
        .immediate();
    } catch {
      return false;
    }
  }
}
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isEd25519PublicKey(publicKeyPem: string): boolean {
  try {
    return createPublicKey(publicKeyPem).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

export function verifySignature(publicKeyPem: string, nonce: string, signature: string): boolean {
  try {
    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") return false;
    return verify(null, Buffer.from(nonce, "utf8"), publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}
