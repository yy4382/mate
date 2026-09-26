import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/control-plane/http.js";
import type { NodeSocket } from "../../src/control-plane/nodes/directory.js";
import { runAgentModel, type AgentRunTransport } from "../../src/nodes/agent-runner.js";
import type { NodeControlMessage } from "../../src/nodes/protocol.js";
import type { ModelContextMessage } from "../../src/nodes/model-worker.js";

const password = "agent-direct-message-owner-password";
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
  dropToolCallId: string | undefined;
  send(data: string) {
    const message = JSON.parse(data) as { type?: string; toolCallId?: string };
    if (
      message.type === "control.agent.run.tool_result" &&
      message.toolCallId === this.dropToolCallId
    ) {
      this.dropToolCallId = undefined;
      return;
    }
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
  return { app, cookie, db, directory, nodeId, socket };
}

async function pairAnotherNode(
  app: ReturnType<typeof createControlPlaneApp>,
  cookie: string,
): Promise<{ nodeId: string; socket: FakeNodeSocket }> {
  const token = await app.request("/api/owner/nodes/pairing-tokens", {
    method: "POST",
    headers: { cookie },
  });
  const pairingToken = ((await token.json()) as { pairingToken: string }).pairingToken,
    socket = new FakeNodeSocket();
  app.nodes.open(socket);
  const challenge = JSON.parse(socket.sent[0]!) as { nonce: string },
    keyPair = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }),
    nodeId = randomUUID();
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
  return { nodeId, socket };
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

async function callAgentTool(
  app: ReturnType<typeof createControlPlaneApp>,
  socket: FakeNodeSocket,
  run: { runId: string; agentId: string },
  toolCallId: string,
  operation: string,
  input: Record<string, unknown>,
  identity: { agentId?: string } = {},
) {
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.tool",
      requestId: randomUUID(),
      runId: run.runId,
      agentId: identity.agentId ?? run.agentId,
      toolCallId,
      operation,
      input,
    }),
  );
  return JSON.parse(socket.sent.at(-1)!) as {
    type: string;
    runId: string;
    toolCallId: string;
    ok: boolean;
    error?: string;
    result?: unknown;
  };
}

async function callAgentRunContext(
  app: ReturnType<typeof createControlPlaneApp>,
  socket: FakeNodeSocket,
  run: { runId: string; agentId: string },
) {
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
  return JSON.parse(socket.sent.at(-1)!) as {
    type: string;
    messages: ModelContextMessage[];
    nextCursor: number | null;
  };
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

it("routes Agent conversation discovery through its current control-plane run", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Directory partner",
    role: "Discovers visible conversations",
    description: "Synthetic tool fixture.",
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
  const ownChannel = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  const publicRoom = app.chat.createChannel({
    name: "Discoverable room",
    description: "Public metadata is visible to every Agent.",
    visibility: "public",
  });
  const otherPrivateRoom = app.chat.createChannel({
    name: "Hidden room",
    description: "Private metadata is member-only.",
    visibility: "private",
  });
  app.chat.createMessage(ownChannel.id, "列出可见对话。");
  const runStart = socket.sent.length;
  const credential = await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  expect(credential.status).toBe(204);
  const run = await waitForRun(socket, runStart);

  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.tool",
      requestId: randomUUID(),
      runId: run.runId,
      agentId,
      toolCallId: "discover-1",
      operation: "tools.call",
      input: { name: "conversations.list", input: {} },
    }),
  );
  const result = JSON.parse(socket.sent.at(-1)!) as {
    type: string;
    toolCallId?: string;
    ok?: boolean;
    result?: { conversations: Array<{ id: string; name: string }> };
  };
  expect(result.type).toBe("control.agent.run.tool_result");
  expect(result).toMatchObject({ toolCallId: "discover-1", ok: true });
  expect(result.result?.conversations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: publicRoom.id, name: "Discoverable room" }),
      expect.objectContaining({ id: ownChannel.id }),
    ]),
  );
  expect(result.result?.conversations).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: otherPrivateRoom.id })]),
  );
});

