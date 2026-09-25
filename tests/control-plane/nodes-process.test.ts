import { spawn, type ChildProcess } from "node:child_process";
import Database from "better-sqlite3";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { ownerAuthSchema } from "../../src/control-plane/owner-auth-schema.js";

const ownerPassword = "node-process-owner-password-used-only-by-this-test";

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
  const socket = new WebSocket(socketUrl);
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

interface NodeView {
  id: string;
  online: boolean;
  lastConnectedAt: string | null;
}

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
    const offlinePost = await fetch(
      new URL(`/api/owner/channels/${channel.id}/messages`, origin),
      {
        method: "POST",
        headers: { cookie: cookie!, "content-type": "application/json" },
        body: JSON.stringify({ text: "节点离线时仍已提交" }),
      },
    );
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

it("upgrades a #73 control-plane database to revision 4 without losing owner chat", async () => {
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
    const messages = await fetch(
      new URL("/api/owner/channels/saved-channel/messages", origin),
      { headers: { cookie: cookie! } },
    );
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
    expect(upgraded.pragma("user_version", { simple: true })).toBe(4);
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE name='nodes'").get()).toEqual({
      name: "nodes",
    });
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
