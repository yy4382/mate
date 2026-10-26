import type { Clock } from "@mate/clock";
import {
  GatewayMessageSchema,
  NodeAuthenticateSchema,
  NodePairSchema,
  NodeRequestSchema,
  type GatewayError,
  type GatewayMessage,
  type GatewayRefused,
  type ToolResult,
} from "@mate/node-protocol";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RawData, WebSocket } from "ws";
import { z } from "zod";
import {
  browseOffline,
  unknownResult,
  type BrowseOutcome,
  type PendingCalls,
} from "./pending-calls.ts";
import {
  isEd25519PublicKey,
  nodePublicKey,
  pairNode,
  recordNodeConnection,
  verifyEd25519,
} from "./storage.ts";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const ReceivedNodeRequestSchema = z.union([
  NodeRequestSchema,
  NodeAuthenticateSchema.partial({ system: true }),
  NodePairSchema.partial({ system: true }),
]);
type ReceivedNodeRequest = z.infer<typeof ReceivedNodeRequestSchema>;
/**
 * The largest message the gateway reads, measured on the serialized frame as it arrives. The WebSocket server enforces
 * it before buffering the rest, and closes the connection with 1009.
 */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

/** Everything the gateway's connection handling shares. One per gateway. */
export interface GatewayContext {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  readonly pending: PendingCalls<ToolResult>;
  readonly browsing: PendingCalls<BrowseOutcome>;
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
  workspaceVisits: boolean;
  shellContext: boolean;
  platform: string | undefined;
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
 * Tell the node why and close its connection: a refusal of who it is, or an error in how it used the connection. The
 * connection ends here, not when the close handshake finishes, so nothing it sends afterwards is read and its node is
 * offline at once.
 */
function rejectSocket(
  ws: WebSocket,
  ctx: GatewayContext,
  reason: GatewayRefused | GatewayError,
): void {
  sendGateway(ws, reason);
  ws.close(1008, reason.message);
  closeNodeSocket(ws, ctx);
}

function protocolError(
  code: GatewayError["code"],
  message: string,
  requestId?: string,
): GatewayError {
  return {
    type: "gateway.error",
    code,
    message,
    ...(requestId === undefined ? {} : { requestId }),
  };
}

function refusal(code: GatewayRefused["code"], message: string, requestId: string): GatewayRefused {
  return { type: "gateway.refused", requestId, code, message };
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
    workspaceVisits: false,
    shellContext: false,
    platform: undefined,
    lastHeartbeatAt: ctx.clock.now(),
    handshake: new AbortController(),
    ended: new AbortController(),
  };
  ctx.sessions.set(ws, session);
  ctx.unauthenticated.add(ws);

  const handshakeOver = AbortSignal.any([session.handshake.signal, session.ended.signal]);
  void ctx.clock.sleep(HANDSHAKE_TIMEOUT_MS, handshakeOver).then(() => {
    if (!handshakeOver.aborted)
      rejectSocket(ws, ctx, protocolError("handshake_timeout", "handshake timeout"));
  });

  sendGateway(ws, { type: "gateway.challenge", nonce: session.nonce });

  ws.on("message", (data) => {
    try {
      handleMessage(ws, data, ctx);
    } catch {
      rejectSocket(ws, ctx, protocolError("internal_error", "message handling error"));
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
    rejectSocket(ws, ctx, protocolError("malformed_request", "invalid JSON"));
    return;
  }

  const parsed = ReceivedNodeRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const rid = requestIdOf.safeParse(raw);
    rejectSocket(
      ws,
      ctx,
      protocolError(
        "malformed_request",
        "invalid message",
        rid.success ? rid.data.requestId : undefined,
      ),
    );
    return;
  }

  dispatch(ws, parsed.data, session, ctx);
}

function dispatch(
  ws: WebSocket,
  msg: ReceivedNodeRequest,
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
    rejectSocket(ws, ctx, protocolError("not_authenticated", "not authenticated", msg.requestId));
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
    case "node.browse.result":
      ctx.browsing.receiveResult(ws, msg.requestId, msg.outcome);
      return;
  }
}

function handleAuthenticate(
  ws: WebSocket,
  msg: Extract<ReceivedNodeRequest, { type: "node.authenticate" }>,
  session: NodeSession,
  ctx: GatewayContext,
): void {
  if (session.nodeId !== undefined) {
    rejectSocket(
      ws,
      ctx,
      protocolError("already_authenticated", "already authenticated", msg.requestId),
    );
    return;
  }
  const pubKey = nodePublicKey(ctx.db, msg.nodeId);
  if (pubKey === undefined) {
    sendGateway(ws, refusal("unknown_identity", "node identity not paired", msg.requestId));
    return;
  }
  if (!verifyEd25519(pubKey, session.nonce, msg.signature)) {
    rejectSocket(
      ws,
      ctx,
      refusal("invalid_identity", "signature verification failed", msg.requestId),
    );
    return;
  }
  recordNodeConnection(ctx.db, msg.nodeId, msg.system, () => ctx.clock.now());
  session.workspaceVisits = msg.workspaceVisits === true;
  session.shellContext = msg.shellContext === true;
  session.platform = msg.system?.platform;
  markConnected(ws, msg.nodeId, session, ctx);
  sendGateway(ws, { type: "gateway.authenticated", requestId: msg.requestId, nodeId: msg.nodeId });
}

function handlePair(
  ws: WebSocket,
  msg: Extract<ReceivedNodeRequest, { type: "node.pair" }>,
  session: NodeSession,
  ctx: GatewayContext,
): void {
  if (session.nodeId !== undefined) {
    rejectSocket(
      ws,
      ctx,
      protocolError("already_authenticated", "already authenticated", msg.requestId),
    );
    return;
  }
  if (!isEd25519PublicKey(msg.publicKey)) {
    rejectSocket(ws, ctx, refusal("invalid_identity", "invalid public key", msg.requestId));
    return;
  }
  if (!verifyEd25519(msg.publicKey, session.nonce, msg.signature)) {
    rejectSocket(
      ws,
      ctx,
      refusal("invalid_identity", "signature verification failed", msg.requestId),
    );
    return;
  }
  if (
    !pairNode(ctx.db, msg.pairingToken, msg.nodeId, msg.publicKey, msg.system, () =>
      ctx.clock.now(),
    )
  ) {
    rejectSocket(
      ws,
      ctx,
      refusal(
        "pairing_rejected",
        "pairing token invalid or expired, or the node is already paired",
        msg.requestId,
      ),
    );
    return;
  }
  session.workspaceVisits = msg.workspaceVisits === true;
  session.shellContext = msg.shellContext === true;
  session.platform = msg.system?.platform;
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
  ctx.browsing.settleForSocket(ws, () =>
    browseOffline("Node offline: the node connection was lost before it answered."),
  );
}

function messageText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}
