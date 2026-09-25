import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/control-plane/http.js";
import type { NodeSocket } from "../../src/control-plane/nodes/directory.js";

const password = "agent-direct-message-owner-password";
const fixtures: Array<{ app: ReturnType<typeof createControlPlaneApp>; directory: string }> = [];

afterEach(() => {
  for (const { app, directory } of fixtures.splice(0)) {
    app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakeNodeSocket implements NodeSocket {
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  terminate() {}
}

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-direct-message-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  const app = createControlPlaneApp({ dataDir: join(directory, "control-plane"), passwordFile });
  fixtures.push({ app, directory });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
  const token = await app.request("/api/owner/nodes/pairing-tokens", {
    method: "POST",
    headers: { cookie },
  });
  const pairingToken = ((await token.json()) as { pairingToken: string }).pairingToken;
  const socket = new FakeNodeSocket();
  app.nodes.open(socket);
  const challenge = JSON.parse(socket.sent[0]!) as { nonce: string };
  const keyPair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const nodeId = randomUUID();
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.pair",
      requestId: randomUUID(),
      nodeId,
      pairingToken,
      publicKey: keyPair.publicKey,
      signature: sign(null, Buffer.from(challenge.nonce), keyPair.privateKey).toString("base64url"),
    }),
  );
  return { app, cookie, nodeId, socket };
}

async function waitForRun(
  socket: FakeNodeSocket,
  fromIndex: number,
): Promise<{ runId: string; agentId: string; sessionId: string; channelId: string }> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    for (const text of socket.sent.slice(fromIndex)) {
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message.type === "control.agent.run")
        return message as {
          runId: string;
          agentId: string;
          sessionId: string;
          channelId: string;
        };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The queued Agent input did not start a run");
}

it("creates one private owner DM and keeps its input queued while the Agent awaits credentials", async () => {
  const { app, cookie, nodeId } = await setup();
  const agentId = randomUUID();
  const prepared = app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Research partner",
    role: "Answers private messages",
    description: "A private colleague.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: "mate_" + agentId.replaceAll("-", "").slice(0, 27),
      uid: 23001,
      gid: 23001,
      home: `/var/lib/mate/agents/${agentId}`,
    },
    app.chat,
  );
  expect(prepared.agent.sessionId).toBe(app.agents.get(agentId)?.sessionId);

  const direct = await app.request(`/api/owner/agents/${agentId}/direct-channel`, {
    method: "POST",
    headers: { cookie },
  });
  expect(direct.status).toBe(200);
  const { channel } = (await direct.json()) as { channel: { id: string; visibility: string } };
  expect(channel.visibility).toBe("private");
  const repeated = await app.request(`/api/owner/agents/${agentId}/direct-channel`, {
    method: "POST",
    headers: { cookie },
  });
  expect(((await repeated.json()) as { channel: { id: string } }).channel.id).toBe(channel.id);

  const post = await app.request(`/api/owner/channels/${channel.id}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "请给我一个简短研究计划。" }),
  });
  expect(post.status).toBe(201);
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toHaveLength(1);
  expect(app.chat.listAgentSessionJournal(agentId, 0, 10).messages).toMatchObject([
    { role: "user", text: "请给我一个简短研究计划。" },
  ]);
  expect(app.agents.get(agentId)?.status).toBe("waiting_credentials");
});

it("limits each run to its committed input batch and consumes silent batches", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Batch partner",
    role: "Processes queued messages",
    description: "Synthetic run-boundary fixture.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: "mate_" + agentId.replaceAll("-", "").slice(0, 27),
      uid: 23001,
      gid: 23001,
      home: `/var/lib/mate/agents/${agentId}`,
    },
    app.chat,
  );
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  const room = app.chat.createChannel({
    name: "Batch room",
    description: "Synthetic shared-channel fixture.",
    visibility: "private",
  });
  expect(app.chat.inviteAgentToChannel(room.id, agentId)).toBe(true);
  app.chat.createMessage(direct.id, "批次中的第一条私信输入。");
  app.chat.createMessage(room.id, "批次中的第二条频道输入。");
  const firstRunStart = socket.sent.length;
  const writes = await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-batch-key" }),
  });
  expect(writes.status).toBe(204);

  const firstRun = await waitForRun(socket, firstRunStart);
  const requestContext = async (runId: string) => {
    await app.nodes.receive(
      socket,
      JSON.stringify({
        type: "node.agent.run.context",
        requestId: randomUUID(),
        runId,
        agentId,
        after: 0,
        limit: 100,
      }),
    );
    return JSON.parse(socket.sent.at(-1)!) as {
      type: string;
      messages: Array<{ sequence: number; role: string; text: string }>;
      nextAfter: number | null;
    };
  };
  expect((await requestContext(firstRun.runId)).messages.map((message) => message.text)).toEqual([
    "批次中的第一条私信输入。",
    "批次中的第二条频道输入。",
  ]);

  app.chat.createMessage(room.id, "运行开始后才到达的下一条频道输入。");
  expect((await requestContext(firstRun.runId)).messages.map((message) => message.text)).toEqual([
    "批次中的第一条私信输入。",
    "批次中的第二条频道输入。",
  ]);
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.journal",
      requestId: randomUUID(),
      runId: firstRun.runId,
      agentId,
      text: "第一批次的可见回复。",
    }),
  );
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    type: "control.agent.run.journal_ack",
    accepted: true,
  });
  expect(
    app.chat.listAgentSessionJournal(agentId, 0, 100).messages.map((message) => message.text),
  ).toContain("第一批次的可见回复。");
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toMatchObject([
    { message: { text: "运行开始后才到达的下一条频道输入。" } },
  ]);
  expect(app.agents.get(agentId)?.sessionId).toBe(firstRun.sessionId);

  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: firstRun.runId,
      runId: firstRun.runId,
      agentId,
      ok: true,
    }),
  );
  const secondRunStart = socket.sent.length,
    secondRun = await waitForRun(socket, secondRunStart);
  expect(secondRun.sessionId).toBe(firstRun.sessionId);
  await requestContext(secondRun.runId);
  const secondContext = JSON.parse(socket.sent.at(-1)!) as {
    messages: Array<{ sequence: number; role: string; text: string }>;
  };
  expect(secondContext.messages.map((message) => message.text)).toEqual([
    "批次中的第一条私信输入。",
    "批次中的第二条频道输入。",
    "运行开始后才到达的下一条频道输入。",
    "第一批次的可见回复。",
  ]);
  // A successful model turn may choose silence; the batch is still committed as processed.
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: secondRun.runId,
      runId: secondRun.runId,
      agentId,
      ok: true,
    }),
  );
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toHaveLength(0);
  expect(app.chat.listMessages(direct.id, undefined, 20)?.messages).toMatchObject([
    { author: { kind: "human" }, text: "批次中的第一条私信输入。" },
    { author: { kind: "agent", id: agentId }, text: "第一批次的可见回复。" },
  ]);
  expect(app.chat.listMessages(room.id, undefined, 20)?.messages).toMatchObject([
    { author: { kind: "human" }, text: "批次中的第二条频道输入。" },
    { author: { kind: "human" }, text: "运行开始后才到达的下一条频道输入。" },
  ]);
});
