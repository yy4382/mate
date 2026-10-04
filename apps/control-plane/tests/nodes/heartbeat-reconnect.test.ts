import { spawn } from "node:child_process";

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket as UpstreamWebSocket, WebSocketServer } from "ws";
import { expect, it } from "vitest";

import {
  ownerPassword,
  waitForNode,
  rawDataText,
  TcpBlackholeProxy,
  startTcpBlackholeProxy,
} from "../support/node/connection-fixture.js";
import { ProcessOutput, stopProcess, delay } from "../support/node/process-output.js";

it("expires a blackholed node from owner status and reconnects after its pong deadline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-node-heartbeat-blackhole-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${ownerPassword}\n`, { mode: 0o600 });
  const moduleUrl = pathToFileURL(resolve("dist/main.js")).href;
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
    const nodeModuleUrl = import.meta.resolve("@mate/node");
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
  const moduleUrl = pathToFileURL(resolve("dist/main.js")).href;
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
    const nodeModuleUrl = import.meta.resolve("@mate/node");
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
    // Deliberately observe after the node's own deadline; the owner response may arrive late.
    await node.waitFor(/Node WebSocket disconnected; reconnecting\./, 5000);
    expect(proxy.clientOpenAtControlPlaneExpiry).toBe(true);
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