it("limits read and send to joined conversations while exposing only public metadata", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Conversation member",
    role: "Uses explicitly authorized conversations",
    description: "Synthetic ACL fixture.",
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
  const ownDirect = app.chat.getOrCreateAgentDirectChannel(agentId)!,
    publicRoom = app.chat.createChannel({
      name: "Visible name",
      description: "Visible description only.",
      visibility: "public",
    }),
    privateRoom = app.chat.createChannel({
      name: "Secret project",
      description: "Only members can know this exists.",
      visibility: "private",
    });
  app.chat.createMessage(publicRoom.id, "Public message body.");
  app.chat.createMessage(privateRoom.id, "Private message body.");
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.createMessage(ownDirect.id, "Start a conversation tool run.");
  const run = await waitForRun(socket, runStart);

  const list = await callAgentTool(app, socket, run, "acl-list", "tools.call", {
    name: "conversations.list",
    input: {},
  });
  expect(list).toMatchObject({ type: "control.agent.run.tool_result", ok: true });
  const conversations = (list.result as { conversations: Array<Record<string, unknown>> })
    .conversations;
  expect(conversations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: publicRoom.id,
        name: "Visible name",
        description: "Visible description only.",
        member: false,
      }),
      expect.objectContaining({ id: ownDirect.id, kind: "dm", member: true }),
    ]),
  );
  expect(conversations).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: privateRoom.id })]),
  );
  expect(app.chat.listChannels().map((channel) => channel.id)).toContain(privateRoom.id);

  for (const [actionId, conversationId] of [
    ["read-public-nonmember", publicRoom.id],
    ["read-private-nonmember", privateRoom.id],
  ]) {
    const denied = await callAgentTool(app, socket, run, actionId!, "tools.call", {
      name: "conversations.read",
      input: { conversationId },
    });
    expect(denied).toMatchObject({ ok: false, error: "Conversation is not available" });
  }
  const taskIdDoesNotGrantAccess = await callAgentTool(
    app,
    socket,
    run,
    "task-id-is-not-access",
    "tools.call",
    {
      name: "conversations.read",
      input: { taskId: privateRoom.id },
    },
  );
  expect(taskIdDoesNotGrantAccess).toMatchObject({ ok: false, error: "Invalid tool input" });
  const publicSendDenied = await callAgentTool(
    app,
    socket,
    run,
    "send-public-nonmember",
    "tools.call",
    {
      name: "messages.send",
      input: { conversationId: publicRoom.id, text: "Must not be sent." },
    },
  );
  expect(publicSendDenied.ok).toBe(false);

  const sendInput = {
    name: "messages.send",
    input: { conversationId: ownDirect.id, text: "One explicit private reply." },
  };
  const firstSend = await callAgentTool(
      app,
      socket,
      run,
      "same-send-action-id",
      "tools.call",
      sendInput,
    ),
    retrySend = await callAgentTool(
      app,
      socket,
      run,
      "same-send-action-id",
      "tools.call",
      sendInput,
    );
  expect(firstSend).toMatchObject({ ok: true });
  expect(retrySend.result).toEqual(firstSend.result);
  const directMessages = app.chat.listMessages(ownDirect.id, undefined, 100)!.messages;
  expect(
    directMessages.filter((message) => message.text === "One explicit private reply."),
  ).toHaveLength(1);
  expect(
    app.chat
      .listAgentSessionJournal(agentId, 0, 100)
      .messages.filter(
        (message) => message.role === "assistant" && message.text === "One explicit private reply.",
      ),
  ).toHaveLength(1);
});

