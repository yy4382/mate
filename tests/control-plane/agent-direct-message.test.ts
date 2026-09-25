import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
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
  return { app, cookie, directory, nodeId, socket };
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
  const room = app.chat.createChannel({
    name: "Batch room",
    description: "Synthetic shared-channel fixture.",
    visibility: "private",
  });
  expect(app.chat.inviteAgentToChannel(room.id, agentId)).toBe(true);
  app.chat.createMessage(room.id, "同一来源批次中的第一条频道输入。");
  app.chat.createMessage(room.id, "同一来源批次中的第二条频道输入。");
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
        cursor: 0,
        limit: 100,
      }),
    );
    return JSON.parse(socket.sent.at(-1)!) as {
      type: string;
      messages: Array<{ sequence: number; role: string; text: string }>;
      nextCursor: number | null;
    };
  };
  expect((await requestContext(firstRun.runId)).messages.map((message) => message.text)).toEqual([
    "同一来源批次中的第一条频道输入。",
    "同一来源批次中的第二条频道输入。",
  ]);

  app.chat.createMessage(room.id, "运行开始后才到达的下一条频道输入。");
  expect((await requestContext(firstRun.runId)).messages.map((message) => message.text)).toEqual([
    "同一来源批次中的第一条频道输入。",
    "同一来源批次中的第二条频道输入。",
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
    "同一来源批次中的第一条频道输入。",
    "同一来源批次中的第二条频道输入。",
    "第一批次的可见回复。",
    "运行开始后才到达的下一条频道输入。",
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
  expect(app.chat.listMessages(room.id, undefined, 20)?.messages).toMatchObject([
    { author: { kind: "human" }, text: "同一来源批次中的第一条频道输入。" },
    { author: { kind: "human" }, text: "同一来源批次中的第二条频道输入。" },
    { author: { kind: "human" }, text: "运行开始后才到达的下一条频道输入。" },
    { author: { kind: "agent", id: agentId }, text: "第一批次的可见回复。" },
  ]);
});

