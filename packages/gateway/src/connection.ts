import type { Clock } from "@mate/clock";
import {
  GatewayMessageSchema,
  NodeRequestSchema,
  type GatewayError,
  type GatewayMessage,
  type NodeRequest,
} from "@mate/node-protocol";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RawData, WebSocket } from "ws";
import { z } from "zod";
import { unknownResult, type PendingCalls } from "./pending-calls.js";
import {
  consumePairingToken,
  isEd25519PublicKey,
  nodePublicKey,
  pairNode,
  touchNodeConnection,
  verifyEd25519,
} from "./storage.js";

const HANDSHAKE_TIMEOUT_MS = 10_000;
/**
 * The largest message the gateway reads, measured on the serialized frame as it arrives. The WebSocket server enforces
 * it before buffering the rest, and closes the connection with 1009.
 */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

/** Everything the gateway's connection handling shares. One per gateway. */
export interface GatewayContext {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  readonly pending: PendingCalls;
  readonly sessions: WeakMap<WebSocket, NodeSession>;
  /** Authenticated connections, one per node. A node is online exactly when it has an entry here. */
  readonly connected: Map<string, WebSocket>;
  readonly unauthenticated: Set<WebSocket>;
  readonly maxUnauthenticated: number;
  readonly heartbeatTimeoutMs: number;
}

export interface NodeSession {
  readonly nonce: string;
  /** Set once the connection has authenticated or paired; until then the connection is unauthenticated. */
  nodeId: string | undefined;
  lastHeartbeatAt: number;
  /** Aborted when authentication completes, which cancels the handshake timeout. */
  readonly handshake: AbortController;
  /** Aborted when the connection ends, which cancels every timer that belongs to it. */
  readonly ended: AbortController;
}

/** Send a GatewayMessage to a socket; returns false if the socket is not open. */
export function sendGateway(ws: WebSocket, msg: GatewayMessage): boolean {
  if (ws.readyState !== ws.OPEN) return false;
  ws.send(JSON.stringify(GatewayMessageSchema.parse(msg)));
  return true;
}

/**
 * Reject a socket with a gateway.error and close it. The connection ends here, not when the close handshake finishes,
 * so nothing it sends afterwards is read and its node is offline at once.
 */
function rejectSocket(
  ws: WebSocket,
  ctx: GatewayContext,
  requestId: string | undefined,
  code: GatewayError["code"],
  message: string,
): void {
  sendGateway(ws, { type: "gateway.error", requestId, code, message });
  ws.close(1008, message);
  closeNodeSocket(ws, ctx);
}

/** Take a new connection from a node: send the challenge and start the handshake timeout. */
export function acceptNodeSocket(ws: WebSocket, ctx: GatewayContext): void {
  if (ctx.unauthenticated.size >= ctx.maxUnauthenticated) {
    ws.close(1013, "too many unauthenticated connections");
    return;
  }

  const session: NodeSession = {
    nonce: randomBytes(32).toString("base64url"),
    nodeId: undefined,
    lastHeartbeatAt: ctx.clock.now(),
    handshake: new AbortController(),
    ended: new AbortController(),
  };
  ctx.sessions.set(ws, session);
  ctx.unauthenticated.add(ws);

  const handshakeOver = AbortSignal.any([session.handshake.signal, session.ended.signal]);
  void ctx.clock.sleep(HANDSHAKE_TIMEOUT_MS, handshakeOver).then(() => {
    if (!handshakeOver.aborted)
      rejectSocket(ws, ctx, undefined, "malformed_request", "handshake timeout");
  });

  sendGateway(ws, { type: "gateway.challenge", nonce: session.nonce });

  ws.on("message", (data) => {
    try {
      handleMessage(ws, data, ctx);
    } catch {
      rejectSocket(ws, ctx, undefined, "malformed_request", "message handling error");
    }
  });
  ws.on("close", () => closeNodeSocket(ws, ctx));
  ws.on("error", () => {
    // ws error always precedes close; the close handler does the cleanup
  });
}

const requestIdOf = z.object({ requestId: z.string() });

/** Read one message synchronously, so a connection that has ended (no session) never has a message read. */
function handleMessage(ws: WebSocket, data: RawData, ctx: GatewayContext): void {
  const session = ctx.sessions.get(ws);
  if (!session) return;

  let raw: unknown;
  try {
    raw = JSON.parse(messageText(data));
  } catch {
    rejectSocket(ws, ctx, undefined, "malformed_request", "invalid JSON");
    return;
  }

  const parsed = NodeRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const rid = requestIdOf.safeParse(raw);
    rejectSocket(
      ws,
      ctx,
      rid.success ? rid.data.requestId : undefined,
      "malformed_request",
      "invalid message",
    );
    return;
  }

  dispatch(ws, parsed.data, session, ctx);
}