it("replays a committed tool action after its reply is lost and the delivery retries", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Retry partner",
    role: "Retries interrupted tool calls",
    description: "Synthetic action replay fixture.",
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
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.createMessage(direct.id, "Start retryable tool action.");
  const firstRun = await waitForRun(socket, runStart),
    actionId = "retry-after-lost-tool-result",
    input = {
      name: "messages.send",
      input: { conversationId: direct.id, text: "提交一次，即使回执丢失也不重复。" },
    };
  socket.dropToolCallId = actionId;
  const sentBeforeToolCall = socket.sent.length;
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.tool",
      requestId: randomUUID(),
      runId: firstRun.runId,
      agentId,
      toolCallId: actionId,
      operation: "tools.call",
      input,
    }),
  );
  expect(socket.sent).toHaveLength(sentBeforeToolCall);
  const original = db
    .prepare("SELECT result_json FROM owner_agent_tool_actions WHERE session_id=? AND action_id=?")
    .get(firstRun.sessionId, actionId) as { result_json: string } | undefined;
  expect(original).toBeDefined();
  const originalResult = JSON.parse(original!.result_json) as unknown;
  expect(
    app.chat
      .listMessages(direct.id, undefined, 100)!
      .messages.filter((message) => message.text === input.input.text),
  ).toHaveLength(1);

  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: randomUUID(),
      runId: firstRun.runId,
      agentId,
      ok: false,
      code: "model_failed",
    }),
  );
  db.prepare("UPDATE owner_agent_runs SET retry_at=0 WHERE id=?").run(firstRun.runId);
  const retryStart = socket.sent.length;
  app.runs?.wake();
  const retryRun = await waitForRun(socket, retryStart);
  expect(retryRun.runId).not.toBe(firstRun.runId);
  expect(retryRun.sessionId).toBe(firstRun.sessionId);

  const replay = await callAgentTool(app, socket, retryRun, actionId, "tools.call", input);
  expect(replay).toMatchObject({ ok: true, result: originalResult });
  expect(
    app.chat
      .listMessages(direct.id, undefined, 100)!
      .messages.filter((message) => message.text === input.input.text),
  ).toHaveLength(1);
  expect(
    db
      .prepare("SELECT count(*) AS count FROM owner_agent_tool_actions WHERE session_id=?")
      .get(firstRun.sessionId),
  ).toEqual({ count: 1 });
});

it("recovers the completed tool action and result in the Agent's next run context", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Context recovery partner",
    role: "Recovers committed conversation actions",
    description: "Synthetic action-history fixture.",
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
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const firstRunStart = socket.sent.length;
  app.chat.createMessage(direct.id, "Start a tool action whose receipt must survive.");
  const firstRun = await waitForRun(socket, firstRunStart),
    toolMessage = "提交后断连的频道消息。",
    action = await callAgentTool(app, socket, firstRun, "durable-context-action", "tools.call", {
      name: "messages.send",
      input: { conversationId: direct.id, text: toolMessage },
    });
  expect(action.ok).toBe(true);
  expect(
    app.chat.commitAgentReply(firstRun.runId, nodeId, agentId, randomUUID(), "已完成。", false),
  ).toBe(true);
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: randomUUID(),
      runId: firstRun.runId,
      agentId,
      ok: true,
    }),
  );

  const secondRunStart = socket.sent.length;
  app.chat.createMessage(direct.id, "Continue after the completed action.");
  const secondRun = await waitForRun(socket, secondRunStart),
    recovered = await callAgentRunContext(app, socket, secondRun);
  expect(recovered.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: "assistant", text: toolMessage }),
      expect.objectContaining({
        role: "assistant",
        text: expect.stringContaining("messages.send"),
      }),
    ]),
  );
  expect(
    db
      .prepare("SELECT run_id,tool_action_id FROM owner_agent_session_journal WHERE text=?")
      .get(toolMessage),
  ).toMatchObject({ run_id: firstRun.runId, tool_action_id: "durable-context-action" });
});

