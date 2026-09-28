import { consumeContextPage } from "../helpers/session.js";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/control-plane/http.js";
import type { NodeSocket } from "../../src/control-plane/nodes/directory.js";
import type { NodeControlMessage } from "../../src/nodes/protocol.js";
import type { ModelContextMessage } from "../../src/nodes/model-worker.js";

const password = "agent-run-notice-owner-password";
const fixtures: Array<{
  app: ReturnType<typeof createControlPlaneApp>;
  directory: string;
  db: InstanceType<typeof Database>;
}> = [];

afterEach(() => {
  for (const { app, directory, db } of fixtures.splice(0)) {
    db.close();
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
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-run-notice-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  const app = createControlPlaneApp({ dataDir: join(directory, "control-plane"), passwordFile });
  const db = new Database(join(directory, "control-plane", "control-plane.sqlite"));
  fixtures.push({ app, directory, db });
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
  return { app, cookie, db, nodeId, socket, directory };
}

/** Provision one Agent on the fake node and return its private owner conversation. */
async function prepareAgent(
  fixture: Awaited<ReturnType<typeof setup>>,
  name: string,
): Promise<{ agentId: string; dm: string }> {
  const { app, cookie, nodeId } = fixture;
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name,
    role: "Reads notices during a run",
    description: "Synthetic run-notice fixture.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: "mate_" + agentId.replaceAll("-", "").slice(0, 27),
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${agentId}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  const dm = app.chat.getOrCreateAgentDirectChannel(agentId)!.id;
  const credential = await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-notice-key" }),
  });
  expect(credential.status).toBe(204);
  return { agentId, dm };
}

type StartedRun = Extract<NodeControlMessage, { type: "control.agent.run" }>;

function sentMessages(socket: FakeNodeSocket, fromIndex: number): Array<Record<string, unknown>> {
  return socket.sent.slice(fromIndex).map((text) => JSON.parse(text) as Record<string, unknown>);
}

async function waitForMessage(
  socket: FakeNodeSocket,
  fromIndex: number,
  type: string,
  timeoutMs = 4000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = sentMessages(socket, fromIndex).find((message) => message.type === type);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`The control plane did not send ${type}`);
}

async function waitForRun(socket: FakeNodeSocket, fromIndex: number): Promise<StartedRun> {
  return (await waitForMessage(socket, fromIndex, "control.agent.run")) as unknown as StartedRun;
}

async function finishRun(
  app: ReturnType<typeof createControlPlaneApp>,
  socket: FakeNodeSocket,
  run: { runId: string; agentId: string },
  ok = true,
): Promise<void> {
  await readRunContext(app, socket, run);
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: randomUUID(),
      runId: run.runId,
      agentId: run.agentId,
      ok,
      ...(ok ? {} : { code: "model_failed" }),
    }),
  );
}

async function callAgentTool(
  app: ReturnType<typeof createControlPlaneApp>,
  socket: FakeNodeSocket,
  run: { runId: string; agentId: string },
  toolCallId: string,
  input: Record<string, unknown>,
): Promise<{ ok?: boolean; error?: string; result?: unknown }> {
  const fromIndex = socket.sent.length;
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.tool",
      requestId: randomUUID(),
      runId: run.runId,
      agentId: run.agentId,
      toolCallId,
      operation: "tools.call",
      input,
    }),
  );
  const response = await waitForMessage(socket, fromIndex, "control.agent.run.tool_result");
  return response as { ok?: boolean; error?: string; result?: unknown };
}

async function readRunContext(
  app: ReturnType<typeof createControlPlaneApp>,
  socket: FakeNodeSocket,
  run: { runId: string; agentId: string },
) {
  const fromIndex = socket.sent.length;
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.context",
      requestId: randomUUID(),
      runId: run.runId,
      agentId: run.agentId,
      cursor: 0,
      limit: 100,
    }),
  );
  const response = await waitForMessage(socket, fromIndex, "control.agent.run.context");
  return (await consumeContextPage(app, socket, run.runId, run.agentId)).messages;
}

