import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/control-plane/http.js";
import { OwnerAuth } from "../../src/control-plane/owner-auth.js";
import { controlPlaneMigrations, controlPlaneSchemaV4 } from "../../src/control-plane/schema.js";
import { newAgentRequestSchema } from "../../src/control-plane/agents/contracts.js";
import type { NodeSocket } from "../../src/control-plane/nodes/directory.js";

const ownerPassword = "agent-creation-owner-password";
const fixtures: Array<{ app: ReturnType<typeof createControlPlaneApp>; directory: string }> = [];

afterEach(() => {
  for (const { app, directory } of fixtures.splice(0)) {
    app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-creation-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${ownerPassword}\n`, { mode: 0o600 });
  const app = createControlPlaneApp({
    dataDir: join(directory, "control-plane"),
    passwordFile,
  });
  fixtures.push({ app, directory });
  return app;
}

async function login(app: ReturnType<typeof createControlPlaneApp>): Promise<string> {
  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: ownerPassword }),
  });
  expect(response.status).toBe(204);
  return response.headers.get("set-cookie")!.split(";", 1)[0]!;
}

class FakeNodeSocket implements NodeSocket {
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  terminate(): void {
    this.closed = true;
  }
}

async function pairNode(
  app: ReturnType<typeof createControlPlaneApp>,
  cookie: string,
): Promise<{ id: string; socket: FakeNodeSocket }> {
  const tokenResponse = await app.request("/api/owner/nodes/pairing-tokens", {
    method: "POST",
    headers: { cookie },
  });
  const { pairingToken } = (await tokenResponse.json()) as { pairingToken: string };
  const socket = new FakeNodeSocket();
  app.nodes.open(socket);
  const challenge = JSON.parse(socket.sent[0]!) as { nonce: string };
  const id = randomUUID();
  const keyPair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.pair",
      requestId: randomUUID(),
      nodeId: id,
      pairingToken,
      publicKey: keyPair.publicKey,
      signature: sign(null, Buffer.from(challenge.nonce), keyPair.privateKey).toString("base64url"),
    }),
  );
  return { id, socket };
}

it("keeps an offline-node Agent form unsubmitted", async () => {
  const app = setup();
  const cookie = await login(app);
  const input = {
    id: "ed1e60c8-bdda-4f46-a857-bbd542f82640",
    name: "Research partner",
    role: "Researches questions and reports evidence",
    description: "A private colleague for research work.",
    nodeId: "c5342142-9cf5-4b22-86f3-bdc46bb471f2",
    model: { provider: "openai", id: "gpt-4.1" },
  };

  const response = await app.request("/api/owner/agents", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "所选节点当前离线，Agent 资料尚未提交。" });
  const list = await app.request("/api/owner/agents", { headers: { cookie } });
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual({ agents: [] });
});

it("rejects credential fields outside the Agent creation contract", () => {
  const parsed = newAgentRequestSchema.safeParse({
    id: "ed1e60c8-bdda-4f46-a857-bbd542f82640",
    name: "Research partner",
    role: "Researches questions and reports evidence",
    description: "A private colleague for research work.",
    nodeId: "c5342142-9cf5-4b22-86f3-bdc46bb471f2",
    model: { provider: "openai", id: "gpt-4.1" },
    apiKeyEnv: "OPENAI_API_KEY",
  });
  expect(parsed.success).toBe(false);
});

it("migrates paired-node control-plane data and enables Agent foreign keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-migration-"));
  const databasePath = join(directory, "control-plane.sqlite");
  const old = new Database(databasePath);
  old.exec(controlPlaneSchemaV4);
  old
    .prepare("INSERT INTO nodes(id,public_key,paired_at) VALUES(?,?,?)")
    .run("c5342142-9cf5-4b22-86f3-bdc46bb471f2", "fixture-key", 10);
  old.pragma("application_id = 1296257100");
  old.pragma("user_version = 4");
  old.close();

  const auth = new OwnerAuth({ dataDir: directory });
  try {
    expect(auth.db.pragma("user_version", { simple: true })).toBe(5);
    expect(auth.db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(auth.db.prepare("SELECT id FROM nodes").get()).toEqual({
      id: "c5342142-9cf5-4b22-86f3-bdc46bb471f2",
    });
    expect(
      auth.db.prepare("SELECT name FROM sqlite_master WHERE name='owner_agents'").get(),
    ).toEqual({
      name: "owner_agents",
    });
    expect(controlPlaneMigrations.map((migration) => migration.fromRevision)).toEqual([3, 4]);
  } finally {
    auth.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("sends only the bounded Agent provisioning operation to the selected online node", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId, socket } = await pairNode(app, cookie);
  const agentId = "ed1e60c8-bdda-4f46-a857-bbd542f82640";
  const requestId = randomUUID();
  const stages: string[] = [];
  const completed = app.nodes.provisionAgent(nodeId, requestId, agentId, (stage) =>
    stages.push(stage),
  );
  const command = JSON.parse(socket.sent.at(-1)!) as Record<string, unknown>;

  expect(command).toEqual({
    type: "control.agent.provision",
    requestId,
    agentId,
  });

  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.provision.progress",
      requestId,
      agentId,
      stage: "preparing_home",
    }),
  );
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.provision.result",
      requestId,
      agentId,
      ok: true,
      identity: {
        username: "mate_123456789012345678901234567",
        uid: 23001,
        gid: 23001,
        home: "/var/lib/mate/agents/ed1e60c8-bdda-4f46-a857-bbd542f82640",
      },
    }),
  );

  await expect(completed).resolves.toMatchObject({
    ok: true,
    identity: { uid: 23001, gid: 23001 },
  });
  expect(stages).toEqual(["preparing_home"]);
  expect(socket.sent.join("\n")).not.toContain("useradd");
});

it("persists a stable Agent session, verifies provisioning, then queues its initial-channel messages", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId, socket } = await pairNode(app, cookie);
  const channelResponse = await app.request("/api/owner/channels", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Research", description: "Research work", visibility: "private" }),
  });
  expect(channelResponse.status).toBe(201);
  const { id: channelId } = (await channelResponse.json()) as { id: string };
  const input = {
    id: "ed1e60c8-bdda-4f46-a857-bbd542f82640",
    name: "Research partner",
    role: "Researches questions and reports evidence",
    description: "A private colleague for research work.",
    nodeId,
    model: { provider: "openai", id: "gpt-4.1" },
    initialChannelId: channelId,
  };

  const creation = app.request("/api/owner/agents", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const command = JSON.parse(socket.sent.at(-1)!) as {
    type: string;
    requestId: string;
    agentId: string;
  };
  expect(command).toEqual({
    type: "control.agent.provision",
    requestId: expect.any(String),
    agentId: input.id,
  });
  expect(app.chat.inviteAgentToChannel(channelId, input.id)).toBe(false);
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.provision.progress",
      requestId: command.requestId,
      agentId: input.id,
      stage: "preparing_home",
    }),
  );
  const progressResponse = await app.request("/api/owner/agents", { headers: { cookie } });
  const progress = (await progressResponse.json()) as { agents: Array<{ stage: string }> };
  expect(progress.agents[0]?.stage).toBe("preparing_home");
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.provision.result",
      requestId: command.requestId,
      agentId: input.id,
      ok: true,
      identity: {
        username: "mate_ed1e60c8bdda4f46a857bbd542f",
        uid: 23001,
        gid: 23001,
        home: `/var/lib/mate/agents/${input.id}`,
      },
    }),
  );

  const response = await creation;
  expect(response.status).toBe(201);
  const { agent } = (await response.json()) as {
    agent: {
      id: string;
      sessionId: string;
      status: string;
      stage: string;
      model: { provider: string; id: string };
      linuxIdentity: { username: string; uid: number; gid: number; home: string };
    };
  };
  expect(agent).toMatchObject({
    id: input.id,
    status: "waiting_credentials",
    stage: "complete",
    model: input.model,
    linuxIdentity: {
      username: "mate_ed1e60c8bdda4f46a857bbd542f",
      uid: 23001,
      gid: 23001,
      home: `/var/lib/mate/agents/${input.id}`,
    },
  });
  expect(app.chat.inviteAgentToChannel(channelId, input.id)).toBe(true);
  const sentCount = socket.sent.length;
  const repeat = await app.request("/api/owner/agents", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  expect(repeat.status).toBe(200);
  expect(((await repeat.json()) as { agent: { sessionId: string } }).agent.sessionId).toBe(
    agent.sessionId,
  );
  expect(socket.sent).toHaveLength(sentCount);

  app.chat.createMessage(channelId, "A queued first message");
  expect(app.chat.listPendingDeliveries("agent", input.id).deliveries).toHaveLength(1);
});

it("retains one failed request and retries it with the same Agent and provisioning IDs", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId, socket } = await pairNode(app, cookie);
  const input = {
    id: "a82eb7db-26f7-40f8-9bb8-8baf21dc5c0a",
    name: "Writing partner",
    role: "Writes and edits",
    description: "A writing colleague.",
    nodeId,
    model: { provider: "openai", id: "gpt-4.1" },
  };
  const failedCreation = app.request("/api/owner/agents", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const firstCommand = JSON.parse(socket.sent.at(-1)!) as { requestId: string };
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.provision.result",
      requestId: firstCommand.requestId,
      agentId: input.id,
      ok: false,
      code: "permission_denied",
      message: "节点服务需要 root 权限才能建立 Agent Linux 账号。",
    }),
  );
  const failed = await failedCreation;
  expect(failed.status).toBe(502);
  const failedAgent = (await failed.json()) as { agent: { sessionId: string; status: string } };
  expect(failedAgent.agent.status).toBe("failed");

  const retry = app.request("/api/owner/agents", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const secondCommand = JSON.parse(socket.sent.at(-1)!) as {
    type: string;
    requestId: string;
    agentId: string;
  };
  expect(secondCommand).toEqual({
    ...firstCommand,
    type: "control.agent.provision",
    agentId: input.id,
  });
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.provision.result",
      requestId: secondCommand.requestId,
      agentId: input.id,
      ok: true,
      identity: {
        username: "mate_a82eb7db26f740f89bb88baf21d",
        uid: 23002,
        gid: 23002,
        home: `/var/lib/mate/agents/${input.id}`,
      },
    }),
  );
  const succeeded = await retry;
  expect(succeeded.status).toBe(200);
  const agent = (await succeeded.json()) as {
    agent: { id: string; sessionId: string; status: string };
  };
  expect(agent.agent).toMatchObject({
    id: input.id,
    sessionId: failedAgent.agent.sessionId,
    status: "waiting_credentials",
  });
});
