import type Database from "better-sqlite3";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import {
  NodeRequestSchema,
  type NodeControlMessage,
  type NodeRequest,
} from "../../nodes/protocol.js";

export const DEFAULT_NODE_PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;

export interface NodeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface SocketSession {
  nonce: string;
  nodeId?: string;
}

export interface NodeSummary {
  id: string;
  online: boolean;
  lastConnectedAt: string | null;
}

export interface NodeDirectoryOptions {
  now?: () => number;
  pairingTokenTtlMs?: number;
}

/** Pairing credentials and durable node identities for this control plane. */
export class NodeDirectory {
  private readonly now: () => number;
  private readonly pairingTokenTtlMs: number;
  private readonly sessions = new WeakMap<NodeSocket, SocketSession>();
  private readonly connected = new Map<string, NodeSocket>();
  private readonly sockets = new Set<NodeSocket>();

  constructor(
    private readonly database: Database.Database,
    options: NodeDirectoryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.pairingTokenTtlMs = options.pairingTokenTtlMs ?? DEFAULT_NODE_PAIRING_TOKEN_TTL_MS;
    if (!Number.isSafeInteger(this.pairingTokenTtlMs) || this.pairingTokenTtlMs < 1)
      throw new Error("Node pairing token lifetime must be a positive integer");
  }

  createPairingToken(): { pairingToken: string; expiresAt: string } {
    const createdAt = this.now();
    const expiresAt = createdAt + this.pairingTokenTtlMs;
    const pairingToken = randomBytes(32).toString("base64url");
    this.database
      .prepare("INSERT INTO node_pairing_tokens(token_hash, created_at, expires_at) VALUES(?,?,?)")
      .run(hashToken(pairingToken), createdAt, expiresAt);
    return { pairingToken, expiresAt: new Date(expiresAt).toISOString() };
  }

  list(): NodeSummary[] {
    const rows = this.database
      .prepare("SELECT id, last_connected_at FROM nodes ORDER BY paired_at, id")
      .all() as Array<{ id: string; last_connected_at: number | null }>;
    return rows.map((row) => ({
      id: row.id,
      online: this.connected.has(row.id),
      lastConnectedAt:
        row.last_connected_at === null ? null : new Date(row.last_connected_at).toISOString(),
    }));
  }

  open(socket: NodeSocket): void {
    const nonce = randomBytes(32).toString("base64url");
    this.sessions.set(socket, { nonce });
    this.sockets.add(socket);
    this.send(socket, { type: "control.challenge", nonce });
  }

  async receive(socket: NodeSocket, messageData: unknown): Promise<void> {
    const session = this.sessions.get(socket);
    if (!session) return this.reject(socket, undefined, "malformed_request", "连接尚未初始化。");

    let parsedMessage: unknown;
    try {
      parsedMessage = JSON.parse(await messageText(messageData));
    } catch {
      return this.reject(socket, undefined, "malformed_request", "请求格式无效。");
    }
    const parsed = NodeRequestSchema.safeParse(parsedMessage);
    if (!parsed.success) {
      const requestId =
        typeof parsedMessage === "object" && parsedMessage !== null && "requestId" in parsedMessage
          ? parsedMessage.requestId
          : undefined;
      return this.reject(
        socket,
        typeof requestId === "string" ? requestId : undefined,
        "malformed_request",
        "请求格式无效。",
      );
    }

    const request = parsed.data;
    if (request.type === "node.authenticate") return this.authenticate(socket, session, request);
    if (request.type === "node.pair") return this.pair(socket, session, request);
    return this.ping(socket, session, request);
  }

  close(socket: NodeSocket): void {
    this.sockets.delete(socket);
    const nodeId = this.sessions.get(socket)?.nodeId;
    if (nodeId && this.connected.get(nodeId) === socket) this.connected.delete(nodeId);
    this.sessions.delete(socket);
  }

  closeAll(): void {
    for (const socket of this.sockets) socket.close(1001, "控制面正在关闭");
    this.sockets.clear();
    this.connected.clear();
  }

