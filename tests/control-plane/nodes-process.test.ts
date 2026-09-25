import { spawn, type ChildProcess } from "node:child_process";
import Database from "better-sqlite3";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import {
  connect as connectTcp,
  createServer as createTcpServer,
  type Socket as TcpSocket,
} from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket as UpstreamWebSocket, WebSocketServer, type RawData } from "ws";
import { expect, it } from "vitest";
import { ownerAuthSchema } from "../../src/control-plane/owner-auth-schema.js";

const ownerPassword = "node-process-owner-password-used-only-by-this-test";
const observedCloses = new WeakMap<WebSocket, CloseEvent>();

function observedWebSocket(url: string | URL): WebSocket {
  const socket = new WebSocket(url);
  socket.addEventListener("close", (event) => observedCloses.set(socket, event), { once: true });
  return socket;
}

class ProcessOutput {
  text = "";
  exitStatus: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private readonly changes = new Set<() => void>();
  readonly exited: Promise<void>;

  constructor(readonly child: ChildProcess) {
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) throw new Error("Process output pipes were not created");
    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");
    stdout.on("data", (chunk: string) => this.append(chunk));
    stderr.on("data", (chunk: string) => this.append(chunk));
    this.exited = new Promise((resolveExit) => {
      child.once("exit", (code, signal) => {
        this.exitStatus = { code, signal };
        this.changed();
        resolveExit();
      });
    });
  }

  waitFor(pattern: RegExp, timeoutMs = 7000): Promise<RegExpMatchArray> {
    const current = this.text.match(pattern);
    if (current) return Promise.resolve(current);
    if (this.exitStatus)
      return Promise.reject(new Error(`Process exited before ${pattern}: ${this.text}`));

    return new Promise((resolveMatch, reject) => {
      const finish = (match?: RegExpMatchArray) => {
        clearTimeout(timeout);
        this.changes.delete(check);
        if (match) resolveMatch(match);
        else reject(new Error(`Process did not produce ${pattern}: ${this.text}`));
      };
      const check = () => {
        const match = this.text.match(pattern);
        if (match) finish(match);
        else if (this.exitStatus) finish();
      };
      const timeout = setTimeout(() => finish(), timeoutMs);
      this.changes.add(check);
    });
  }

  private append(chunk: string): void {
    this.text += chunk;
    this.changed();
  }

  private changed(): void {
    for (const change of [...this.changes]) change();
  }
}

async function stopProcess(output: ProcessOutput): Promise<void> {
  if (output.exitStatus) return;
  const child = output.child;
  child.kill("SIGTERM");
  const graceful = new Promise<void>((resolveExit) => {
    if (output.exitStatus) resolveExit();
    else child.once("exit", () => resolveExit());
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    graceful,
    new Promise<void>((resolveTimeout) => {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolveTimeout();
      }, 1500);
    }),
  ]);
  if (timer) clearTimeout(timer);
  await output.exited;
}

