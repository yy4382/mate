import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { loadOrCreateNodeIdentity, type NodeIdentity } from "./identity.js";
import { NodeControlMessageSchema, NodeRequestSchema } from "./protocol.js";

const INITIAL_RETRY_MS = 250;
const MAX_RETRY_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

export interface LinuxNodeOptions {
  controlPlaneUrl: string;
  dataDirectory: string;
  pairingToken?: string;
}

class NodeAuthenticationError extends Error {}

export async function runLinuxNode(options: LinuxNodeOptions, signal: AbortSignal): Promise<void> {
  if (typeof WebSocket === "undefined")
    throw new Error("Linux node requires a Node.js version with built-in WebSocket support");

  const socketUrl = toWebSocketUrl(options.controlPlaneUrl);
  const { identity, created } = loadOrCreateNodeIdentity(options.dataDirectory);
  let pairingToken = options.pairingToken;
  if (created && !pairingToken)
    throw new Error("A new Linux node requires MATE_NODE_PAIRING_TOKEN");
  if (pairingToken && (pairingToken.length < 32 || pairingToken.length > 256))
    throw new Error("MATE_NODE_PAIRING_TOKEN is not valid");

  let retryMs = INITIAL_RETRY_MS;
  while (!signal.aborted) {
    try {
      const connected = await connectOnce(
        socketUrl,
        identity,
        () => pairingToken,
        () => {
          pairingToken = undefined;
        },
        signal,
      );
      if (signal.aborted) break;
      retryMs = INITIAL_RETRY_MS;
      if (connected) process.stderr.write("Node WebSocket disconnected; reconnecting.\n");
    } catch (error) {
      if (error instanceof NodeAuthenticationError) throw error;
      if (signal.aborted) break;
      process.stderr.write("Node WebSocket connection failed; retrying.\n");
    }

    if (!signal.aborted) await waitOrAbort(retryMs, signal);
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  }
}