function attention(
  db: InstanceType<typeof Database>,
  agentId: string,
  messageId: string,
): { unread: number; seen: number; deferred: number; presented: number } {
  return db
    .prepare(
      "SELECT unread,seen,deferred,presented FROM owner_agent_message_attention WHERE agent_id=? AND message_id=?",
    )
    .get(agentId, messageId) as {
    unread: number;
    seen: number;
    deferred: number;
    presented: number;
  };
}

function messageIdOf(db: InstanceType<typeof Database>, channelId: string, text: string): string {
  const row = db
    .prepare("SELECT id FROM owner_messages WHERE channel_id=? AND text=?")
    .get(channelId, text) as { id: string } | undefined;
  if (!row) throw new Error("Expected the synthetic message to exist");
  return row.id;
}

it("notifies a run in progress that a message arrived, with no body and no second run", async () => {
  const fixture = await setup();
  const { app, db, socket } = fixture;
  const { agentId, dm } = await prepareAgent(fixture, "Busy partner");

  const firstStart = socket.sent.length;
  app.chat.createMessage(dm, "第一条：先做当前工作。");
  const run = await waitForRun(socket, firstStart);

  // A message that arrives while the run is in progress.
  const noticeStart = socket.sent.length;
  const busyText = "忙中到达的第二条消息正文。";
  app.chat.createMessage(dm, busyText);
  const notice = await waitForMessage(socket, noticeStart, "control.agent.run.notice");

  // The notice names the run and the source conversation and carries nothing else: no message
  // text, no delivery identity, no attention change.
  expect(Object.keys(notice).sort()).toEqual([
    "agentId",
    "conversationId",
    "requestId",
    "runId",
    "type",
  ]);
  expect(notice).toMatchObject({ runId: run.runId, agentId, conversationId: dm });
  expect(JSON.stringify(notice)).not.toContain(busyText);

  // No second authorized run and no duplicated session for the busy message.
  expect(
    sentMessages(socket, firstStart).filter((message) => message.type === "control.agent.run"),
  ).toHaveLength(1);
  // The busy message stays in the pending queue (beside the input the run has not completed
  // yet), and the notice neither read nor presented it.
  expect(
    app.chat
      .listPendingDeliveries("agent", agentId)
      .deliveries.map((delivery) => delivery.message.text),
  ).toEqual(["第一条：先做当前工作。", busyText]);
  expect(attention(db, agentId, messageIdOf(db, dm, busyText))).toMatchObject({
    unread: 1,
    seen: 0,
    presented: 0,
  });

  await finishRun(app, socket, run);
});

it("keeps a busy message for the next run of the same session and notices it only once", async () => {
  const fixture = await setup();
  const { app, db, socket } = fixture;
  const { agentId, dm } = await prepareAgent(fixture, "Deferring partner");

  const firstStart = socket.sent.length;
  app.chat.createMessage(dm, "第一条：先做当前工作。");
  const firstRun = await waitForRun(socket, firstStart);

  const noticeStart = socket.sent.length;
  const busyText = "忙中到达的第二条消息正文。";
  app.chat.createMessage(dm, busyText);
  await waitForMessage(socket, noticeStart, "control.agent.run.notice");
  // A second scheduler tick must not repeat the same notice.
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(
    sentMessages(socket, noticeStart).filter(
      (message) => message.type === "control.agent.run.notice",
    ),
  ).toHaveLength(1);

  // The run ends without covering the message that arrived after its boundary.
  const secondStart = socket.sent.length;
  await finishRun(app, socket, firstRun);
  const secondRun = await waitForRun(socket, secondStart);

  expect(secondRun.sessionId).toBe(firstRun.sessionId);
  expect(secondRun.runId).not.toBe(firstRun.runId);
  // The next run of the same session sees the busy message as its own input, not as history.
  expect(await readRunContext(app, socket, secondRun)).toMatchObject([
    { text: "第一条：先做当前工作。", currentRunInput: false },
    { text: busyText, currentRunInput: true },
  ]);
  // While the second run is in progress there is nothing new to notice.
  expect(
    sentMessages(socket, secondStart).filter(
      (message) => message.type === "control.agent.run.notice",
    ),
  ).toHaveLength(0);

  await finishRun(app, socket, secondRun);
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toHaveLength(0);
});