async function waitForExit(output: ProcessOutput, timeoutMs = 5000): Promise<void> {
  await Promise.race([
    output.exited,
    delay(timeoutMs).then(() => {
      throw new Error(`Process did not exit: ${output.text}`);
    }),
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function startUnresponsiveWebSocketEndpoint(): Promise<{
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

async function waitForNode(
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

async function attemptPairWithExistingId(
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

function waitForSocketOpen(socket: WebSocket, timeoutMs = 5000): Promise<void> {
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

function waitForSocketClose(socket: WebSocket, timeoutMs = 5000): Promise<CloseEvent> {
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

async function waitForSocketMessage(
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

async function pairSocket(origin: string, pairingToken: string): Promise<WebSocket> {
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

async function attemptEd448Pair(origin: string, pairingToken: string): Promise<string> {
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

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

interface TcpBlackholeProxy {
  port: number;
  connections: number;
  applicationFramesDropped: number;
  closeFramesDropped: number;
  firstClientSocket: TcpSocket | undefined;
  close(): Promise<void>;
}

async function startTcpBlackholeProxy(targetPort: number): Promise<TcpBlackholeProxy> {
  const clientSockets = new Set<TcpSocket>();
  const upstreamSockets = new Set<TcpSocket>();
  const stats: TcpBlackholeProxy = {
    port: 0,
    connections: 0,
    applicationFramesDropped: 0,
    closeFramesDropped: 0,
    firstClientSocket: undefined,
    close: async () => {},
  };
  const server = createTcpServer((clientSocket) => {
    stats.connections++;
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

function countClientFrames(
  state: { data: Buffer },
  data: Buffer,
  onOpcode: (opcode: number) => void,
): void {
  state.data = Buffer.concat([state.data, data]);
  while (state.data.length >= 2) {
    const first = state.data[0]!;
    const second = state.data[1]!;
    let payloadLength = second! & 0x7f;
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
    const masked = (second! & 0x80) !== 0;
    const frameLength = headerLength + (masked ? 4 : 0) + payloadLength;
    if (state.data.length < frameLength) return;
    onOpcode(first! & 0x0f);
    state.data = state.data.subarray(frameLength);
  }
}

it("bounds node WebSocket connections and rejects malformed or oversized anonymous traffic", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-node-connection-limits-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${ownerPassword}\n`, { mode: 0o600 });
  const moduleUrl = pathToFileURL(resolve("dist/src/control-plane/main.js")).href;
  const runner = `const { startControlPlane } = await import(${JSON.stringify(moduleUrl)}); startControlPlane(0, undefined, { dataDir: process.env.MATE_CONTROL_PLANE_DATA_DIR, passwordFile: process.env.MATE_OWNER_PASSWORD_FILE, maxNodeConnections: 3, maxUnauthenticatedNodeConnections: 1, nodeHandshakeTimeoutMs: 1000 });`;
  const serverChild = spawn(process.execPath, ["--input-type=module", "--eval", runner], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MATE_CONTROL_PLANE_DATA_DIR: join(directory, "control-plane-data"),
      MATE_OWNER_PASSWORD_FILE: passwordFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const server = new ProcessOutput(serverChild);
  const pairedSockets: WebSocket[] = [];
  let rawSocket: WebSocket | undefined;

  try {
    const listening = await server.waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/);
    const origin = `http://127.0.0.1:${listening[1]}`;
    const login = await fetch(new URL("/api/auth/login", origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: ownerPassword }),
    });
    expect(login.status).toBe(204);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();

    const algorithmTokenResponse = await fetch(new URL("/api/owner/nodes/pairing-tokens", origin), {
      method: "POST",
      headers: { cookie: cookie! },
    });
    const algorithmToken = (await algorithmTokenResponse.json()) as { pairingToken: string };
    await expect(attemptEd448Pair(origin, algorithmToken.pairingToken)).resolves.toBe(
      "invalid_identity",
    );
    pairedSockets.push(await pairSocket(origin, algorithmToken.pairingToken));

    for (let index = 0; index < 2; index++) {
      const tokenResponse = await fetch(new URL("/api/owner/nodes/pairing-tokens", origin), {
        method: "POST",
        headers: { cookie: cookie! },
      });
      expect(tokenResponse.status).toBe(201);
      const token = (await tokenResponse.json()) as { pairingToken: string };
      pairedSockets.push(await pairSocket(origin, token.pairingToken));
    }

    const totalLimitSocket = observedWebSocket(
      new URL("/api/nodes/connect", origin).toString().replace(/^http/, "ws"),
    );
    expect((await waitForSocketClose(totalLimitSocket)).code).toBe(1013);
    const firstPairedSocketClose = waitForSocketClose(pairedSockets[0]!);
    pairedSockets[0]!.close(1000, "free one connection slot");
    await firstPairedSocketClose;
    await delay(25);

    const anonymousUrl = new URL("/api/nodes/connect", origin);
    anonymousUrl.protocol = "ws:";
    rawSocket = observedWebSocket(anonymousUrl);
    await waitForSocketOpen(rawSocket);
    await waitForSocketMessage(rawSocket, (message) => message.type === "control.challenge");
    const unauthenticatedLimitSocket = observedWebSocket(anonymousUrl);
    expect((await waitForSocketClose(unauthenticatedLimitSocket)).code).toBe(1013);

    const anonymousList = await fetch(new URL("/api/owner/nodes", origin));
    expect(anonymousList.status).toBe(401);

    const malformedResponse = waitForSocketMessage(
      rawSocket,
      (message) => message.type === "control.error",
    );
    rawSocket.send(JSON.stringify({ type: "node.ping", requestId: "not-a-uuid", sentAt: 1 }));
    const errorMessage = await malformedResponse;
    expect(errorMessage).toMatchObject({
      code: "malformed_request",
      message: expect.any(String),
    });
    expect(errorMessage).not.toHaveProperty("requestId");
    expect((await waitForSocketClose(rawSocket)).code).toBe(1008);
    rawSocket = undefined;

    const timeoutSocket = observedWebSocket(anonymousUrl);
    await waitForSocketOpen(timeoutSocket);
    expect((await waitForSocketClose(timeoutSocket, 3000)).code).toBe(1008);

    const oversizedSocket = observedWebSocket(anonymousUrl);
    await waitForSocketOpen(oversizedSocket);
    oversizedSocket.send("x".repeat(17 * 1024));
    expect((await waitForSocketClose(oversizedSocket)).code).toBe(1009);
    expect((await fetch(new URL("/api/status", origin))).status).toBe(200);
  } finally {
    rawSocket?.close();
    for (const socket of pairedSockets) socket.close();
    await stopProcess(server);
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);

it("expires a blackholed node from owner status and reconnects after its pong deadline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-node-heartbeat-blackhole-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${ownerPassword}\n`, { mode: 0o600 });
  const moduleUrl = pathToFileURL(resolve("dist/src/control-plane/main.js")).href;
  const runner = `const { startControlPlane } = await import(${JSON.stringify(moduleUrl)}); startControlPlane(0, undefined, { dataDir: process.env.MATE_CONTROL_PLANE_DATA_DIR, passwordFile: process.env.MATE_OWNER_PASSWORD_FILE, nodeHeartbeatTimeoutMs: 200 });`;
  const serverChild = spawn(process.execPath, ["--input-type=module", "--eval", runner], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MATE_CONTROL_PLANE_DATA_DIR: join(directory, "control-plane-data"),
      MATE_OWNER_PASSWORD_FILE: passwordFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const server = new ProcessOutput(serverChild);
  const proxyHttp = createServer();
  const proxyWebSockets = new WebSocketServer({ noServer: true });
  let proxyConnections = 0;
  let serverPort = "";
  let blackholedSocket: WebSocket | undefined;
  proxyHttp.on("upgrade", (request, networkSocket, head) => {
    proxyWebSockets.handleUpgrade(request, networkSocket, head, (nodeSocket) => {
      proxyConnections++;
      blackholedSocket = nodeSocket as unknown as WebSocket;
      const upstreamUrl = `ws://127.0.0.1:${serverPort}/api/nodes/connect`;
      const controlSocket = new UpstreamWebSocket(upstreamUrl);
      let blackhole = false;
      nodeSocket.on("message", (data) => {
        const text = rawDataText(data);
        let message: { type?: string };
        try {
          message = JSON.parse(text) as { type?: string };
        } catch {
          return;
        }
        if (blackhole && message.type === "node.ping") return;
        if (controlSocket.readyState === UpstreamWebSocket.OPEN) controlSocket.send(data);
      });
      controlSocket.on("message", (data) => {
        const text = rawDataText(data);
        let message: { type?: string };
        try {
          message = JSON.parse(text) as { type?: string };
        } catch {
          return;
        }
        if (message.type === "control.paired") blackhole = true;
        if (blackhole && message.type === "control.pong") return;
        if (nodeSocket.readyState === nodeSocket.OPEN) nodeSocket.send(data);
      });
      nodeSocket.on("close", () => controlSocket.close());
      controlSocket.on("close", () => nodeSocket.close());
      nodeSocket.on("error", () => controlSocket.close());
      controlSocket.on("error", () => nodeSocket.close());
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    proxyHttp.once("error", rejectListen);
    proxyHttp.listen(0, "127.0.0.1", () => {
      proxyHttp.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const proxyAddress = proxyHttp.address();
  if (!proxyAddress || typeof proxyAddress === "string") throw new Error("Proxy did not bind");
  serverPort = await server.waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/).then((m) => m[1]!);
  const origin = `http://127.0.0.1:${serverPort}`;
  const nodeProxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
  let node: ProcessOutput | undefined;

  try {
    const login = await fetch(new URL("/api/auth/login", origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: ownerPassword }),
    });
    expect(login.status).toBe(204);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();
    const tokenResponse = await fetch(new URL("/api/owner/nodes/pairing-tokens", origin), {
      method: "POST",
      headers: { cookie: cookie! },
    });
    expect(tokenResponse.status).toBe(201);
    const { pairingToken } = (await tokenResponse.json()) as { pairingToken: string };
    const nodeModuleUrl = pathToFileURL(resolve("dist/src/nodes/client.js")).href;
    const nodeRunner = `const { runLinuxNode } = await import(${JSON.stringify(nodeModuleUrl)}); await runLinuxNode({ controlPlaneUrl: process.env.MATE_CONTROL_PLANE_URL, dataDirectory: process.env.MATE_NODE_DATA_DIR, pairingToken: process.env.MATE_NODE_PAIRING_TOKEN, heartbeatIntervalMs: 50, heartbeatTimeoutMs: 1200 }, new AbortController().signal);`;
    node = new ProcessOutput(
      spawn(process.execPath, ["--input-type=module", "--eval", nodeRunner], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MATE_CONTROL_PLANE_URL: nodeProxyUrl,
          MATE_NODE_DATA_DIR: join(directory, "node-data"),
          MATE_NODE_PAIRING_TOKEN: pairingToken,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    const paired = await node.waitFor(/MATE_NODE_PAIRED ([0-9a-f-]+)/i);
    const offline = await waitForNode(origin, cookie!, (candidate) => candidate?.online === false);
    expect(offline.id).toBe(paired[1]);
    expect(node.exitStatus).toBeUndefined();
    const expiredSocket = blackholedSocket;
    const closeDeadline = Date.now() + 2000;
    while (expiredSocket?.readyState !== WebSocket.CLOSED && Date.now() < closeDeadline)
      await delay(10);
    expect(expiredSocket?.readyState).toBe(WebSocket.CLOSED);

    const reconnect = await node.waitFor(/Node WebSocket disconnected; reconnecting\./, 5000);
    expect(reconnect[0]).toContain("reconnecting");
    const reconnectDeadline = Date.now() + 5000;
    while (proxyConnections < 2 && Date.now() < reconnectDeadline) await delay(25);
    expect(proxyConnections).toBeGreaterThanOrEqual(2);
    expect(server.exitStatus).toBeUndefined();
  } finally {
    if (node) await stopProcess(node);
    for (const client of proxyWebSockets.clients) client.close();
    await new Promise<void>((resolveClose) => proxyWebSockets.close(() => resolveClose()));
    await new Promise<void>((resolveClose) => proxyHttp.close(() => resolveClose()));
    await stopProcess(server);
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

it("reclaims a blackholed WebSocket slot and reconnects the same node identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-node-blackhole-recovery-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${ownerPassword}\n`, { mode: 0o600 });
  const moduleUrl = pathToFileURL(resolve("dist/src/control-plane/main.js")).href;
  const runner = `const { startControlPlane } = await import(${JSON.stringify(moduleUrl)}); startControlPlane(0, undefined, { dataDir: process.env.MATE_CONTROL_PLANE_DATA_DIR, passwordFile: process.env.MATE_OWNER_PASSWORD_FILE, maxNodeConnections: 1, maxUnauthenticatedNodeConnections: 1, nodeHeartbeatTimeoutMs: 200 });`;
  const serverChild = spawn(process.execPath, ["--input-type=module", "--eval", runner], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MATE_CONTROL_PLANE_DATA_DIR: join(directory, "control-plane-data"),
      MATE_OWNER_PASSWORD_FILE: passwordFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const server = new ProcessOutput(serverChild);
  let proxy: TcpBlackholeProxy | undefined;
  let node: ProcessOutput | undefined;

  try {
    const listening = await server.waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/);
    const controlPort = Number(listening[1]);
    const origin = `http://127.0.0.1:${controlPort}`;
    const login = await fetch(new URL("/api/auth/login", origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: ownerPassword }),
    });
    expect(login.status).toBe(204);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();
    const tokenResponse = await fetch(new URL("/api/owner/nodes/pairing-tokens", origin), {
      method: "POST",
      headers: { cookie: cookie! },
    });
    expect(tokenResponse.status).toBe(201);
    const { pairingToken } = (await tokenResponse.json()) as { pairingToken: string };
    proxy = await startTcpBlackholeProxy(controlPort);
    const nodeModuleUrl = pathToFileURL(resolve("dist/src/nodes/client.js")).href;
    const nodeRunner = `const { runLinuxNode } = await import(${JSON.stringify(nodeModuleUrl)}); await runLinuxNode({ controlPlaneUrl: process.env.MATE_CONTROL_PLANE_URL, dataDirectory: process.env.MATE_NODE_DATA_DIR, pairingToken: process.env.MATE_NODE_PAIRING_TOKEN, heartbeatIntervalMs: 40, heartbeatTimeoutMs: 600 }, new AbortController().signal);`;
    node = new ProcessOutput(
      spawn(process.execPath, ["--input-type=module", "--eval", nodeRunner], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MATE_CONTROL_PLANE_URL: `http://127.0.0.1:${proxy.port}`,
          MATE_NODE_DATA_DIR: join(directory, "node-data"),
          MATE_NODE_PAIRING_TOKEN: pairingToken,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    const paired = await node.waitFor(/MATE_NODE_PAIRED ([0-9a-f-]+)/i);
    await waitForNode(
      origin,
      cookie!,
      (candidate) => candidate?.id === paired[1] && candidate?.online === true,
    );
    const offline = await waitForNode(
      origin,
      cookie!,
      (candidate) => candidate?.id === paired[1] && candidate?.online === false,
    );
    expect(offline.lastConnectedAt).toBeTruthy();
    expect(proxy.firstClientSocket?.destroyed).toBe(false);
    expect(proxy.applicationFramesDropped).toBeGreaterThan(0);

    const droppedCloseDeadline = Date.now() + 3000;
    while (proxy.closeFramesDropped === 0 && Date.now() < droppedCloseDeadline) await delay(10);
    expect(proxy.closeFramesDropped).toBeGreaterThan(0);
    const reconnected = await node.waitFor(new RegExp(`MATE_NODE_CONNECTED ${paired[1]}`), 5000);
    expect(reconnected[0]).toContain(paired[1]!);
    const onlineAgain = await waitForNode(
      origin,
      cookie!,
      (candidate) => candidate?.id === paired[1] && candidate?.online === true,
    );
    expect(onlineAgain.id).toBe(paired[1]);
    expect(proxy.connections).toBeGreaterThanOrEqual(2);
    expect(proxy.firstClientSocket?.destroyed).toBe(true);
  } finally {
    if (node) await stopProcess(node);
    if (proxy) await proxy.close();
    await stopProcess(server);
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

interface NodeView {
  id: string;
  online: boolean;
  lastConnectedAt: string | null;
}

it("keeps retrying when the WebSocket handshake never completes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-node-handshake-timeout-"));
  chmodSync(directory, 0o700);
  const endpoint = await startUnresponsiveWebSocketEndpoint();
  const moduleUrl = pathToFileURL(resolve("dist/src/nodes/client.js")).href;
  const runner = `const { runLinuxNode } = await import(${JSON.stringify(moduleUrl)}); await runLinuxNode({ controlPlaneUrl: process.env.MATE_CONTROL_PLANE_URL, dataDirectory: process.env.MATE_NODE_DATA_DIR, pairingToken: process.env.MATE_NODE_PAIRING_TOKEN }, new AbortController().signal);`;
  const node = new ProcessOutput(
    spawn(process.execPath, ["--input-type=module", "--eval", runner], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MATE_CONTROL_PLANE_URL: `http://127.0.0.1:${endpoint.port}`,
        MATE_NODE_DATA_DIR: join(directory, "node-data"),
        MATE_NODE_PAIRING_TOKEN: "test-pairing-token-that-is-long-enough-74",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  try {
    await endpoint.waitForAttempts(1);
    expect(node.exitStatus).toBeUndefined();
    await node.waitFor(/Node WebSocket connection failed; retrying\./, 12_000);
    expect(node.exitStatus).toBeUndefined();
    await endpoint.waitForAttempts(2, 5000);
    expect(node.exitStatus).toBeUndefined();
  } finally {
    await stopProcess(node);
    await endpoint.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);

it("aborts a connecting WebSocket without an unhandled error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-node-handshake-abort-"));
  chmodSync(directory, 0o700);
  const endpoint = await startUnresponsiveWebSocketEndpoint();
  const moduleUrl = pathToFileURL(resolve("dist/src/nodes/client.js")).href;
  const runner = `const { runLinuxNode } = await import(${JSON.stringify(moduleUrl)}); const controller = new AbortController(); process.on("message", (message) => { if (message === "abort") { controller.abort(); process.disconnect(); } }); await runLinuxNode({ controlPlaneUrl: process.env.MATE_CONTROL_PLANE_URL, dataDirectory: process.env.MATE_NODE_DATA_DIR, pairingToken: process.env.MATE_NODE_PAIRING_TOKEN }, controller.signal);`;
  const node = new ProcessOutput(
    spawn(process.execPath, ["--input-type=module", "--eval", runner], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MATE_CONTROL_PLANE_URL: `http://127.0.0.1:${endpoint.port}`,
        MATE_NODE_DATA_DIR: join(directory, "node-data"),
        MATE_NODE_PAIRING_TOKEN: "test-pairing-token-that-is-long-enough-74",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }),
  );
  try {
    await endpoint.waitForAttempts(1);
    node.child.send("abort");
    await waitForExit(node);
    expect(node.exitStatus?.code).toBe(0);
    expect(node.text).not.toContain("WebSocket was closed before the connection was established");
  } finally {
    await stopProcess(node);
    await endpoint.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 10000);

it("pairs a node over WebSocket, confirms requests, and restores status after reconnect", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-node-process-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${ownerPassword}\n`, { mode: 0o600 });
  chmodSync(passwordFile, 0o600);
  const controlData = join(directory, "control-plane-data");
  const serverChild = spawn(process.execPath, [resolve("dist/src/control-plane/main.js")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MATE_CONTROL_PLANE_PORT: "0",
      MATE_CONTROL_PLANE_DATA_DIR: controlData,
      MATE_OWNER_PASSWORD_FILE: passwordFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const server = new ProcessOutput(serverChild);
  let node: ProcessOutput | undefined;

  try {
    const listening = await server.waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/);
    const origin = `http://127.0.0.1:${listening[1]}`;
    const login = await fetch(new URL("/api/auth/login", origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: ownerPassword }),
    });
    expect(login.status).toBe(204);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();

    const pairingResponse = await fetch(new URL("/api/owner/nodes/pairing-tokens", origin), {
      method: "POST",
      headers: { cookie: cookie! },
    });
    expect(pairingResponse.status).toBe(201);
    const pairing = (await pairingResponse.json()) as { pairingToken: string };
    const nodeData = join(directory, "node-data");
    const startNode = (token?: string, dataDirectory = nodeData) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        MATE_CONTROL_PLANE_URL: origin,
        MATE_NODE_DATA_DIR: dataDirectory,
      };
      if (token) env.MATE_NODE_PAIRING_TOKEN = token;
      else delete env.MATE_NODE_PAIRING_TOKEN;
      return new ProcessOutput(
        spawn(process.execPath, [resolve("dist/src/node/main.js")], {
          cwd: process.cwd(),
          env,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    };

    node = startNode(pairing.pairingToken);
    const paired = await node.waitFor(/MATE_NODE_PAIRED ([0-9a-f-]+)/i);
    await node.waitFor(/MATE_NODE_HEARTBEAT_ACK ([0-9a-f-]+)/i);
    const connected = await waitForNode(
      origin,
      cookie!,
      (candidate) => candidate?.id === paired[1] && candidate?.online === true,
    );
    expect(connected.lastConnectedAt).toBeTruthy();

    const tokenReuse = startNode(pairing.pairingToken, join(directory, "node-token-reuse"));
    await waitForExit(tokenReuse);
    expect(tokenReuse.exitStatus?.code).toBe(1);
    expect(tokenReuse.text).toContain("配对令牌无效、已过期或已使用");
    const stillConnected = await waitForNode(
      origin,
      cookie!,
      (candidate) => candidate?.id === paired[1] && candidate?.online === true,
    );
    expect(stillConnected.id).toBe(paired[1]);

    const collisionTokenResponse = await fetch(new URL("/api/owner/nodes/pairing-tokens", origin), {
      method: "POST",
      headers: { cookie: cookie! },
    });
    expect(collisionTokenResponse.status).toBe(201);
    const collisionToken = (await collisionTokenResponse.json()) as { pairingToken: string };
    await expect(
      attemptPairWithExistingId(origin, paired[1]!, collisionToken.pairingToken),
    ).resolves.toBe("pairing_rejected");
    expect((await fetch(new URL("/api/status", origin))).status).toBe(200);

    const attackerDirectory = join(directory, "node-identity-impostor");
    mkdirSync(attackerDirectory, { mode: 0o700 });
    chmodSync(attackerDirectory, 0o700);
    const impostorKey = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    writeFileSync(
      join(attackerDirectory, "node-identity.json"),
      JSON.stringify({ id: paired[1], privateKey: impostorKey.privateKey }),
      { mode: 0o600 },
    );
    const impostor = startNode(undefined, attackerDirectory);
    await waitForExit(impostor);
    expect(impostor.exitStatus?.code).toBe(1);
    expect(impostor.text).toContain("控制面拒绝了此节点身份");
    const afterImpersonation = await waitForNode(
      origin,
      cookie!,
      (candidate) => candidate?.id === paired[1] && candidate?.online === true,
    );
    expect(afterImpersonation.lastConnectedAt).toBe(connected.lastConnectedAt);

    const lastConnectedAt = connected.lastConnectedAt;
    await stopProcess(node);
    node = undefined;
    const disconnected = await waitForNode(
      origin,
      cookie!,
      (candidate) => candidate?.id === paired[1] && candidate?.online === false,
    );
    expect(disconnected.lastConnectedAt).toBe(lastConnectedAt);

    const channelResponse = await fetch(new URL("/api/owner/channels", origin), {
      method: "POST",
      headers: { cookie: cookie!, "content-type": "application/json" },
      body: JSON.stringify({ name: "节点离线期间", description: "", visibility: "public" }),
    });
    expect(channelResponse.status).toBe(201);
    const channel = (await channelResponse.json()) as { id: string };
    const offlinePost = await fetch(new URL(`/api/owner/channels/${channel.id}/messages`, origin), {
      method: "POST",
      headers: { cookie: cookie!, "content-type": "application/json" },
      body: JSON.stringify({ text: "节点离线时仍已提交" }),
    });
    expect(offlinePost.status).toBe(201);
    const offlineMessage = (await offlinePost.json()) as { id: string; text: string };
    const offlineHistory = await fetch(
      new URL(`/api/owner/channels/${channel.id}/messages`, origin),
      { headers: { cookie: cookie! } },
    );
    expect(offlineHistory.status).toBe(200);
    expect(await offlineHistory.json()).toMatchObject({
      messages: [expect.objectContaining({ id: offlineMessage.id, text: "节点离线时仍已提交" })],
    });

    node = startNode();
    const reconnected = await node.waitFor(/MATE_NODE_CONNECTED ([0-9a-f-]+)/i);
    await node.waitFor(/MATE_NODE_HEARTBEAT_ACK ([0-9a-f-]+)/i);
    expect(reconnected[1]).toBe(paired[1]);
    const onlineAgain = await waitForNode(
      origin,
      cookie!,
      (candidate) => candidate?.id === paired[1] && candidate?.online === true,
    );
    const recoveredHistory = await fetch(
      new URL(`/api/owner/channels/${channel.id}/messages`, origin),
      { headers: { cookie: cookie! } },
    );
    expect(recoveredHistory.status).toBe(200);
    expect(await recoveredHistory.json()).toMatchObject({
      messages: [expect.objectContaining({ id: offlineMessage.id, text: "节点离线时仍已提交" })],
    });
    expect(Date.parse(onlineAgain.lastConnectedAt!)).toBeGreaterThanOrEqual(
      Date.parse(disconnected.lastConnectedAt!),
    );
    await delay(10_250);
    expect((node.text.match(/MATE_NODE_HEARTBEAT_ACK /g) ?? []).length).toBeGreaterThan(1);
    expect(node.text).not.toContain("Node WebSocket connection failed; retrying.");
  } finally {
    if (node) await stopProcess(node);
    await stopProcess(server);
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

it("upgrades a revision 3 database through node and Agent schemas without losing owner chat", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-node-schema-upgrade-"));
  chmodSync(directory, 0o700);
  const dataDir = join(directory, "control-plane-data");
  mkdirSync(dataDir, { mode: 0o700 });
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${ownerPassword}\n`, { mode: 0o600 });
  const databasePath = join(dataDir, "control-plane.sqlite");
  const legacy = new Database(databasePath);
  legacy.exec(ownerAuthSchema);
  legacy.pragma("application_id = 1296257100");
  legacy.pragma("user_version = 3");
  legacy
    .prepare(
      "INSERT INTO owner_channels(id,name,description,visibility,created_at,updated_at) VALUES('saved-channel','保存的频道','','public',10,10)",
    )
    .run();
  legacy
    .prepare(
      "INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at) VALUES('saved-channel','human','owner',1,10)",
    )
    .run();
  legacy
    .prepare(
      "INSERT INTO owner_messages(id,channel_id,order_seq,text,created_at) VALUES('saved-message','saved-channel',1,'升级前的持久消息',11)",
    )
    .run();
  legacy.close();

  const serverChild = spawn(process.execPath, [resolve("dist/src/control-plane/main.js")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MATE_CONTROL_PLANE_PORT: "0",
      MATE_CONTROL_PLANE_DATA_DIR: dataDir,
      MATE_OWNER_PASSWORD_FILE: passwordFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const server = new ProcessOutput(serverChild);
  try {
    const listening = await server.waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/);
    const origin = `http://127.0.0.1:${listening[1]}`;
    const login = await fetch(new URL("/api/auth/login", origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: ownerPassword }),
    });
    expect(login.status).toBe(204);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();

    const channels = await fetch(new URL("/api/owner/channels", origin), {
      headers: { cookie: cookie! },
    });
    expect(channels.status).toBe(200);
    expect(await channels.json()).toMatchObject({
      channels: [expect.objectContaining({ id: "saved-channel", name: "保存的频道" })],
    });
    const messages = await fetch(new URL("/api/owner/channels/saved-channel/messages", origin), {
      headers: { cookie: cookie! },
    });
    expect(messages.status).toBe(200);
    expect(await messages.json()).toMatchObject({
      messages: [expect.objectContaining({ id: "saved-message", text: "升级前的持久消息" })],
    });
    const nodes = await fetch(new URL("/api/owner/nodes", origin), {
      headers: { cookie: cookie! },
    });
    expect(nodes.status).toBe(200);
    expect(await nodes.json()).toEqual({ nodes: [] });

    const upgraded = new Database(databasePath, { readonly: true });
    expect(upgraded.pragma("user_version", { simple: true })).toBe(10);
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE name='nodes'").get()).toEqual({
      name: "nodes",
    });
    expect(
      upgraded.prepare("SELECT name FROM sqlite_master WHERE name='owner_agents'").get(),
    ).toEqual({ name: "owner_agents" });
    expect(
      upgraded.prepare("SELECT name FROM sqlite_master WHERE name='model_credentials'").get(),
    ).toEqual({ name: "model_credentials" });
    expect(
      upgraded.prepare("SELECT name FROM sqlite_master WHERE name='owner_agent_runs'").get(),
    ).toEqual({ name: "owner_agent_runs" });
    upgraded.close();
  } finally {
    await stopProcess(server);
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

it("rejects an expired pairing token in a control-plane process with a short assembled lifetime", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-expired-node-token-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${ownerPassword}\n`, { mode: 0o600 });
  const moduleUrl = pathToFileURL(resolve("dist/src/control-plane/main.js")).href;
  const runner = `const { startControlPlane } = await import(${JSON.stringify(moduleUrl)}); startControlPlane(0, undefined, { dataDir: process.env.MATE_CONTROL_PLANE_DATA_DIR, passwordFile: process.env.MATE_OWNER_PASSWORD_FILE, pairingTokenTtlMs: 250 });`;
  const serverChild = spawn(process.execPath, ["--input-type=module", "--eval", runner], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MATE_CONTROL_PLANE_DATA_DIR: join(directory, "control-plane-data"),
      MATE_OWNER_PASSWORD_FILE: passwordFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const server = new ProcessOutput(serverChild);
  let node: ProcessOutput | undefined;

  try {
    const listening = await server.waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/);
    const origin = `http://127.0.0.1:${listening[1]}`;
    const login = await fetch(new URL("/api/auth/login", origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: ownerPassword }),
    });
    expect(login.status).toBe(204);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();
    const response = await fetch(new URL("/api/owner/nodes/pairing-tokens", origin), {
      method: "POST",
      headers: { cookie: cookie! },
    });
    expect(response.status).toBe(201);
    const { pairingToken } = (await response.json()) as { pairingToken: string };
    await delay(350);

    node = new ProcessOutput(
      spawn(process.execPath, [resolve("dist/src/node/main.js")], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MATE_CONTROL_PLANE_URL: origin,
          MATE_NODE_DATA_DIR: join(directory, "node-data"),
          MATE_NODE_PAIRING_TOKEN: pairingToken,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    await waitForExit(node);
    expect(node.exitStatus?.code).toBe(1);
    expect(node.text).toContain("配对令牌无效、已过期或已使用");
    const list = await fetch(new URL("/api/owner/nodes", origin), {
      headers: { cookie: cookie! },
    });
    expect(await list.json()).toEqual({ nodes: [] });
  } finally {
    if (node) await stopProcess(node);
    await stopProcess(server);
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