function dispatch(
  ws: WebSocket,
  msg: NodeRequest,
  session: NodeSession,
  ctx: GatewayContext,
): void {
  switch (msg.type) {
    case "node.authenticate":
      return handleAuthenticate(ws, msg, session, ctx);
    case "node.pair":
      return handlePair(ws, msg, session, ctx);
  }
  if (session.nodeId === undefined) {
    rejectSocket(ws, ctx, msg.requestId, "not_authenticated", "not authenticated");
    return;
  }
  switch (msg.type) {
    case "node.ping":
      session.lastHeartbeatAt = ctx.clock.now();
      sendGateway(ws, { type: "gateway.pong", requestId: msg.requestId });
      return;
    case "node.tool.output":
      ctx.pending.receiveOutput(ws, msg.requestId, msg.chunk);
      return;
    case "node.tool.result":
      ctx.pending.receiveResult(ws, msg.requestId, { content: msg.content, isError: msg.isError });
      return;
  }
}

function handleAuthenticate(
  ws: WebSocket,
  msg: Extract<NodeRequest, { type: "node.authenticate" }>,
  session: NodeSession,
  ctx: GatewayContext,
): void {
  if (session.nodeId !== undefined) {
    rejectSocket(ws, ctx, msg.requestId, "invalid_identity", "already authenticated");
    return;
  }
  const pubKey = nodePublicKey(ctx.db, msg.nodeId);
  if (pubKey === undefined) {
    sendGateway(ws, {
      type: "gateway.error",
      requestId: msg.requestId,
      code: "unknown_identity",
      message: "node identity not paired",
    });
    return;
  }
  if (!verifyEd25519(pubKey, session.nonce, msg.signature)) {
    rejectSocket(ws, ctx, msg.requestId, "invalid_identity", "signature verification failed");
    return;
  }
  markConnected(ws, msg.nodeId, session, ctx);
  sendGateway(ws, { type: "gateway.authenticated", requestId: msg.requestId, nodeId: msg.nodeId });
}

function handlePair(
  ws: WebSocket,
  msg: Extract<NodeRequest, { type: "node.pair" }>,
  session: NodeSession,
  ctx: GatewayContext,
): void {
  if (session.nodeId !== undefined) {
    rejectSocket(ws, ctx, msg.requestId, "pairing_rejected", "already authenticated");
    return;
  }
  if (!isEd25519PublicKey(msg.publicKey)) {
    rejectSocket(ws, ctx, msg.requestId, "invalid_identity", "invalid public key");
    return;
  }
  if (!verifyEd25519(msg.publicKey, session.nonce, msg.signature)) {
    rejectSocket(ws, ctx, msg.requestId, "invalid_identity", "signature verification failed");
    return;
  }
  const now = () => ctx.clock.now();
  const consumed = consumePairingToken(ctx.db, msg.pairingToken, now);
  if (!consumed.ok) {
    rejectSocket(ws, ctx, msg.requestId, "pairing_rejected", "pairing token invalid or expired");
    return;
  }
  if (consumed.nodeId !== null && consumed.nodeId !== msg.nodeId) {
    rejectSocket(ws, ctx, msg.requestId, "pairing_rejected", "pairing token not for this node");
    return;
  }
  pairNode(ctx.db, msg.nodeId, msg.publicKey, now);
  markConnected(ws, msg.nodeId, session, ctx);
  sendGateway(ws, { type: "gateway.paired", requestId: msg.requestId, nodeId: msg.nodeId });
}

function markConnected(
  ws: WebSocket,
  nodeId: string,
  session: NodeSession,
  ctx: GatewayContext,
): void {
  session.handshake.abort();
  ctx.unauthenticated.delete(ws);

  // A new connection for the same node displaces the old one, and ends the calls the old one carried.
  const previous = ctx.connected.get(nodeId);
  if (previous !== undefined && previous !== ws) {
    previous.terminate();
    closeNodeSocket(previous, ctx);
  }

  session.nodeId = nodeId;
  session.lastHeartbeatAt = ctx.clock.now();
  ctx.connected.set(nodeId, ws);
  touchNodeConnection(ctx.db, nodeId, () => ctx.clock.now());
  void watchHeartbeat(ws, session, ctx);
}

/**
 * Sleep until the heartbeat deadline, then either go back to sleep (a ping moved the deadline) or end the connection.
 * A connection that stops sending pings, including one whose TCP stream is blackholed, goes offline here.
 */
async function watchHeartbeat(
  ws: WebSocket,
  session: NodeSession,
  ctx: GatewayContext,
): Promise<void> {
  const { signal } = session.ended;
  while (!signal.aborted) {
    const left = session.lastHeartbeatAt + ctx.heartbeatTimeoutMs - ctx.clock.now();
    if (left <= 0) {
      ws.terminate();
      closeNodeSocket(ws, ctx);
      return;
    }
    await ctx.clock.sleep(left, signal);
  }
}

/** Forget a connection and end everything it carried. Safe to call more than once. */
export function closeNodeSocket(ws: WebSocket, ctx: GatewayContext): void {
  const session = ctx.sessions.get(ws);
  if (!session) return;
  ctx.sessions.delete(ws);
  session.ended.abort();
  ctx.unauthenticated.delete(ws);
  if (session.nodeId !== undefined && ctx.connected.get(session.nodeId) === ws) {
    ctx.connected.delete(session.nodeId);
  }
  ctx.pending.settleForSocket(ws, unknownResult);
}

function messageText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}