it("lets the run read a busy message with its own tool without marking it handled", async () => {
  const fixture = await setup();
  const { app, db, socket } = fixture;
  const { agentId, dm } = await prepareAgent(fixture, "Reading partner");

  const firstStart = socket.sent.length;
  app.chat.createMessage(dm, "第一条：先做当前工作。");
  const run = await waitForRun(socket, firstStart);

  const noticeStart = socket.sent.length;
  const busyText = "忙中到达的第二条消息正文。";
  app.chat.createMessage(dm, busyText);
  await waitForMessage(socket, noticeStart, "control.agent.run.notice");
  const busyMessageId = messageIdOf(db, dm, busyText);

  // Seeing the notice changed nothing; an explicit read is what presents the body.
  expect(attention(db, agentId, busyMessageId)).toMatchObject({ unread: 1, presented: 0 });
  const read = await callAgentTool(app, socket, run, "busy-read", {
    name: "conversations.read",
    input: { conversationId: dm, limit: 20 },
  });
  expect(read).toMatchObject({ ok: true });
  expect(JSON.stringify(read.result)).toContain(busyText);
  expect(attention(db, agentId, busyMessageId)).toMatchObject({
    unread: 1,
    presented: 1,
  });
  // Reading during the run is not run completion: the delivery is still pending for the next run.
  expect(
    app.chat
      .listPendingDeliveries("agent", agentId)
      .deliveries.map((delivery) => delivery.message.text),
  ).toEqual(["第一条：先做当前工作。", busyText]);

  // The Agent may defer it explicitly, and that stays a separate fact from the notice.
  const deferred = await callAgentTool(app, socket, run, "busy-defer", {
    name: "attention.update",
    input: { conversationId: dm, messageId: busyMessageId, deferred: true },
  });
  expect(deferred).toMatchObject({ ok: true });
  expect(attention(db, agentId, busyMessageId)).toMatchObject({
    unread: 1,
    seen: 0,
    deferred: 1,
    presented: 1,
  });

  await finishRun(app, socket, run);
});

