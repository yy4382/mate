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

const password = "agent-run-transcript-owner-password";
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
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-run-transcript-"));
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
    role: "Records its own turns",
    description: "Synthetic run-transcript fixture.",
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
    body: JSON.stringify({ apiKey: "synthetic-transcript-key" }),
  });
  expect(credential.status).toBe(204);
  return { agentId, dm };
}

async function waitForRun(
  socket: FakeNodeSocket,
  fromIndex: number,
): Promise<Extract<NodeControlMessage, { type: "control.agent.run" }>> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    for (const text of socket.sent.slice(fromIndex)) {
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message.type === "control.agent.run")
        return message as unknown as Extract<NodeControlMessage, { type: "control.agent.run" }>;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The queued Agent input did not start a run");
}

async function receiveTranscript(
  app: ReturnType<typeof createControlPlaneApp>,
  socket: FakeNodeSocket,
  run: { runId: string; agentId: string },
  requestId: string,
  text: string,
): Promise<{ type: string; accepted?: boolean }> {
  const fromIndex = socket.sent.length;
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.transcript",
      requestId,
      runId: run.runId,
      agentId: run.agentId,
      text,
    }),
  );
  return JSON.parse(socket.sent[fromIndex]!) as { type: string; accepted?: boolean };
}

async function finishRun(
  app: ReturnType<typeof createControlPlaneApp>,
  socket: FakeNodeSocket,
  run: { runId: string; agentId: string },
  ok = true,
): Promise<void> {
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
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const response = socket.sent.slice(fromIndex).findLast((text) => {
      const message = JSON.parse(text) as { type?: string; toolCallId?: string };
      return message.type === "control.agent.run.tool_result" && message.toolCallId === toolCallId;
    });
    if (response) return JSON.parse(response) as { ok?: boolean; error?: string; result?: unknown };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Agent tool ${toolCallId} did not return a result`);
}

async function readRunContext(
  app: ReturnType<typeof createControlPlaneApp>,
  socket: FakeNodeSocket,
  run: { runId: string; agentId: string },
): Promise<ModelContextMessage[]> {
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
  return (
    JSON.parse(socket.sent.at(-1)!) as {
      messages: ModelContextMessage[];
      nextCursor: number | null;
    }
  ).messages;
}

function journalEntries(
  db: InstanceType<typeof Database>,
  agentId: string,
): Array<{ role: string; text: string; message_id: string | null; run_id: string | null }> {
  return db
    .prepare(
      "SELECT role,text,message_id,run_id FROM owner_agent_session_journal WHERE agent_id=? ORDER BY seq",
    )
    .all(agentId) as Array<{
    role: string;
    text: string;
    message_id: string | null;
    run_id: string | null;
  }>;
}

/** Agent-authored message events, which is what the owner event stream projects to the page. */
function agentMessageEvents(
  db: InstanceType<typeof Database>,
): Array<{ channel_id: string; text: string }> {
  return db
    .prepare(
      `SELECT channel_id,json_extract(payload,'$.text') AS text FROM owner_chat_events
       WHERE kind='message.created' AND json_extract(payload,'$.author.kind')='agent'
       ORDER BY seq`,
    )
    .all() as Array<{ channel_id: string; text: string }>;
}

function agentAuthoredMessages(db: InstanceType<typeof Database>, agentId: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM owner_messages WHERE author_kind='agent' AND author_id=?",
      )
      .get(agentId) as { count: number }
  ).count;
}

it("keeps a plain model turn in the Agent session record and publishes nothing", async () => {
  const fixture = await setup();
  const { app, db, socket } = fixture;
  const { agentId, dm } = await prepareAgent(fixture, "Quiet partner");
  const privateText = "这段正文只应写进我自己的会话记录。";

  const firstStart = socket.sent.length;
  app.chat.createMessage(dm, "先做一次内部检查，不必回复我。");
  const firstRun = await waitForRun(socket, firstStart);
  expect(await receiveTranscript(app, socket, firstRun, randomUUID(), privateText)).toMatchObject({
    type: "control.agent.run.transcript_ack",
    accepted: true,
  });

  // The source conversation and the web-visible message list learn nothing.
  expect(app.chat.listMessages(dm, undefined, 20)!.messages).toMatchObject([
    { author: { kind: "human" }, text: "先做一次内部检查，不必回复我。" },
  ]);
  expect(agentAuthoredMessages(db, agentId)).toBe(0);
  // The owner event stream is projected from owner_chat_events, so nothing Agent-authored can
  // reach the page either.
  expect(agentMessageEvents(db)).toEqual([]);
  // The turn is still durable and private: no published message is attached to it.
  expect(journalEntries(db, agentId)).toMatchObject([
    { role: "user", text: "先做一次内部检查，不必回复我。", message_id: expect.any(String) },
    { role: "assistant", text: privateText, message_id: null, run_id: firstRun.runId },
  ]);

  await finishRun(app, socket, firstRun);

  // The next run rebuilds the same logical session and can still read that text.
  const secondStart = socket.sent.length;
  app.chat.createMessage(dm, "现在接着之前的检查继续。");
  const secondRun = await waitForRun(socket, secondStart);
  expect(secondRun.sessionId).toBe(firstRun.sessionId);
  expect(await readRunContext(app, socket, secondRun)).toMatchObject([
    { role: "user", text: "先做一次内部检查，不必回复我。", currentRunInput: false },
    { role: "assistant", text: privateText, currentRunInput: false },
    { role: "user", text: "现在接着之前的检查继续。", currentRunInput: true },
  ]);
  expect(agentAuthoredMessages(db, agentId)).toBe(0);
});

it("acknowledges one transcript request once and refuses a changed or late one", async () => {
  const fixture = await setup();
  const { app, db, socket } = fixture;
  const { agentId, dm } = await prepareAgent(fixture, "Replay partner");

  const start = socket.sent.length;
  app.chat.createMessage(dm, "记录一次正文。");
  const run = await waitForRun(socket, start);
  const requestId = randomUUID(),
    text = "只记录一次的正文。";
  expect(await receiveTranscript(app, socket, run, requestId, text)).toMatchObject({
    accepted: true,
  });
  // A duplicate delivery of the same request is acknowledged without a second record.
  expect(await receiveTranscript(app, socket, run, requestId, text)).toMatchObject({
    accepted: true,
  });
  // The same request identity carrying different text is refused.
  expect(await receiveTranscript(app, socket, run, requestId, "改过的正文。")).toMatchObject({
    type: "control.agent.run.transcript_ack",
    accepted: false,
  });
  expect(journalEntries(db, agentId).filter((entry) => entry.role === "assistant")).toEqual([
    expect.objectContaining({ text }),
  ]);

  // A later distinct turn of the same running run is a new record, not a refusal.
  const secondTurnRequestId = randomUUID();
  expect(
    await receiveTranscript(app, socket, run, secondTurnRequestId, "同一运行的第二个回合。"),
  ).toMatchObject({ accepted: true });
  expect(journalEntries(db, agentId).filter((entry) => entry.role === "assistant")).toEqual([
    expect.objectContaining({ text }),
    expect.objectContaining({ text: "同一运行的第二个回合。" }),
  ]);

  await finishRun(app, socket, run);
  // After the run ends only an exact replay of what was recorded is accepted.
  expect(await receiveTranscript(app, socket, run, requestId, text)).toMatchObject({
    accepted: true,
  });
  expect(await receiveTranscript(app, socket, run, randomUUID(), text)).toMatchObject({
    type: "control.agent.run.transcript_ack",
    accepted: false,
  });
  expect(
    await receiveTranscript(app, socket, run, secondTurnRequestId, "同一运行的第二个回合。"),
  ).toMatchObject({ type: "control.agent.run.transcript_ack", accepted: true });
  expect(journalEntries(db, agentId).filter((entry) => entry.role === "assistant")).toHaveLength(2);
});

it("marks only the covered deliveries handled and never completes their task", async () => {
  const fixture = await setup();
  const { app, db, socket } = fixture;
  const { agentId, dm } = await prepareAgent(fixture, "Task-keeping partner");

  const start = socket.sent.length;
  app.chat.createMessage(dm, "把这件工作变成任务。");
  const run = await waitForRun(socket, start);
  const created = await callAgentTool(app, socket, run, "task-creating-send", {
    name: "messages.send",
    input: { conversationId: dm, text: "我认领这项工作的任务锚点。", asTask: true },
  });
  expect(created).toMatchObject({ ok: true });
  expect(app.chat.listTasks()).toMatchObject([
    { channelId: dm, status: "open", ownerAgentId: null },
  ]);

  await receiveTranscript(app, socket, run, randomUUID(), "我先看一下这项工作。");
  await finishRun(app, socket, run);

  // The successful turn covers its own input; the task stays exactly as the Agent left it.
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toHaveLength(0);
  expect(app.chat.listTasks()).toMatchObject([
    { channelId: dm, status: "open", ownerAgentId: null },
  ]);

  // Speaking explicitly is not task completion either.
  const speakingStart = socket.sent.length;
  app.chat.createMessage(dm, "汇报一下进展。");
  const speakingRun = await waitForRun(socket, speakingStart);
  const task = app.chat.listTasks()[0]!;
  const claim = await callAgentTool(app, socket, speakingRun, "task-claiming-tool", {
    name: "tasks.claim",
    input: { taskId: task.id, expectedVersion: task.version },
  });
  expect(claim).toMatchObject({ ok: true });
  expect(app.chat.listTasks()).toMatchObject([{ status: "in_progress", ownerAgentId: agentId }]);
  await receiveTranscript(app, socket, speakingRun, randomUUID(), "我准备用工具发言。");
  const spoken = await callAgentTool(app, socket, speakingRun, "speaking-send", {
    name: "messages.send",
    input: { conversationId: dm, text: "进展顺利，任务仍在进行中。" },
  });
  expect(spoken).toMatchObject({ ok: true });
  await finishRun(app, socket, speakingRun);
  expect(app.chat.listTasks()).toMatchObject([{ status: "in_progress", ownerAgentId: agentId }]);
  expect(
    app.chat
      .listMessages(dm, undefined, 20)!
      .messages.filter((message) => message.text === "进展顺利，任务仍在进行中。"),
  ).toHaveLength(1);
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM owner_agent_session_journal WHERE agent_id=? AND role='assistant' AND tool_action_id IS NULL",
      )
      .get(agentId),
  ).toEqual({ count: 2 });
});

it("speaks only in the conversation the model chose, with the existing authorization", async () => {
  const fixture = await setup();
  const { app, db, socket } = fixture;
  const { agentId, dm } = await prepareAgent(fixture, "Destination partner");
  const other = app.chat.createChannel({
    name: "Chosen destination",
    description: "Synthetic explicit-send fixture.",
    visibility: "private",
  });
  expect(app.chat.inviteAgentToChannel(other.id, agentId)).toBe(true);
  const forbidden = app.chat.createChannel({
    name: "Not joined",
    description: "Synthetic unauthorized destination.",
    visibility: "private",
  });
  const privateText = "内部思考不应出现在任何对话里。";

  const start = socket.sent.length;
  app.chat.createMessage(dm, "请把结论发到另一个对话。");
  const run = await waitForRun(socket, start);
  expect(await receiveTranscript(app, socket, run, randomUUID(), privateText)).toMatchObject({
    accepted: true,
  });
  expect(
    await callAgentTool(app, socket, run, "send-elsewhere", {
      name: "messages.send",
      input: { conversationId: other.id, text: "结论只发到这里。" },
    }),
  ).toMatchObject({ ok: true });
  expect(
    await callAgentTool(app, socket, run, "send-forbidden", {
      name: "messages.send",
      input: { conversationId: forbidden.id, text: "我不应该能发到这里。" },
    }),
  ).toMatchObject({ ok: false });

  await finishRun(app, socket, run);
  expect(app.chat.listMessages(other.id, undefined, 20)!.messages).toMatchObject([
    { author: { kind: "agent", id: agentId }, text: "结论只发到这里。" },
  ]);
  // The run's own conversation and the private turn stay free of any published Agent message.
  expect(app.chat.listMessages(dm, undefined, 20)!.messages).toMatchObject([
    { author: { kind: "human" } },
  ]);
  expect(app.chat.listMessages(forbidden.id, undefined, 20)!.messages).toEqual([]);
  expect(agentAuthoredMessages(db, agentId)).toBe(1);
  expect(
    db
      .prepare("SELECT COUNT(*) AS count FROM owner_messages WHERE channel_id=? AND text=?")
      .get(dm, privateText),
  ).toEqual({ count: 0 });
  // The page receives exactly one Agent message event and it belongs to the chosen conversation.
  expect(agentMessageEvents(db)).toMatchObject([{ channel_id: other.id }]);
});

it("publishes an explicit thread send only inside the thread it names", async () => {
  const fixture = await setup();
  const { app, socket } = fixture;
  const { agentId, dm } = await prepareAgent(fixture, "Thread partner");
  const root = app.chat.createMessage(dm, "讨论串根消息。")!;

  const start = socket.sent.length;
  app.chat.createMessage(dm, "请在讨论串里回答。");
  const run = await waitForRun(socket, start);
  await receiveTranscript(app, socket, run, randomUUID(), "讨论串回复的私有草稿。");
  expect(
    await callAgentTool(app, socket, run, "thread-send", {
      name: "messages.send",
      input: { conversationId: dm, text: "只属于这条讨论串的回答。", rootId: root.id },
    }),
  ).toMatchObject({ ok: true });
  await finishRun(app, socket, run);

  // The reply is visible inside the thread and absent from the channel's main timeline.
  expect(app.chat.listThread(dm, root.id)!.replies).toMatchObject([
    { author: { kind: "agent", id: agentId }, rootId: root.id, text: "只属于这条讨论串的回答。" },
  ]);
  expect(app.chat.listMessages(dm, undefined, 20)!.messages).toMatchObject([
    { author: { kind: "human" }, text: "讨论串根消息。" },
    { author: { kind: "human" }, text: "请在讨论串里回答。" },
  ]);
});
