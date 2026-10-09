import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { statSync } from "node:fs";

import {
  connect as connectTcp,
  createServer as createTcpServer,
  type Socket as TcpSocket,
} from "node:net";

import { type RawData } from "ws";
import { delay } from "./process-output.js";

export const ownerPassword = "node-process-owner-password-used-only-by-this-test";
export const observedCloses = new WeakMap<WebSocket, CloseEvent>();
export function observedWebSocket(url: string | URL): WebSocket {
  const socket = new WebSocket(url);
  socket.addEventListener("close", (event) => observedCloses.set(socket, event), { once: true });
  return socket;
}
/** Durable node state is written by the node process itself, so its owner is the node's account. */
export function fileOwnerUid(path: string): number {
  return statSync(path).uid;
}
export async function startUnresponsiveWebSocketEndpoint(): Promise<{
  port: number;
  readonly attempts: number;
  waitForAttempts(expected: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}> {
  let attempts = 0;
  const sockets = new Set<TcpSocket>();
  const server = createTcpServer((socket) => {
    attempts++;
    sockets.add(socket);
    socket.on("data", () => undefined);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test endpoint did not bind");
  return {
    port: address.port,
    get attempts() {
      return attempts;
    },
    async waitForAttempts(expected, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (attempts < expected && Date.now() < deadline) await delay(10);
      if (attempts < expected)
        throw new Error(`Expected ${expected} connection attempts, observed ${attempts}`);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}
export async function waitForNode(
  origin: string,
  cookie: string,
  matches: (node: NodeView | undefined) => boolean,
): Promise<NodeView> {
  const deadline = Date.now() + 5000;
  let last: NodeView | undefined;
  while (Date.now() < deadline) {
    const response = await fetch(new URL("/api/owner/nodes", origin), {
      headers: { cookie },
    });
    if (!response.ok) throw new Error(`Could not read node status: ${response.status}`);
    const result = (await response.json()) as { nodes: NodeView[] };
    last = result.nodes[0];
    if (matches(last)) return last!;
    await delay(25);
  }
  throw new Error(`Node did not reach the expected state; last state was ${JSON.stringify(last)}`);
}
export async function attemptPairWithExistingId(
  origin: string,
  nodeId: string,
  pairingToken: string,
): Promise<string> {
  const socketUrl = new URL("/api/nodes/connect", origin);
  socketUrl.protocol = "ws:";
  const socket = observedWebSocket(socketUrl);
  return new Promise((resolveResponse, rejectResponse) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("Pairing response timed out")), 5000);
    const finish = (error?: Error, code?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error) rejectResponse(error);
      else resolveResponse(code!);
    };

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        nonce?: string;
        code?: string;
      };
      if (message.type === "control.challenge" && message.nonce) {
        const keyPair = generateKeyPairSync("ed25519", {
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
          publicKeyEncoding: { type: "spki", format: "pem" },
        });
        socket.send(
          JSON.stringify({
            type: "node.pair",
            requestId: randomUUID(),
            nodeId,
            pairingToken,
            publicKey: keyPair.publicKey,
            signature: sign(null, Buffer.from(message.nonce), keyPair.privateKey).toString(
              "base64url",
            ),
          }),
        );
      } else if (message.type === "control.error" && message.code) {
        finish(undefined, message.code);
      }
    });
    socket.addEventListener("error", () => finish(new Error("Pairing socket failed")));
    socket.addEventListener("close", () => {
      if (!settled) finish(new Error("Pairing socket closed without a response"));
    });
  });
}
export function waitForSocketOpen(socket: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(() => finish(new Error("WebSocket open timed out")), timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      if (error) rejectOpen(error);
      else resolveOpen();
    };
    const onOpen = () => finish();
    const onError = () => finish(new Error("WebSocket connection failed"));
    const onClose = () => finish(new Error("WebSocket closed before opening"));
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onClose, { once: true });
  });
}
export function waitForSocketClose(socket: WebSocket, timeoutMs = 5000): Promise<CloseEvent> {
  if (socket.readyState === WebSocket.CLOSED)
    return Promise.resolve(observedCloses.get(socket) ?? new CloseEvent("close", { code: 1006 }));
  return new Promise((resolveClose, rejectClose) => {
    const timeout = setTimeout(() => finish(new Error("WebSocket close timed out")), timeoutMs);
    const finish = (error?: Error, event?: CloseEvent) => {
      clearTimeout(timeout);
      socket.removeEventListener("close", onClose);
      if (error) rejectClose(error);
      else resolveClose(event!);
    };
    const onClose = (event: CloseEvent) => finish(undefined, event);
    socket.addEventListener("close", onClose, { once: true });
  });
}
export async function waitForSocketMessage(
  socket: WebSocket,
  matches: (message: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, rejectMessage) => {
    const timeout = setTimeout(() => finish(new Error("WebSocket message timed out")), timeoutMs);
    const finish = (error?: Error, message?: Record<string, unknown>) => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      if (error) rejectMessage(error);
      else resolveMessage(message!);
    };
    const onMessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (matches(message)) finish(undefined, message);
      } catch {
        finish(new Error("WebSocket sent invalid JSON"));
      }
    };
    const onClose = () => finish(new Error("WebSocket closed before the expected message"));
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
  });
}
/** Client close can precede server slot cleanup; wait for a new protocol challenge, not a sleep. */
export async function waitForAnonymousSlot(url: URL): Promise<WebSocket> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const socket = observedWebSocket(url);
    const accepted = await new Promise<boolean>((resolveAccepted, rejectAccepted) => {
      const timer = setTimeout(() => finish(new Error("Anonymous slot did not settle")), 3000);
      const finish = (error?: Error, accepted = false) => {
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", onClose);
        socket.removeEventListener("error", onError);
        if (error) {
          socket.close();
          rejectAccepted(error);
        } else resolveAccepted(accepted);
      };
      const onMessage = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data));
        if (message.type === "control.challenge") finish(undefined, true);
      };
      const onClose = (event: CloseEvent) =>
        event.code === 1013
          ? finish()
          : finish(new Error(`Anonymous slot closed unexpectedly: ${event.code}`));
      const onError = () => finish(new Error("Anonymous connection failed"));
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose, { once: true });
      socket.addEventListener("error", onError, { once: true });
    });
    if (accepted) return socket;
    await delay(10);
  }
  throw new Error("The server never released the previous anonymous connection slot");
}
export async function pairSocket(origin: string, pairingToken: string): Promise<WebSocket> {
  const url = new URL("/api/nodes/connect", origin);
  url.protocol = "ws:";
  const socket = observedWebSocket(url);
  await waitForSocketOpen(socket);
  const challenge = await waitForSocketMessage(
    socket,
    (message) => message.type === "control.challenge",
  );
  const keyPair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  socket.send(
    JSON.stringify({
      type: "node.pair",
      requestId: randomUUID(),
      nodeId: randomUUID(),
      pairingToken,
      publicKey: keyPair.publicKey,
      signature: sign(null, Buffer.from(String(challenge.nonce)), keyPair.privateKey).toString(
        "base64url",
      ),
    }),
  );
  await waitForSocketMessage(socket, (message) => message.type === "control.paired");
  return socket;
}
export async function attemptEd448Pair(origin: string, pairingToken: string): Promise<string> {
  const url = new URL("/api/nodes/connect", origin);
  url.protocol = "ws:";
  const socket = observedWebSocket(url);
  await waitForSocketOpen(socket);
  const challenge = await waitForSocketMessage(
    socket,
    (message) => message.type === "control.challenge",
  );
  const keyPair = generateKeyPairSync("ed448", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const response = waitForSocketMessage(socket, (message) => message.type === "control.error");
  socket.send(
    JSON.stringify({
      type: "node.pair",
      requestId: randomUUID(),
      nodeId: randomUUID(),
      pairingToken,
      publicKey: keyPair.publicKey,
      signature: sign(null, Buffer.from(String(challenge.nonce)), keyPair.privateKey).toString(
        "base64url",
      ),
    }),
  );
  const rejected = await response;
  const closed = waitForSocketClose(socket);
  await closed;
  return String(rejected.code);
}
export function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}
export interface TcpBlackholeProxy {
  port: number;
  connections: number;
  applicationFramesDropped: number;
  closeFramesDropped: number;
  firstClientSocket: TcpSocket | undefined;
  clientOpenAtControlPlaneExpiry: boolean | undefined;
  close(): Promise<void>;
}
export async function startTcpBlackholeProxy(targetPort: number): Promise<TcpBlackholeProxy> {
  const clientSockets = new Set<TcpSocket>();
  const upstreamSockets = new Set<TcpSocket>();
  const stats: TcpBlackholeProxy = {
    port: 0,
    connections: 0,
    applicationFramesDropped: 0,
    closeFramesDropped: 0,
    firstClientSocket: undefined,
    clientOpenAtControlPlaneExpiry: undefined,
    close: async () => {},
  };
  const server = createTcpServer((clientSocket) => {
    stats.connections++;
    const firstConnection = stats.connections === 1;
    stats.firstClientSocket ??= clientSocket;
    clientSockets.add(clientSocket);
    clientSocket.once("close", () => clientSockets.delete(clientSocket));
    clientSocket.pause();
    const upstream = connectTcp(targetPort, "127.0.0.1");
    upstreamSockets.add(upstream);
    upstream.once("close", () => upstreamSockets.delete(upstream));
    let blackhole = false;
    let serverText = Buffer.alloc(0);
    const clientFrames = { data: Buffer.alloc(0) };
    clientSocket.on("error", () => {});
    upstream.on("error", () => {});
    upstream.on("data", (data: Buffer) => {
      if (blackhole) return;
      clientSocket.write(data);
      serverText = Buffer.concat([serverText, data]);
      if (serverText.length > 2048) serverText = serverText.subarray(-2048);
      if (
        serverText.includes(Buffer.from('"type":"control.paired"')) ||
        serverText.includes(Buffer.from('"type":"control.authenticated"'))
      )
        blackhole = true;
    });
    upstream.once("connect", () => {
      clientSocket.on("data", (data: Buffer) => {
        if (!blackhole) {
          upstream.write(data);
          return;
        }
        countClientFrames(clientFrames, data, (opcode) => {
          if (opcode === 1) stats.applicationFramesDropped++;
          if (opcode === 8) stats.closeFramesDropped++;
        });
      });
      clientSocket.resume();
    });
    clientSocket.on("close", () => {
      if (!blackhole) upstream.destroy();
    });
    upstream.on("close", () => {
      if (firstConnection && blackhole)
        stats.clientOpenAtControlPlaneExpiry = !clientSocket.destroyed;
      if (!blackhole) clientSocket.destroy();
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TCP blackhole proxy did not bind");
  stats.port = address.port;
  stats.close = async () => {
    for (const socket of clientSockets) socket.destroy();
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  };
  return stats;
}
export function countClientFrames(
  state: { data: Buffer },
  data: Buffer,
  onOpcode: (opcode: number) => void,
): void {
  state.data = Buffer.concat([state.data, data]);
  while (state.data.length >= 2) {
    const first = state.data[0]!;
    const second = state.data[1]!;
    let payloadLength = second & 0x7f;
    let headerLength = 2;
    if (payloadLength === 126) {
      if (state.data.length < 4) return;
      payloadLength = state.data.readUInt16BE(2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (state.data.length < 10) return;
      const length = state.data.readBigUInt64BE(2);
      if (length > BigInt(Number.MAX_SAFE_INTEGER)) return;
      payloadLength = Number(length);
      headerLength = 10;
    }
    const masked = (second & 0x80) !== 0;
    const frameLength = headerLength + (masked ? 4 : 0) + payloadLength;
    if (state.data.length < frameLength) return;
    onOpcode(first & 0x0f);
    state.data = state.data.subarray(frameLength);
  }
}
export interface NodeView {
  id: string;
  online: boolean;
  lastConnectedAt: string | null;
}