it("keeps a later private input out of a public channel run", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Source-aware partner",
    role: "Replies in the input channel",
    description: "Synthetic source-boundary fixture.",
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
  const publicRoom = app.chat.createChannel({
    name: "Public source room",
    description: "Synthetic public-channel fixture.",
    visibility: "public",
  });
  expect(app.chat.inviteAgentToChannel(publicRoom.id, agentId)).toBe(true);
  app.chat.createMessage(publicRoom.id, "公开输入必须触发公开频道 run。");
  app.chat.createMessage(direct.id, "这条私信不能进入公开回复。");

  const runStart = socket.sent.length;
  const credential = await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-source-batch-key" }),
  });
  expect(credential.status).toBe(204);
  const firstRun = await waitForRun(socket, runStart);
  expect(firstRun.channelId).toBe(publicRoom.id);

  const readContext = async (runId: string) => {
    await app.nodes.receive(
      socket,
      JSON.stringify({
        type: "node.agent.run.context",
        requestId: randomUUID(),
        runId,
        agentId,
        cursor: 0,
        limit: 100,
      }),
    );
    return JSON.parse(socket.sent.at(-1)!) as {
      messages: Array<{
        role: string;
        text: string;
        sourceChannelId?: string;
        sourceVisibility?: string;
        currentRunInput?: boolean;
      }>;
    };
  };
  const context = await readContext(firstRun.runId);
  expect(context.messages).toEqual([
    expect.objectContaining({
      role: "user",
      text: "公开输入必须触发公开频道 run。",
      sourceChannelId: publicRoom.id,
      sourceVisibility: "public",
      currentRunInput: true,
    }),
  ]);
  expect(firstRun).toMatchObject({ channelVisibility: "public" });

  const writeReply = async (runId: string, text: string) => {
    await app.nodes.receive(
      socket,
      JSON.stringify({
        type: "node.agent.run.journal",
        requestId: randomUUID(),
        runId,
        agentId,
        text,
      }),
    );
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: "control.agent.run.journal_ack",
      accepted: true,
    });
  };
  const finishRun = async (runId: string) => {
    await app.nodes.receive(
      socket,
      JSON.stringify({
        type: "node.agent.run.result",
        requestId: runId,
        runId,
        agentId,
        ok: true,
      }),
    );
  };

  await writeReply(firstRun.runId, "只回应公开频道输入。");
  expect(app.chat.listMessages(publicRoom.id, undefined, 20)?.messages.at(-1)).toMatchObject({
    author: { kind: "agent", id: agentId },
    text: "只回应公开频道输入。",
  });
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toMatchObject([
    { channelId: direct.id, message: { text: "这条私信不能进入公开回复。" } },
  ]);

  const privateRunStart = socket.sent.length;
  await finishRun(firstRun.runId);
  const privateRun = await waitForRun(socket, privateRunStart);
  expect(privateRun.channelId).toBe(direct.id);
  expect(privateRun).toMatchObject({ channelVisibility: "private" });
  const privateContext = await readContext(privateRun.runId);
  expect(privateContext.messages).toMatchObject([
    {
      role: "user",
      sourceChannelId: publicRoom.id,
      sourceVisibility: "public",
      currentRunInput: false,
    },
    {
      role: "assistant",
      text: "只回应公开频道输入。",
      sourceChannelId: publicRoom.id,
      sourceVisibility: "public",
      currentRunInput: false,
    },
    {
      role: "user",
      text: "这条私信不能进入公开回复。",
      sourceChannelId: direct.id,
      sourceVisibility: "private",
      currentRunInput: true,
    },
  ]);
  await writeReply(privateRun.runId, "私信输入在私信里得到回复。");
  expect(app.chat.listMessages(direct.id, undefined, 20)?.messages.at(-1)).toMatchObject({
    author: { kind: "agent", id: agentId },
    text: "私信输入在私信里得到回复。",
  });
  await finishRun(privateRun.runId);

  const sendMessage = async (channelId: string, text: string) => {
    const response = await app.request(`/api/owner/channels/${channelId}/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    expect(response.status).toBe(201);
  };
  const removed = await app.request("/api/owner/model-credentials/openai", {
    method: "DELETE",
    headers: { cookie },
  });
  expect(removed.status).toBe(204);
  await sendMessage(direct.id, "反向顺序的私信输入先到达。");
  await sendMessage(publicRoom.id, "后到的公开输入需要等待。");
  const reversePrivateStart = socket.sent.length;
  const restored = await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-source-batch-key" }),
  });
  expect(restored.status).toBe(204);
  const reversePrivateRun = await waitForRun(socket, reversePrivateStart);
  expect(reversePrivateRun.channelId).toBe(direct.id);
  const reversePrivateContext = await readContext(reversePrivateRun.runId);
  expect(reversePrivateContext.messages.at(-1)).toMatchObject({
    text: "反向顺序的私信输入先到达。",
    sourceChannelId: direct.id,
    sourceVisibility: "private",
    currentRunInput: true,
  });
  expect(reversePrivateContext.messages.map((message) => message.text)).not.toContain(
    "后到的公开输入需要等待。",
  );
  await writeReply(reversePrivateRun.runId, "反向顺序私信回复。");
  const reversePublicStart = socket.sent.length;
  await finishRun(reversePrivateRun.runId);

  const reversePublicRun = await waitForRun(socket, reversePublicStart);
  expect(reversePublicRun.channelId).toBe(publicRoom.id);
  const reversePublicContext = await readContext(reversePublicRun.runId);
  expect(
    reversePublicContext.messages.find((message) => message.text === "后到的公开输入需要等待。"),
  ).toMatchObject({
    text: "后到的公开输入需要等待。",
    sourceChannelId: publicRoom.id,
    sourceVisibility: "public",
    currentRunInput: true,
  });
  await writeReply(reversePublicRun.runId, "公开输入在公开频道里回复。");
  expect(app.chat.listMessages(publicRoom.id, undefined, 20)?.messages.at(-1)).toMatchObject({
    author: { kind: "agent", id: agentId },
    text: "公开输入在公开频道里回复。",
  });
  await finishRun(reversePublicRun.runId);
});

it("keeps an archived run input pending and retries it after the owner unarchives the channel", async () => {
  const { app, cookie, directory, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Recoverable archive partner",
    role: "Replies after its channel is restored",
    description: "Synthetic archived-run fixture.",
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
  app.chat.createMessage(direct.id, "归档期间不可写入回复的私信。");
  const runStart = socket.sent.length;
  const credential = await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-archive-race-key" }),
  });
  expect(credential.status).toBe(204);
  const run = await waitForRun(socket, runStart);

  const archive = await app.request(`/api/owner/channels/${direct.id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });
  expect(archive.status).toBe(200);
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.journal",
      requestId: randomUUID(),
      runId: run.runId,
      agentId,
      text: "归档后不得提交的回复。",
    }),
  );
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    type: "control.agent.run.journal_ack",
    accepted: false,
  });
  expect(app.chat.listMessages(direct.id, undefined, 20)?.messages).toMatchObject([
    { author: { kind: "human" }, text: "归档期间不可写入回复的私信。" },
  ]);

  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: run.runId,
      runId: run.runId,
      agentId,
      ok: false,
      code: "model_failed",
    }),
  );
  const db = new Database(join(directory, "control-plane", "control-plane.sqlite"), {
    readonly: true,
  });
  try {
    expect(
      db
        .prepare("SELECT state,error_code,retry_at FROM owner_agent_runs WHERE id=?")
        .get(run.runId),
    ).toEqual({ state: "failed", error_code: "channel_archived", retry_at: null });
  } finally {
    db.close();
  }
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toMatchObject([
    { message: { text: "归档期间不可写入回复的私信。" } },
  ]);

  const archivedRunCount = socket.sent.filter(
    (text) => JSON.parse(text).type === "control.agent.run",
  ).length;
  await new Promise((resolve) => setTimeout(resolve, 1700));
  expect(socket.sent.filter((text) => JSON.parse(text).type === "control.agent.run")).toHaveLength(
    archivedRunCount,
  );

  const retryStart = socket.sent.length;
  const unarchive = await app.request(`/api/owner/channels/${direct.id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ archived: false }),
  });
  expect(unarchive.status).toBe(200);
  const retry = await waitForRun(socket, retryStart);
  expect(retry.runId).not.toBe(run.runId);
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.journal",
      requestId: randomUUID(),
      runId: retry.runId,
      agentId,
      text: "频道恢复后的私信回复。",
    }),
  );
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    type: "control.agent.run.journal_ack",
    accepted: true,
  });
  expect(app.chat.listMessages(direct.id, undefined, 20)?.messages.at(-1)).toMatchObject({
    author: { kind: "agent", id: agentId },
    text: "频道恢复后的私信回复。",
  });
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toHaveLength(0);
});

it("does not let an archived earlier source block or join a later source run", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Fairly scheduled partner",
    role: "Processes each source when it is available",
    description: "Synthetic archived-source scheduling fixture.",
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
  const earlierSource = app.chat.createChannel({
    name: "Earlier private source",
    description: "Synthetic archived source.",
    visibility: "private",
  });
  expect(app.chat.inviteAgentToChannel(earlierSource.id, agentId)).toBe(true);
  const post = async (channelId: string, text: string) => {
    const response = await app.request(`/api/owner/channels/${channelId}/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    expect(response.status).toBe(201);
  };
  await post(earlierSource.id, "较早来源 A 的待处理私信。");
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toHaveLength(1);
  const archive = await app.request(`/api/owner/channels/${earlierSource.id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });
  expect(archive.status).toBe(200);
  await post(direct.id, "后续来源 B 的正常私信。");

  const runStart = socket.sent.length;
  const credential = await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-archived-source-key" }),
  });
  expect(credential.status).toBe(204);
  const laterRun = await waitForRun(socket, runStart);
  expect(laterRun.channelId).toBe(direct.id);

  const readContext = async (runId: string) => {
    await app.nodes.receive(
      socket,
      JSON.stringify({
        type: "node.agent.run.context",
        requestId: randomUUID(),
        runId,
        agentId,
        cursor: 0,
        limit: 100,
      }),
    );
    return JSON.parse(socket.sent.at(-1)!) as {
      messages: Array<{
        role: string;
        text: string;
        sourceChannelId: string;
        currentRunInput: boolean;
      }>;
    };
  };
  const laterContext = await readContext(laterRun.runId);
  expect(laterContext.messages).toMatchObject([
    {
      role: "user",
      text: "后续来源 B 的正常私信。",
      sourceChannelId: direct.id,
      currentRunInput: true,
    },
  ]);
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.journal",
      requestId: randomUUID(),
      runId: laterRun.runId,
      agentId,
      text: "只在来源 B 回复。",
    }),
  );
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    type: "control.agent.run.journal_ack",
    accepted: true,
  });
  expect(app.chat.listMessages(direct.id, undefined, 20)?.messages.at(-1)).toMatchObject({
    author: { kind: "agent", id: agentId },
    text: "只在来源 B 回复。",
  });
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toMatchObject([
    { channelId: earlierSource.id, message: { text: "较早来源 A 的待处理私信。" } },
  ]);
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: laterRun.runId,
      runId: laterRun.runId,
      agentId,
      ok: true,
    }),
  );

  const earlierRunStart = socket.sent.length;
  const unarchive = await app.request(`/api/owner/channels/${earlierSource.id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ archived: false }),
  });
  expect(unarchive.status).toBe(200);
  const earlierRun = await waitForRun(socket, earlierRunStart);
  expect(earlierRun.channelId).toBe(earlierSource.id);
  expect((await readContext(earlierRun.runId)).messages).toMatchObject([
    {
      role: "user",
      text: "后续来源 B 的正常私信。",
      sourceChannelId: direct.id,
      sourceVisibility: "private",
      currentRunInput: false,
    },
    {
      role: "assistant",
      text: "只在来源 B 回复。",
      sourceChannelId: direct.id,
      sourceVisibility: "private",
      currentRunInput: false,
    },
    {
      role: "user",
      text: "较早来源 A 的待处理私信。",
      sourceChannelId: earlierSource.id,
      currentRunInput: true,
    },
  ]);
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.journal",
      requestId: randomUUID(),
      runId: earlierRun.runId,
      agentId,
      text: "来源 A 恢复后得到回复。",
    }),
  );
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    type: "control.agent.run.journal_ack",
    accepted: true,
  });
  expect(app.chat.listMessages(earlierSource.id, undefined, 20)?.messages.at(-1)).toMatchObject({
    author: { kind: "agent", id: agentId },
    text: "来源 A 恢复后得到回复。",
  });
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toHaveLength(0);
});