it("notices each message that arrives during one run", async () => {
  const fixture = await setup();
  const { app, socket } = fixture;
  const { agentId, dm } = await prepareAgent(fixture, "Burst partner");
  const other = app.chat.createChannel({
    name: "Second source",
    description: "Synthetic second busy source.",
    visibility: "private",
  });
  expect(app.chat.inviteAgentToChannel(other.id, agentId)).toBe(true);

  const firstStart = socket.sent.length;
  app.chat.createMessage(dm, "第一条：先做当前工作。");
  const run = await waitForRun(socket, firstStart);

  const noticeStart = socket.sent.length;
  app.chat.createMessage(dm, "同一对话里忙中到达的消息。");
  app.chat.createMessage(other.id, "另一个对话里忙中到达的消息。");
  const deadline = Date.now() + 4000;
  let notices: Array<Record<string, unknown>> = [];
  while (Date.now() < deadline) {
    notices = sentMessages(socket, noticeStart).filter(
      (message) => message.type === "control.agent.run.notice",
    );
    if (notices.length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(notices).toHaveLength(2);
  expect(notices.map((notice) => notice.conversationId).sort()).toEqual([dm, other.id].sort());
  expect(notices.every((notice) => notice.runId === run.runId)).toBe(true);

  await finishRun(app, socket, run);
});

it("announces more arrivals than one scheduler pass carries", async () => {
  const fixture = await setup();
  const { app, socket } = fixture;
  const { dm } = await prepareAgent(fixture, "Burst partner");

  const firstStart = socket.sent.length;
  app.chat.createMessage(dm, "第一条：先做当前工作。");
  const run = await waitForRun(socket, firstStart);

  const noticeStart = socket.sent.length,
    arrivals = 120;
  for (let index = 0; index < arrivals; index++)
    app.chat.createMessage(dm, `忙中到达的第 ${index} 条消息。`);
  const deadline = Date.now() + 8000;
  let notices: Array<Record<string, unknown>> = [];
  while (Date.now() < deadline) {
    notices = sentMessages(socket, noticeStart).filter(
      (message) => message.type === "control.agent.run.notice",
    );
    if (notices.length >= arrivals) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Every arrival past the per-pass limit is announced on a later pass, not starved by it.
  expect(notices).toHaveLength(arrivals);
  expect(notices.every((notice) => notice.runId === run.runId)).toBe(true);

  await finishRun(app, socket, run);
});

it("does not notice a run it does not own", async () => {
  const fixture = await setup();
  const { app, socket, nodeId } = fixture;
  const { agentId, dm } = await prepareAgent(fixture, "Unknown-run partner");

  const firstStart = socket.sent.length;
  app.chat.createMessage(dm, "第一条：先做当前工作。");
  const run = await waitForRun(socket, firstStart);
  // A run this control plane never admitted, and the wrong Agent on a run it did admit, get
  // nothing: only a run this control plane still owns may be told.
  expect(app.nodes.notifyAgentRun(nodeId, randomUUID(), agentId, dm)).toBe(false);
  expect(app.nodes.notifyAgentRun(nodeId, run.runId, randomUUID(), dm)).toBe(false);
  const noticeStart = socket.sent.length;
  expect(app.nodes.notifyAgentRun(nodeId, run.runId, agentId, dm)).toBe(true);
  await waitForMessage(socket, noticeStart, "control.agent.run.notice");

  await finishRun(app, socket, run);
});

it("refuses a deactivated run's message and tool actions while the Agent stays deactivated", async () => {
  const fixture = await setup();
  const { app, cookie, socket } = fixture;
  const { agentId, dm } = await prepareAgent(fixture, "Deactivated partner");

  const firstStart = socket.sent.length;
  app.chat.createMessage(dm, "先做当前工作。");
  const run = await waitForRun(socket, firstStart);

  // The owner deactivates the Agent: the running model process is cancelled and the run loses its
  // authorization, so anything it still sends is refused instead of being accepted late.
  const pause = await app.request(`/api/owner/agents/${agentId}/pause`, {
    method: "POST",
    headers: { cookie },
  });
  expect(pause.status).toBe(200);
  expect(app.runs?.pauseReason(agentId)).toBe("manual");
  expect(
    fixture.db.prepare("SELECT state,error_code FROM owner_agent_runs WHERE id=?").get(run.runId),
  ).toEqual({ state: "failed", error_code: "manual_pause" });

  const refused = await callAgentTool(app, socket, run, "deactivated-send", {
    name: "messages.send",
    input: { conversationId: dm, text: "停用后不应发出的消息。" },
  });
  expect(refused).toMatchObject({ ok: false });
  expect(
    fixture.db
      .prepare("SELECT COUNT(*) AS count FROM owner_messages WHERE text=?")
      .get("停用后不应发出的消息。"),
  ).toEqual({ count: 0 });

  const listStart = socket.sent.length;
  await callAgentTool(app, socket, run, "deactivated-list", { name: "tools.list", input: {} });
  expect(JSON.parse(socket.sent[listStart]!)).toMatchObject({ ok: false });

  // The Agent stays deactivated: no new run is authorized for this Agent while it is paused.
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(
    sentMessages(socket, firstStart).filter(
      (message) => message.type === "control.agent.run" && message.runId !== run.runId,
    ),
  ).toHaveLength(0);
});

it("does not notice a run that already finished, and the next run still sees the message", async () => {
  const fixture = await setup();
  const { app, socket } = fixture;
  const { agentId, dm } = await prepareAgent(fixture, "Late partner");

  const firstStart = socket.sent.length;
  app.chat.createMessage(dm, "第一条：先做当前工作。");
  const firstRun = await waitForRun(socket, firstStart);
  await finishRun(app, socket, firstRun);

  const secondStart = socket.sent.length;
  const lateText = "运行结束后才到达的消息。";
  app.chat.createMessage(dm, lateText);
  const secondRun = await waitForRun(socket, secondStart);
  expect(
    sentMessages(socket, secondStart).filter(
      (message) => message.type === "control.agent.run.notice",
    ),
  ).toHaveLength(0);
  expect(await readRunContext(app, socket, secondRun)).toMatchObject([
    { text: "第一条：先做当前工作。", currentRunInput: false },
    { text: lateText, currentRunInput: true },
  ]);

  await finishRun(app, socket, secondRun);
});