export function toWebSocketUrl(controlPlaneUrl: string): string {
  let url: URL;
  try {
    url = new URL(controlPlaneUrl);
  } catch {
    throw new Error("MATE_CONTROL_PLANE_URL must be an absolute HTTP or HTTPS URL");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error("MATE_CONTROL_PLANE_URL must not contain credentials, a query, or a fragment");
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:")
    throw new Error("MATE_CONTROL_PLANE_URL must use HTTP, HTTPS, WS, or WSS");
  url.pathname = "/api/nodes/connect";
  return url.toString();
}

function connectOnce(
  url: string,
  identity: NodeIdentity,
  getPairingToken: () => string | undefined,
  clearPairingToken: () => void,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  const socket = new WebSocket(url);

  return new Promise<boolean>((resolveConnection, rejectConnection) => {
    let settled = false,
      authenticated = false,
      challenge: string | undefined,
      authenticateRequestId: string | undefined,
      pairRequestId: string | undefined,
      heartbeat: ReturnType<typeof setInterval> | undefined,
      timeout: ReturnType<typeof setTimeout> | undefined;
    const pendingPings = new Set<string>();

    const cleanup = () => {
      if (heartbeat) clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    const resolve = (connected: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveConnection(connected);
    };
    const reject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
        socket.close(4008, "node protocol rejected");
      rejectConnection(error);
    };
    const sendPing = () => {
      if (!authenticated || socket.readyState !== WebSocket.OPEN) return;
      const requestId = randomUUID();
      pendingPings.add(requestId);
      sendRequest(socket, { type: "node.ping", requestId, sentAt: Date.now() });
    };
    const authenticate = (nonce: string) => {
      authenticateRequestId = randomUUID();
      sendRequest(socket, {
        type: "node.authenticate",
        requestId: authenticateRequestId,
        nodeId: identity.id,
        signature: signChallenge(identity, nonce),
      });
    };
    const pair = (nonce: string) => {
      const pairingToken = getPairingToken();
      if (!pairingToken)
        return reject(new NodeAuthenticationError("此节点身份尚未配对，且没有可用的配对令牌。"));
      pairRequestId = randomUUID();
      sendRequest(socket, {
        type: "node.pair",
        requestId: pairRequestId,
        nodeId: identity.id,
        pairingToken,
        publicKey: identity.publicKey,
        signature: signChallenge(identity, nonce),
      });
    };
    const onAbort = () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
        socket.close(1000, "node shutting down");
      resolve(false);
    };
    const onError = () => {
      // Browsers and Node expose no useful WebSocket error detail; the close event drives retry.
    };
    const onClose = () => {
      if (authenticated) resolve(true);
      else reject(new Error("Node WebSocket closed before identity was verified"));
    };
    const onMessage = (event: MessageEvent) => {
      void handleMessage(event.data).catch((error: unknown) => {
        reject(error instanceof Error ? error : new Error("Invalid control-plane response"));
      });
    };
    const handleMessage = async (data: unknown): Promise<void> => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(await messageText(data));
      } catch {
        throw new NodeAuthenticationError("控制面发来了无效的节点协议消息。");
      }
      const parsed = NodeControlMessageSchema.safeParse(decoded);
      if (!parsed.success) throw new NodeAuthenticationError("控制面发来了无效的节点协议消息。");
      const message = parsed.data;
      if (message.type === "control.challenge") {
        if (challenge) throw new NodeAuthenticationError("控制面重复发送了节点身份质询。");
        challenge = message.nonce;
        authenticate(message.nonce);
        return;
      }
      if (message.type === "control.error") {
        if (message.code === "unknown_identity" && message.requestId === authenticateRequestId) {
          pair(challenge!);
          return;
        }
        if (message.code === "unknown_identity" || message.code === "pairing_rejected")
          throw new NodeAuthenticationError("配对令牌无效、已过期或已使用。");
        if (message.code === "invalid_identity")
          throw new NodeAuthenticationError("控制面拒绝了此节点身份。");
        throw new NodeAuthenticationError("控制面拒绝了节点协议请求。");
      }
      if (message.type === "control.paired") {
        if (message.requestId !== pairRequestId || message.nodeId !== identity.id)
          throw new NodeAuthenticationError("控制面返回了不匹配的节点配对确认。");
        if (timeout) clearTimeout(timeout);
        timeout = undefined;
        clearPairingToken();
        authenticated = true;
        process.stdout.write(`MATE_NODE_PAIRED ${identity.id}\n`);
        sendPing();
        heartbeat = setInterval(sendPing, HEARTBEAT_INTERVAL_MS);
        return;
      }
      if (message.type === "control.authenticated") {
        if (message.requestId !== authenticateRequestId || message.nodeId !== identity.id)
          throw new NodeAuthenticationError("控制面返回了不匹配的节点身份确认。");
        if (timeout) clearTimeout(timeout);
        timeout = undefined;
        authenticated = true;
        process.stdout.write(`MATE_NODE_CONNECTED ${identity.id}\n`);
        sendPing();
        heartbeat = setInterval(sendPing, HEARTBEAT_INTERVAL_MS);
        return;
      }
      if (message.type === "control.pong" && pendingPings.delete(message.requestId))
        process.stdout.write(`MATE_NODE_HEARTBEAT_ACK ${message.requestId}\n`);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
    socket.addEventListener("error", onError);
    timeout = setTimeout(
      () => reject(new Error("Node WebSocket handshake timed out")),
      HANDSHAKE_TIMEOUT_MS,
    );
  });
}

function sendRequest(socket: WebSocket, request: unknown): void {
  socket.send(JSON.stringify(NodeRequestSchema.parse(request)));
}

function signChallenge(identity: NodeIdentity, nonce: string): string {
  return sign(null, Buffer.from(nonce, "utf8"), createPrivateKey(identity.privateKey)).toString(
    "base64url",
  );
}

async function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data))
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  throw new Error("Only text control-plane messages are supported");
}

function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveWait) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolveWait();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolveWait();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