  private authenticate(
    socket: NodeSocket,
    session: SocketSession,
    request: Extract<NodeRequest, { type: "node.authenticate" }>,
  ): void {
    if (session.nodeId)
      return this.reject(socket, request.requestId, "invalid_identity", "连接已完成身份验证。");
    const row = this.database
      .prepare("SELECT public_key FROM nodes WHERE id=?")
      .get(request.nodeId) as { public_key: string } | undefined;
    if (!row) {
      this.send(socket, {
        type: "control.error",
        requestId: request.requestId,
        code: "unknown_identity",
        message: "此节点身份尚未配对。",
      });
      return;
    }
    if (!verifySignature(row.public_key, session.nonce, request.signature))
      return this.reject(socket, request.requestId, "invalid_identity", "节点身份验证失败。");

    this.markConnected(socket, session, request.nodeId);
    this.send(socket, {
      type: "control.authenticated",
      requestId: request.requestId,
      nodeId: request.nodeId,
    });
  }

  private pair(
    socket: NodeSocket,
    session: SocketSession,
    request: Extract<NodeRequest, { type: "node.pair" }>,
  ): void {
    if (session.nodeId)
      return this.reject(socket, request.requestId, "pairing_rejected", "配对令牌无效或已使用。");
    if (!verifySignature(request.publicKey, session.nonce, request.signature))
      return this.reject(socket, request.requestId, "invalid_identity", "节点身份验证失败。");

    const now = this.now();
    let paired: boolean;
    try {
      paired = this.database
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
      return this.reject(socket, request.requestId, "pairing_rejected", "配对令牌无效或已使用。");
    }
    if (!paired)
      return this.reject(socket, request.requestId, "pairing_rejected", "配对令牌无效或已使用。");

    this.markConnected(socket, session, request.nodeId);
    this.send(socket, {
      type: "control.paired",
      requestId: request.requestId,
      nodeId: request.nodeId,
    });
  }

  private ping(
    socket: NodeSocket,
    session: SocketSession,
    request: Extract<NodeRequest, { type: "node.ping" }>,
  ): void {
    if (!session.nodeId || this.connected.get(session.nodeId) !== socket)
      return this.reject(socket, request.requestId, "not_authenticated", "节点尚未完成身份验证。");
    this.send(socket, {
      type: "control.pong",
      requestId: request.requestId,
      acceptedAt: this.now(),
    });
  }

  private markConnected(socket: NodeSocket, session: SocketSession, nodeId: string): void {
    const previous = this.connected.get(nodeId);
    if (previous && previous !== socket) {
      const previousSession = this.sessions.get(previous);
      if (previousSession) delete previousSession.nodeId;
      previous.close(4001, "节点在另一连接上完成身份验证");
    }
    session.nodeId = nodeId;
    this.connected.set(nodeId, socket);
    this.database
      .prepare("UPDATE nodes SET last_connected_at=? WHERE id=?")
      .run(this.now(), nodeId);
  }

  private reject(
    socket: NodeSocket,
    requestId: string | undefined,
    code: Extract<NodeControlMessage, { type: "control.error" }>["code"],
    message: string,
  ): void {
    this.send(socket, {
      type: "control.error",
      ...(requestId ? { requestId } : {}),
      code,
      message,
    });
    socket.close(1008, code);
  }

  private send(socket: NodeSocket, message: NodeControlMessage): void {
    socket.send(JSON.stringify(message));
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function verifySignature(publicKeyPem: string, nonce: string, signature: string): boolean {
  try {
    return verify(
      null,
      Buffer.from(nonce, "utf8"),
      createPublicKey(publicKeyPem),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

async function messageText(messageData: unknown): Promise<string> {
  if (typeof messageData === "string") return messageData;
  if (messageData instanceof ArrayBuffer) return Buffer.from(messageData).toString("utf8");
  if (ArrayBuffer.isView(messageData))
    return Buffer.from(messageData.buffer, messageData.byteOffset, messageData.byteLength).toString(
      "utf8",
    );
  if (typeof Blob !== "undefined" && messageData instanceof Blob) return messageData.text();
  throw new Error("Only text node requests are supported");
}
