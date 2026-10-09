import { spawn } from "node:child_process";

import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

import {
  ownerPassword,
  fileOwnerUid,
  waitForNode,
  attemptPairWithExistingId,
} from "../support/node/connection-fixture.js";
import { ProcessOutput, stopProcess, waitForExit, delay } from "../support/node/process-output.js";

it("pairs a node over WebSocket, confirms requests, and restores status after reconnect", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-node-process-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${ownerPassword}\n`, { mode: 0o600 });
  chmodSync(passwordFile, 0o600);
  const controlData = join(directory, "control-plane-data");
  // A plain ordinary-account start must not need a service manager, even when one advertises a socket.
  const notifySocket = join(directory, "missing-systemd-notify.sock");
  const serverChild = spawn(process.execPath, [resolve("dist/main.js")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MATE_CONTROL_PLANE_PORT: "0",
      MATE_CONTROL_PLANE_DATA_DIR: controlData,
      MATE_OWNER_PASSWORD_FILE: passwordFile,
      NOTIFY_SOCKET: notifySocket,
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
        NOTIFY_SOCKET: notifySocket,
      };
      if (token) env.MATE_NODE_PAIRING_TOKEN = token;
      else delete env.MATE_NODE_PAIRING_TOKEN;
      return new ProcessOutput(
        spawn(process.execPath, [resolve("../node/dist/main.js")], {
          cwd: process.cwd(),
          env,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    };

    node = startNode(pairing.pairingToken);
    const paired = await node.waitFor(/MATE_NODE_PAIRED ([0-9a-f-]+)/i);
    await node.waitFor(/MATE_NODE_HEARTBEAT_ACK ([0-9a-f-]+)/i);
    // The node keeps the launching account: no user creation, no identity switch, no service manager.
    if (typeof process.getuid === "function")
      expect(fileOwnerUid(join(nodeData, "node-identity.json"))).toBe(process.getuid());
    expect(node.text).not.toContain("must run as root");
    expect(node.text).not.toContain("systemd");
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

it("rejects an expired pairing token in a control-plane process with a short assembled lifetime", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-expired-node-token-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${ownerPassword}\n`, { mode: 0o600 });
  const moduleUrl = pathToFileURL(resolve("dist/main.js")).href;
  const runner = `
    const { startControlPlane } = await import(${JSON.stringify(moduleUrl)});
    startControlPlane(0, undefined, {
      dataDir: process.env.MATE_CONTROL_PLANE_DATA_DIR,
      passwordFile: process.env.MATE_OWNER_PASSWORD_FILE,
      pairingTokenTtlMs: 250
    });`;
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
      spawn(process.execPath, [resolve("../node/dist/main.js")], {
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