it("pages handled session history before appending an older pending run input", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Long-session partner",
    role: "Continues a shared session",
    description: "Synthetic projection cursor fixture.",
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
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!,
    earlierSource = app.chat.createChannel({
      name: "Older source for projected input",
      description: "Synthetic pagination fixture.",
      visibility: "private",
    });
  expect(app.chat.inviteAgentToChannel(earlierSource.id, agentId)).toBe(true);
  const earlierInput = app.chat.createMessage(earlierSource.id, "较早 journal 序号的当前输入。");
  if (!earlierInput) throw new Error("Expected the archived source input to be created.");
  const earlierDelivery = app.chat.listPendingDeliveries("agent", agentId).deliveries[0]!;
  expect(earlierDelivery.messageId).toBe(earlierInput.id);
  const archive = await app.request(`/api/owner/channels/${earlierSource.id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });
  expect(archive.status).toBe(200);

  for (let index = 0; index < 101; index++) {
    const message = app.chat.createMessage(direct.id, `已处理历史 ${index}.`),
      delivery = app.chat
        .listPendingDeliveries("agent", agentId)
        .deliveries.find((candidate) => candidate.messageId === message?.id);
    if (!message) throw new Error("Expected the handled history message to be created.");
    expect(delivery).toBeDefined();
    expect(app.chat.acknowledgeDelivery(delivery!.id, "agent", agentId)).toBe(true);
  }
  const credential = await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-projection-cursor-key" }),
  });
  expect(credential.status).toBe(204);
  const runStart = socket.sent.length;
  const unarchive = await app.request(`/api/owner/channels/${earlierSource.id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ archived: false }),
  });
  expect(unarchive.status).toBe(200);
  const run = await waitForRun(socket, runStart);
  expect(run.channelId).toBe(earlierSource.id);

  const requestPage = async (cursor: number) => {
    await app.nodes.receive(
      socket,
      JSON.stringify({
        type: "node.agent.run.context",
        requestId: randomUUID(),
        runId: run.runId,
        agentId,
        cursor,
        limit: 100,
      }),
    );
    return JSON.parse(socket.sent.at(-1)!) as {
      messages: Array<{
        sequence: number;
        role: string;
        text: string;
        sourceChannelId: string;
        sourceVisibility: string;
        currentRunInput: boolean;
      }>;
      nextCursor: number | null;
    };
  };
  const firstPage = await requestPage(0);
  expect(firstPage.messages).toHaveLength(100);
  expect(firstPage.messages[0]).toMatchObject({
    role: "user",
    text: "已处理历史 0.",
    sourceChannelId: direct.id,
    sourceVisibility: "private",
    currentRunInput: false,
  });
  expect(firstPage.messages.at(-1)?.text).toBe("已处理历史 99.");
  expect(firstPage.nextCursor).toBe(100);
  if (firstPage.nextCursor === null) throw new Error("Expected a next context page.");

  const secondPage = await requestPage(firstPage.nextCursor);
  expect(secondPage.nextCursor).toBeNull();
  expect(secondPage.messages).toMatchObject([
    {
      role: "user",
      text: "已处理历史 100.",
      sourceChannelId: direct.id,
      sourceVisibility: "private",
      currentRunInput: false,
    },
    {
      role: "user",
      text: "较早 journal 序号的当前输入。",
      sourceChannelId: earlierSource.id,
      sourceVisibility: "private",
      currentRunInput: true,
    },
  ]);
  expect(secondPage.messages[0]!.sequence).toBeGreaterThan(secondPage.messages[1]!.sequence);
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toMatchObject([
    { channelId: earlierSource.id, message: { text: "较早 journal 序号的当前输入。" } },
  ]);
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: run.runId,
      runId: run.runId,
      agentId,
      ok: false,
      code: "model_failed",
    }),
  );
});