it("restarts the real Pi worker after a lost result without replaying a committed send", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Durable action partner",
    role: "Retries a delivery after a tool result is lost",
    description: "Synthetic Pi restart fixture.",
    model: { provider: "openai", id: "gpt-4o-mini" },
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
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-key-durable-action-pair" }),
  });

  const piCallIds: string[][] = [],
    observedContexts: ModelContextMessage[][] = [],
    resultAcks: Promise<void>[] = [];
  const transportFor = (
    run: Extract<NodeControlMessage, { type: "control.agent.run" }>,
    controller: AbortController,
    dropFirstToolReply = false,
  ): AgentRunTransport => {
    let dropped = false;
    return {
      context: async () => {
        const page = await callAgentRunContext(app, socket, run);
        observedContexts.push(page.messages);
        return { messages: page.messages, nextCursor: page.nextCursor };
      },
      journal: async (text) => {
        const requestId = randomUUID();
        await app.nodes.receive(
          socket,
          JSON.stringify({
            type: "node.agent.run.journal",
            requestId,
            runId: run.runId,
            agentId,
            text,
          }),
        );
        return (
          (JSON.parse(socket.sent.at(-1)!) as { type: string; accepted?: boolean }).accepted ===
          true
        );
      },
      tool: async (toolCallId, operation, input) => {
        const requestId = randomUUID(),
          before = socket.sent.length;
        piCallIds[piCallIds.length - 1]!.push(toolCallId);
        await app.nodes.receive(
          socket,
          JSON.stringify({
            type: "node.agent.run.tool",
            requestId,
            runId: run.runId,
            agentId,
            toolCallId,
            operation,
            input,
          }),
        );
        const reply = JSON.parse(socket.sent.at(before)!) as
          { ok: true; result: unknown } | { ok: false; error: string };
        if (dropFirstToolReply && !dropped) {
          dropped = true;
          controller.abort("simulate a dropped control-plane result");
          throw new Error("The committed tool result was lost during disconnect");
        }
        return reply.ok ? { ok: true, result: reply.result } : { ok: false, error: reply.error };
      },
      result: (ok, code) => {
        resultAcks.push(
          app.nodes.receive(
            socket,
            JSON.stringify({
              type: "node.agent.run.result",
              requestId: randomUUID(),
              runId: run.runId,
              agentId,
              ok,
              ...(ok ? {} : { code: code ?? "model_failed" }),
            }),
          ),
        );
      },
    };
  };
  const startRun = async (
    run: Extract<NodeControlMessage, { type: "control.agent.run" }>,
    dropFirstToolReply: boolean,
  ) => {
    const controller = new AbortController();
    piCallIds.push([]);
    await runAgentModel(
      run as Parameters<typeof runAgentModel>[0],
      transportFor(run, controller, dropFirstToolReply),
      controller.signal,
      { modelWorkerEntry: resolve("tests/fixtures/direct-message-model-worker.mjs") },
    );
  };

  const firstStart = socket.sent.length;
  app.chat.createMessage(direct.id, "运行带有两次相同发送的脚本化 Agent。 ");
  const firstRun = await waitForRun(socket, firstStart);
  const firstActionScopeId = firstRun.actionScopeId;
  await startRun(firstRun, true);
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: randomUUID(),
      runId: firstRun.runId,
      agentId,
      ok: false,
      code: "model_failed",
    }),
  );
  db.prepare("UPDATE owner_agent_runs SET retry_at=0 WHERE id=?").run(firstRun.runId);

  const retryStart = socket.sent.length;
  app.runs?.wake();
  const retryRun = await waitForRun(socket, retryStart);
  expect(retryRun.runId).not.toBe(firstRun.runId);
  expect(retryRun.actionScopeId).toBe(firstActionScopeId);
  await startRun(retryRun, false);
  await Promise.all(resultAcks);

  const messagesAfterRetry = app.chat.listMessages(direct.id, undefined, 100)!.messages,
    retryActionRows = db
      .prepare(
        "SELECT action_id,operation FROM owner_agent_tool_actions ORDER BY created_at,action_id",
      )
      .all() as Array<{ action_id: string; operation: string }>;
  expect(
    messagesAfterRetry.filter((message) => message.text === "同一交付中的重复动作。"),
  ).toHaveLength(2);
  expect(
    messagesAfterRetry.filter((message) => message.text === "参数不同，属于新的动作。"),
  ).toHaveLength(1);
  expect(retryActionRows).toHaveLength(3);
  expect(retryActionRows.every((action) => action.operation === "messages.send")).toBe(true);
  expect(piCallIds[0]).toHaveLength(1);
  expect(piCallIds[1]).toHaveLength(3);
  expect(piCallIds[1]![0]).toBe(piCallIds[0]![0]);
  expect(piCallIds[1]![1]!.split(":").slice(0, 3)).toEqual(
    piCallIds[1]![0]!.split(":").slice(0, 3),
  );
  expect(piCallIds[1]![1]).not.toBe(piCallIds[1]![0]);
  expect(piCallIds[1]![2]).not.toBe(piCallIds[1]![1]);
  expect(observedContexts[1]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: "assistant", text: "同一交付中的重复动作。" }),
      expect.objectContaining({
        role: "assistant",
        text: expect.stringContaining("messages.send"),
      }),
    ]),
  );

  const nextDeliveryStart = socket.sent.length;
  app.chat.createMessage(direct.id, "请在新的交付中再发送同样的两条消息。");
  const nextRun = await waitForRun(socket, nextDeliveryStart);
  expect(nextRun.actionScopeId).not.toBe(firstActionScopeId);
  await startRun(nextRun, false);
  await Promise.all(resultAcks);
  expect(
    app.chat
      .listMessages(direct.id, undefined, 100)!
      .messages.filter((message) => message.text === "同一交付中的重复动作。"),
  ).toHaveLength(4);
  expect(
    app.chat
      .listMessages(direct.id, undefined, 100)!
      .messages.filter((message) => message.text === "参数不同，属于新的动作。"),
  ).toHaveLength(2);
  expect(
    db
      .prepare("SELECT count(*) AS count FROM owner_agent_tool_actions WHERE session_id=?")
      .get(firstRun.sessionId),
  ).toEqual({ count: 6 });
});

it("commits an eligible peer invitation once and rejects invalid invitation targets", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const inviterId = randomUUID(),
    inviteeId = randomUUID(),
    unverifiedId = randomUUID();
  for (const [agentId, name] of [
    [inviterId, "Inviter"],
    [inviteeId, "Invitee"],
  ] as const) {
    app.agents.prepare({
      id: agentId,
      nodeId,
      name,
      role: "Conversation colleague",
      description: "Synthetic invitation fixture.",
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
  }
  app.agents.prepare({
    id: unverifiedId,
    nodeId,
    name: "Unverified target",
    role: "Unprovisioned",
    description: "Must not be invited.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  const room = app.chat.createChannel({
    name: "Team room",
    description: "A shared room.",
    visibility: "private",
  });
  expect(app.chat.inviteAgentToChannel(room.id, inviterId)).toBe(true);
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.createMessage(room.id, "Start invitation run.");
  const run = await waitForRun(socket, runStart);
  const inviteInput = {
    name: "conversations.invite",
    input: { conversationId: room.id, agentId: inviteeId },
  };
  const invite = await callAgentTool(
      app,
      socket,
      run,
      "same-invite-action-id",
      "tools.call",
      inviteInput,
    ),
    replay = await callAgentTool(
      app,
      socket,
      run,
      "same-invite-action-id",
      "tools.call",
      inviteInput,
    );
  expect(invite).toMatchObject({ ok: true });
  expect(replay.result).toEqual(invite.result);
  expect(
    db
      .prepare(
        "SELECT active FROM owner_channel_memberships WHERE channel_id=? AND principal_kind='agent' AND principal_id=?",
      )
      .get(room.id, inviteeId),
  ).toEqual({ active: 1 });
  expect(
    db
      .prepare("SELECT count(*) AS count FROM owner_agent_tool_actions WHERE session_id=?")
      .get(run.sessionId),
  ).toEqual({ count: 1 });

  for (const [actionId, targetId, conversationId] of [
    ["invite-self", inviterId, room.id],
    ["invite-unverified", unverifiedId, room.id],
    ["invite-to-dm", inviteeId, app.chat.getOrCreateAgentDirectChannel(inviterId)!.id],
  ]) {
    const denied = await callAgentTool(app, socket, run, actionId!, "tools.call", {
      name: "conversations.invite",
      input: { conversationId, agentId: targetId },
    });
    expect(denied.ok).toBe(false);
  }
});

it("lets the owner invite an existing Agent to a channel through the authenticated web API", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Owner-invited colleague",
    role: "Reads a channel after owner invitation",
    description: "Synthetic owner invitation fixture.",
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
  const unverifiedAgentId = randomUUID();
  app.agents.prepare({
    id: unverifiedAgentId,
    nodeId,
    name: "Unverified owner-invitation target",
    role: "Has no verified identity yet",
    description: "Must not be admitted by the owner route.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  const channel = app.chat.createChannel({
    name: "Owner-managed channel",
    description: "Existing Agents can be invited by the owner.",
    visibility: "private",
  });
  app.chat.createMessage(channel.id, "邀请之前的历史也应对新成员可读。");
  const route = `/api/owner/channels/${channel.id}/invitations`,
    ownerDm = app.chat.getOrCreateAgentDirectChannel(agentId)!,
    invitableChannels = await app.request("/api/owner/invitable-channels", { headers: { cookie } }),
    invitableBody = (await invitableChannels.json()) as { channels: Array<{ id: string }> };
  expect(invitableChannels.status).toBe(200);
  expect(invitableBody.channels.map((item) => item.id)).toContain(channel.id);
  expect(invitableBody.channels.map((item) => item.id)).not.toContain(ownerDm.id);

  const unverifiedInvite = await app.request(route, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ agentId: unverifiedAgentId }),
  });
  expect(unverifiedInvite.status).toBe(409);
  expect(
    db
      .prepare(
        "SELECT active FROM owner_channel_memberships WHERE channel_id=? AND principal_kind='agent' AND principal_id=?",
      )
      .get(channel.id, unverifiedAgentId),
  ).toBeUndefined();
  const unauthenticated = await app.request(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId }),
  });
  expect(unauthenticated.status).toBe(401);

  const invite = await app.request(route, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ agentId }),
  });
  expect(invite.status).toBe(201);
  expect(await invite.json()).toMatchObject({
    channelId: channel.id,
    agentId,
    status: "joined",
  });
  expect(
    db
      .prepare(
        "SELECT active FROM owner_channel_memberships WHERE channel_id=? AND principal_kind='agent' AND principal_id=?",
      )
      .get(channel.id, agentId),
  ).toEqual({ active: 1 });
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toHaveLength(0);
  const privateDmInvite = await app.request(`/api/owner/channels/${ownerDm.id}/invitations`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ agentId }),
  });
  expect(privateDmInvite.status).toBe(409);

  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.createMessage(channel.id, "邀请提交后，新成员立即获得读取权限。");
  const run = await waitForRun(socket, runStart),
    read = await callAgentTool(app, socket, run, "owner-invite-read", "tools.call", {
      name: "conversations.read",
      input: { conversationId: channel.id },
    });
  expect(read).toMatchObject({ ok: true });
  expect(
    (read.result as { messages: Array<{ text: string }> }).messages.map((message) => message.text),
  ).toEqual(["邀请之前的历史也应对新成员可读。", "邀请提交后，新成员立即获得读取权限。"]);
});

it("lets one Agent discover and open an explicit peer DM that both Agents and the owner can read", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const firstAgentId = randomUUID(),
    secondAgentId = randomUUID(),
    unverifiedId = randomUUID(),
    failedAgentId = randomUUID();
  for (const [agentId, name] of [
    [firstAgentId, "First colleague"],
    [secondAgentId, "Second colleague"],
  ] as const) {
    app.agents.prepare({
      id: agentId,
      nodeId,
      name,
      role: "Collaborates through direct messages",
      description: "Synthetic peer DM fixture.",
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
  }
  app.agents.prepare({
    id: unverifiedId,
    nodeId,
    name: "Unverified colleague",
    role: "Not available for contact",
    description: "Unprovisioned test identity.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.prepare({
    id: failedAgentId,
    nodeId,
    name: "Failed colleague",
    role: "Unavailable for contact",
    description: "Synthetic failed provisioning state.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.fail(failedAgentId, "Synthetic provisioning failure.");
  const firstDirect = app.chat.getOrCreateAgentDirectChannel(firstAgentId)!;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.createMessage(firstDirect.id, "Start peer DM run.");
  const firstRun = await waitForRun(socket, runStart);
  const discover = await callAgentTool(app, socket, firstRun, "agents-list", "tools.call", {
    name: "agents.list",
    input: {},
  });
  expect(discover.result).toMatchObject({
    agents: [expect.objectContaining({ id: secondAgentId, name: "Second colleague" })],
  });
  expect(JSON.stringify(discover.result)).not.toContain(unverifiedId);
  expect(JSON.stringify(discover.result)).not.toContain(failedAgentId);
  const selfDm = await callAgentTool(app, socket, firstRun, "self-dm", "tools.call", {
    name: "conversations.open_dm",
    input: { targetAgentId: firstAgentId },
  });
  expect(selfDm).toMatchObject({
    ok: false,
    error: "An Agent cannot open a direct message with itself",
  });
  const invalidDm = await callAgentTool(app, socket, firstRun, "unverified-dm", "tools.call", {
    name: "conversations.open_dm",
    input: { targetAgentId: unverifiedId },
  });
  expect(invalidDm).toMatchObject({ ok: false, error: "Direct-message target is not available" });
  const failedDm = await callAgentTool(app, socket, firstRun, "failed-dm", "tools.call", {
    name: "conversations.open_dm",
    input: { targetAgentId: failedAgentId },
  });
  expect(failedDm).toMatchObject({ ok: false, error: "Direct-message target is not available" });

  const openInput = { name: "conversations.open_dm", input: { targetAgentId: secondAgentId } },
    secondRunStart = socket.sent.length,
    opened = await callAgentTool(
      app,
      socket,
      firstRun,
      "same-open-dm-action",
      "tools.call",
      openInput,
    ),
    openedAgain = await callAgentTool(
      app,
      socket,
      firstRun,
      "same-open-dm-action",
      "tools.call",
      openInput,
    );
  expect(opened).toMatchObject({ ok: true });
  expect(openedAgain.result).toEqual(opened.result);
  const peerDm = opened.result as {
    id: string;
    name: string;
    visibility: string;
  };
  expect(peerDm.visibility).toBe("private");
  expect(peerDm.name).toContain("First colleague");
  expect(peerDm.name).toContain("Second colleague");
  expect(app.chat.listChannels().map((channel) => channel.id)).toContain(peerDm.id);
  const ownerChannels = await app.request("/api/owner/channels", { headers: { cookie } });
  expect(ownerChannels.status).toBe(200);
  const listedOwnerChannels = (await ownerChannels.json()) as {
    channels: Array<{ id: string; name: string; description: string }>;
  };
  const listedPeerDm = listedOwnerChannels.channels.find((channel) => channel.id === peerDm.id);
  expect(listedPeerDm?.name).toBe(peerDm.name);
  expect(listedPeerDm?.description).toContain("First colleague");
  expect(listedPeerDm?.description).toContain("Second colleague");
  const members = db
    .prepare(
      "SELECT principal_kind,principal_id,active FROM owner_channel_memberships WHERE channel_id=? ORDER BY principal_kind,principal_id",
    )
    .all(peerDm.id);
  expect(members).toEqual(
    expect.arrayContaining([
      { principal_kind: "agent", principal_id: firstAgentId, active: 1 },
      { principal_kind: "agent", principal_id: secondAgentId, active: 1 },
      { principal_kind: "human", principal_id: "owner", active: 1 },
    ]),
  );
  expect(
    db.prepare("SELECT count(*) AS count FROM owner_agent_peer_direct_channels").get(),
  ).toEqual({ count: 1 });

  const sent = await callAgentTool(app, socket, firstRun, "peer-message", "tools.call", {
    name: "messages.send",
    input: { conversationId: peerDm.id, text: "来自第一位同伴的消息。" },
  });
  expect(sent.ok).toBe(true);
  const secondRun = await waitForRun(socket, secondRunStart);
  expect(secondRun.agentId).toBe(secondAgentId);
  const reverseOpen = await callAgentTool(app, socket, secondRun, "reverse-open-dm", "tools.call", {
    name: "conversations.open_dm",
    input: { targetAgentId: firstAgentId },
  });
  expect(reverseOpen).toMatchObject({
    ok: true,
    result: expect.objectContaining({ id: peerDm.id }),
  });
  const received = await callAgentTool(app, socket, secondRun, "peer-read", "tools.call", {
    name: "conversations.read",
    input: { conversationId: peerDm.id },
  });
  expect(received).toMatchObject({
    ok: true,
    result: {
      messages: [
        expect.objectContaining({
          text: "来自第一位同伴的消息。",
          author: { kind: "agent", id: firstAgentId },
        }),
      ],
    },
  });
  const ownerMessages = await app.request(`/api/owner/channels/${peerDm.id}/messages`, {
    headers: { cookie },
  });
  expect(ownerMessages.status).toBe(200);
  expect(await ownerMessages.json()).toMatchObject({
    messages: [expect.objectContaining({ text: "来自第一位同伴的消息。" })],
  });
});

it("uses the persisted independent-review seat and refuses stale or forged tool runs", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Independent reviewer",
    role: "Checks a clean input path",
    description: "Synthetic reviewer fixture.",
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
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.createMessage(direct.id, "Start reviewer run.");
  const run = await waitForRun(socket, runStart);
  db.prepare("UPDATE owner_agent_runs SET independent_review=1 WHERE id=?").run(run.runId);

  const listed = await callAgentTool(app, socket, run, "review-tools-list", "tools.list", {});
  expect(listed).toMatchObject({ ok: true, result: { tools: [] } });
  const directCall = await callAgentTool(app, socket, run, "review-direct-call", "tools.call", {
    name: "conversations.list",
    input: {},
  });
  expect(directCall).toMatchObject({
    ok: false,
    error: "Independent review seat isolates this input path",
  });

  const otherNode = await pairAnotherNode(app, cookie),
    forgedNode = await callAgentTool(app, otherNode.socket, run, "forged-node-call", "tools.call", {
      name: "messages.send",
      input: { conversationId: direct.id, text: "Forged node must not send." },
    });
  expect(forgedNode).toMatchObject({ type: "control.error", code: "invalid_identity" });
  const forgedAgent = await callAgentTool(
    app,
    socket,
    run,
    "forged-agent-call",
    "tools.call",
    {
      name: "messages.send",
      input: { conversationId: direct.id, text: "Forged agent must not send." },
    },
    { agentId: randomUUID() },
  );
  expect(forgedAgent).toMatchObject({ type: "control.error", code: "invalid_identity" });

  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: randomUUID(),
      runId: run.runId,
      agentId,
      ok: true,
    }),
  );
  const stale = await callAgentTool(app, socket, run, "stale-call", "tools.call", {
    name: "conversations.list",
    input: {},
  });
  expect(stale).toMatchObject({ ok: false, error: "Agent run is no longer active" });
  expect(
    app.chat.listMessages(direct.id, undefined, 100)!.messages.map((message) => message.text),
  ).not.toContain("Forged node must not send.");
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
