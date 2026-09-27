import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import Database from "better-sqlite3";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createControlPlaneApp } from "../../src/control-plane/http.js";
import { WorkspaceService } from "../../src/control-plane/workspace.js";
import type { NodeSocket } from "../../src/control-plane/nodes/directory.js";
import { runAgentModel, type AgentRunTransport } from "../../src/nodes/agent-runner.js";
import type { NodeControlMessage } from "../../src/nodes/protocol.js";
import type { ModelContextMessage } from "../../src/nodes/model-worker.js";

const password = "agent-direct-message-owner-password";
type OwnerMessageLike = { id: string; text: string };
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
  onWorkspaceOperation?: (message: Record<string, unknown>) => void | Promise<void>;
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
    if (message.type === "control.workspace.operation")
      void this.onWorkspaceOperation?.(message as Record<string, unknown>);
  }
  close() {}
  terminate() {}
}

async function setup(options: { nodeOperationTimeoutMs?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-direct-message-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  const app = createControlPlaneApp({
    dataDir: join(directory, "control-plane"),
    passwordFile,
    ...(options.nodeOperationTimeoutMs !== undefined
      ? { nodeOperationTimeoutMs: options.nodeOperationTimeoutMs }
      : {}),
  });
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
  return {
    app,
    cookie,
    db,
    directory,
    nodeId,
    socket,
    keyPair,
    nodePrivateKey: keyPair.privateKey,
  };
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

async function reconnectNode(
  app: ReturnType<typeof createControlPlaneApp>,
  nodeId: string,
  privateKey: string,
): Promise<FakeNodeSocket> {
  const socket = new FakeNodeSocket();
  app.nodes.open(socket);
  const challenge = JSON.parse(socket.sent[0]!) as { nonce: string };
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.authenticate",
      requestId: randomUUID(),
      nodeId,
      signature: sign(null, Buffer.from(challenge.nonce), privateKey).toString("base64url"),
    }),
  );
  expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual(
    expect.objectContaining({ type: "control.authenticated", nodeId }),
  );
  return socket;
}

async function prepareVerifiedAgent(
  app: ReturnType<typeof createControlPlaneApp>,
  nodeId: string,
  name: string,
  uid: number,
) {
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name,
    role: "Uses explicitly authorized conversations",
    description: "Synthetic ACL fixture.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: "mate_" + agentId.replaceAll("-", "").slice(0, 27),
      uid,
      gid: uid,
      home: `/var/lib/mate/agents/${agentId}`,
      homeMarker: "a".repeat(64),
    },
    app.chat,
  );
  return agentId;
}

async function finishRun(
  app: ReturnType<typeof createControlPlaneApp>,
  socket: FakeNodeSocket,
  run: { runId: string; agentId: string },
) {
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: randomUUID(),
      runId: run.runId,
      agentId: run.agentId,
      ok: true,
    }),
  );
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
  const fromIndex = socket.sent.length,
    requestId = randomUUID();
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.tool",
      requestId,
      runId: run.runId,
      agentId: identity.agentId ?? run.agentId,
      toolCallId,
      operation,
      input,
    }),
  );
  const deadline = Date.now() + 4000;
  let response: string | undefined;
  while (Date.now() < deadline) {
    response = socket.sent.slice(fromIndex).findLast((text) => {
      const message = JSON.parse(text) as {
        type?: string;
        requestId?: string;
        toolCallId?: string;
      };
      return (
        (message.type === "control.agent.run.tool_result" && message.toolCallId === toolCallId) ||
        (message.type === "control.error" && message.requestId === requestId)
      );
    });
    if (response) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!response) throw new Error(`Agent tool ${toolCallId} did not return a result`);
  return JSON.parse(response) as {
    type: string;
    runId?: string;
    toolCallId?: string;
    ok?: boolean;
    error?: string;
    result?: unknown;
    code?: string;
    message?: string;
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function stableToolActionId(
  actionScopeId: string,
  input: Record<string, unknown>,
  occurrence = 1,
): string {
  const signature = createHash("sha256")
    .update(canonicalJson({ operation: "tools.call", input }))
    .digest("hex");
  return `mate:${actionScopeId}:${signature}:${occurrence}`;
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
      homeMarker: "a".repeat(64),
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
      homeMarker: "a".repeat(64),
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
      homeMarker: "a".repeat(64),
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

  // Public metadata is readable, so a public channel's body is readable too; a private
  // conversation stays closed, and neither case lets a non-member speak.
  const publicRead = await callAgentTool(app, socket, run, "read-public-nonmember", "tools.call", {
    name: "conversations.read",
    input: { conversationId: publicRoom.id },
  });
  expect(publicRead).toMatchObject({ ok: true });
  expect(
    (publicRead.result as { messages: Array<{ text: string }> }).messages.map(
      (message) => message.text,
    ),
  ).toEqual(["Public message body."]);
  const privateReadDenied = await callAgentTool(
    app,
    socket,
    run,
    "read-private-nonmember",
    "tools.call",
    {
      name: "conversations.read",
      input: { conversationId: privateRoom.id },
    },
  );
  expect(privateReadDenied).toMatchObject({
    ok: false,
    error: "Conversation is not available",
  });
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

it("lets a non-member Agent read a public channel's timeline and thread but not speak", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = await prepareVerifiedAgent(app, nodeId, "Curious colleague", 23001);
  const ownDirect = app.chat.getOrCreateAgentDirectChannel(agentId)!,
    publicRoom = app.chat.createChannel({
      name: "Open research",
      description: "Anyone configured may read this.",
      visibility: "public",
    }),
    root = app.chat.createMessage(publicRoom.id, "Public planning message.")!;
  app.chat.createMessage(publicRoom.id, "First public reply.", { rootId: root.id });
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.createMessage(ownDirect.id, "Start a conversation tool run.");
  const run = await waitForRun(socket, runStart);

  const read = await callAgentTool(app, socket, run, "read-public-nonmember", "tools.call", {
    name: "conversations.read",
    input: { conversationId: publicRoom.id },
  });
  expect(read).toMatchObject({ ok: true });
  const page = read.result as { conversation: { id: string }; messages: OwnerMessageLike[] };
  expect(page.conversation.id).toBe(publicRoom.id);
  expect(page.messages.map((message) => message.text)).toEqual(["Public planning message."]);

  const thread = await callAgentTool(
    app,
    socket,
    run,
    "read-public-thread-nonmember",
    "tools.call",
    {
      name: "conversations.read_thread",
      input: { conversationId: publicRoom.id, rootId: root.id },
    },
  );
  expect(thread).toMatchObject({ ok: true });
  const threadResult = thread.result as { root: OwnerMessageLike; replies: OwnerMessageLike[] };
  expect(threadResult.root.text).toBe("Public planning message.");
  expect(threadResult.replies.map((message) => message.text)).toEqual(["First public reply."]);

  const sendDenied = await callAgentTool(app, socket, run, "send-public-nonmember", "tools.call", {
    name: "messages.send",
    input: { conversationId: publicRoom.id, text: "Must not be sent before joining." },
  });
  expect(sendDenied).toMatchObject({ ok: false, error: "Conversation is not available" });
  expect(
    app.chat
      .listMessages(publicRoom.id, undefined, 100)!
      .messages.some((message) => message.text === "Must not be sent before joining."),
  ).toBe(false);
});

it("keeps a non-member Agent out of a private channel that holds a task", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = await prepareVerifiedAgent(app, nodeId, "Private outsider", 23002);
  const ownDirect = app.chat.getOrCreateAgentDirectChannel(agentId)!,
    privateRoom = app.chat.createChannel({
      name: "Secret project",
      description: "Only members may read this.",
      visibility: "private",
    }),
    secret = app.chat.createMessage(privateRoom.id, "Private planning message.")!;
  app.chat.createTaskForMessage(secret.id, "human", "owner");
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.createMessage(ownDirect.id, "Start a conversation tool run.");
  const run = await waitForRun(socket, runStart);

  const read = await callAgentTool(app, socket, run, "read-private-nonmember", "tools.call", {
    name: "conversations.read",
    input: { conversationId: privateRoom.id },
  });
  expect(read).toMatchObject({ ok: false, error: "Conversation is not available" });
  const thread = await callAgentTool(app, socket, run, "thread-private-nonmember", "tools.call", {
    name: "conversations.read_thread",
    input: { conversationId: privateRoom.id, rootId: secret.id },
  });
  expect(thread).toMatchObject({ ok: false, error: "Conversation is not available" });
  const join = await callAgentTool(app, socket, run, "join-private-nonmember", "tools.call", {
    name: "conversations.join",
    input: { conversationId: privateRoom.id },
  });
  expect(join.ok).toBe(false);
  expect(
    app.chat
      .listMessages(privateRoom.id, undefined, 100)!
      .messages.some((message) => message.text === "Private planning message."),
  ).toBe(true);

  // Holding a task in the private channel grants no read access to it, and task
  // visibility stays member-only rather than following the widened conversation read.
  const listed = await callAgentTool(app, socket, run, "tasks-list-private", "tools.call", {
    name: "tasks.list",
    input: {},
  });
  expect(listed).toMatchObject({ ok: true });
  expect((listed.result as { tasks: Array<{ id: string }> }).tasks).toEqual([]);
});

it("lets a non-member Agent join a public channel, then speak and receive later activity", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = await prepareVerifiedAgent(app, nodeId, "Joining colleague", 23003);
  const ownDirect = app.chat.getOrCreateAgentDirectChannel(agentId)!,
    publicRoom = app.chat.createChannel({
      name: "Open standup",
      description: "Agents may join on their own.",
      visibility: "public",
    });
  app.chat.createMessage(publicRoom.id, "Old standup note.");
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.createMessage(ownDirect.id, "Start a conversation tool run.");
  const run = await waitForRun(socket, runStart);

  const joined = await callAgentTool(app, socket, run, "join-public", "tools.call", {
    name: "conversations.join",
    input: { conversationId: publicRoom.id },
  });
  expect(joined).toMatchObject({
    ok: true,
    result: { conversationId: publicRoom.id, member: true, alreadyMember: false },
  });

  const sendInput = {
    name: "messages.send",
    input: { conversationId: publicRoom.id, text: "I have joined and can speak." },
  };
  const sent = await callAgentTool(app, socket, run, "send-after-join", "tools.call", sendInput);
  expect(sent).toMatchObject({ ok: true });
  const held = sent.result as { status?: string; draftId?: string };
  expect(held.status).toBe("needs_review");
  expect(held.draftId).toBeTruthy();
  const reviewed = await callAgentTool(app, socket, run, "review-after-join", "tools.call", {
    name: "drafts.review",
    input: { draftId: held.draftId, choice: "continue" },
  });
  expect(reviewed).toMatchObject({ ok: true });
  const resent = await callAgentTool(app, socket, run, "send-after-join-2", "tools.call", {
    name: "messages.send",
    input: { ...sendInput.input, draftId: held.draftId },
  });
  expect(resent).toMatchObject({ ok: true });
  expect(
    app.chat
      .listMessages(publicRoom.id, undefined, 100)!
      .messages.some((message) => message.text === "I have joined and can speak."),
  ).toBe(true);

  // Later ordinary owner activity now reaches the new member as a fresh run.
  await finishRun(app, socket, run);
  const beforeActivity = socket.sent.length;
  app.chat.createMessage(publicRoom.id, "Welcome to the standup.");
  const laterRun = await waitForRun(socket, beforeActivity);
  expect(laterRun.agentId).toBe(agentId);
});

it("does not backfill a just-joined channel as unread nor forget what was already read", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = await prepareVerifiedAgent(app, nodeId, "Late joiner", 23004);
  const ownDirect = app.chat.getOrCreateAgentDirectChannel(agentId)!,
    publicRoom = app.chat.createChannel({
      name: "Open history",
      description: "History stays quiet when an Agent joins.",
      visibility: "public",
    }),
    oldRoot = app.chat.createMessage(publicRoom.id, "History before joining.")!;
  app.chat.createMessage(publicRoom.id, "Another old note.", { rootId: oldRoot.id });
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.createMessage(ownDirect.id, "Start a conversation tool run.");
  const run = await waitForRun(socket, runStart);

  // Reading the public history before joining creates nothing to be unread later.
  const preRead = await callAgentTool(app, socket, run, "pre-join-read", "tools.call", {
    name: "conversations.read",
    input: { conversationId: publicRoom.id },
  });
  expect(preRead).toMatchObject({ ok: true });
  expect(
    db
      .prepare(
        `SELECT count(*) AS count FROM owner_agent_message_attention a
         JOIN owner_messages m ON m.id=a.message_id WHERE a.agent_id=? AND m.channel_id=?`,
      )
      .get(agentId, publicRoom.id),
  ).toEqual({ count: 0 });

  const joined = await callAgentTool(app, socket, run, "join-open-history", "tools.call", {
    name: "conversations.join",
    input: { conversationId: publicRoom.id },
  });
  expect(joined).toMatchObject({ ok: true, result: { member: true, alreadyMember: false } });

  const attention = await callAgentTool(app, socket, run, "attention-after-join", "tools.call", {
    name: "attention.list",
    input: { conversationId: publicRoom.id },
  });
  expect(attention).toMatchObject({ ok: true });
  expect((attention.result as { items: unknown[] }).items).toEqual([]);
  expect(
    db
      .prepare(
        "SELECT joined_at AS joinedAt FROM owner_channel_memberships WHERE channel_id=? AND principal_kind='agent' AND principal_id=?",
      )
      .get(publicRoom.id, agentId),
  ).toMatchObject({ joinedAt: expect.any(Number) });
  const joinedAtBefore = (
    db
      .prepare(
        "SELECT joined_at AS joinedAt FROM owner_channel_memberships WHERE channel_id=? AND principal_kind='agent' AND principal_id=?",
      )
      .get(publicRoom.id, agentId) as { joinedAt: number }
  ).joinedAt;

  // A later delivery becomes unread, is read, and stays read across a second join.
  await finishRun(app, socket, run);
  const beforeFresh = socket.sent.length;
  const fresh = app.chat.createMessage(publicRoom.id, "Fresh activity after joining.")!;
  const freshRun = await waitForRun(socket, beforeFresh);
  const freshRead = await callAgentTool(app, socket, freshRun, "read-fresh", "tools.call", {
    name: "conversations.read",
    input: { conversationId: publicRoom.id },
  });
  expect(freshRead).toMatchObject({ ok: true });
  await callAgentTool(app, socket, freshRun, "mark-read", "tools.call", {
    name: "attention.update",
    input: { conversationId: publicRoom.id, messageId: fresh.id, unread: false, seen: true },
  });
  const rejoin = await callAgentTool(app, socket, freshRun, "rejoin-open-history", "tools.call", {
    name: "conversations.join",
    input: { conversationId: publicRoom.id },
  });
  expect(rejoin).toMatchObject({ ok: true, result: { member: true, alreadyMember: true } });
  expect(
    db
      .prepare("SELECT unread FROM owner_agent_message_attention WHERE agent_id=? AND message_id=?")
      .get(agentId, fresh.id),
  ).toEqual({ unread: 0 });

  // Force the other path: an inactive membership row that only the upsert can revive.
  db.prepare(
    "UPDATE owner_channel_memberships SET active=0 WHERE channel_id=? AND principal_kind='agent' AND principal_id=?",
  ).run(publicRoom.id, agentId);
  const revived = await callAgentTool(app, socket, freshRun, "revive-open-history", "tools.call", {
    name: "conversations.join",
    input: { conversationId: publicRoom.id },
  });
  expect(revived).toMatchObject({ ok: true, result: { member: true, alreadyMember: false } });
  expect(
    db
      .prepare(
        "SELECT active,joined_at AS joinedAt FROM owner_channel_memberships WHERE channel_id=? AND principal_kind='agent' AND principal_id=?",
      )
      .get(publicRoom.id, agentId),
  ).toEqual({ active: 1, joinedAt: joinedAtBefore });
  expect(
    db
      .prepare("SELECT unread FROM owner_agent_message_attention WHERE agent_id=? AND message_id=?")
      .get(agentId, fresh.id),
  ).toEqual({ unread: 0 });
});

it("lets a non-member Agent read a public channel's attachments but keeps publish member-only", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = await prepareVerifiedAgent(app, nodeId, "Attachment reader", 23005);
  const ownDirect = app.chat.getOrCreateAgentDirectChannel(agentId)!,
    publicRoom = app.chat.createChannel({
      name: "Open files",
      description: "Public attachments are readable.",
      visibility: "public",
    }),
    privateRoom = app.chat.createChannel({
      name: "Closed files",
      description: "Private attachments stay closed.",
      visibility: "private",
    });
  const upload = async (channelId: string, filename: string, body: string) =>
    app.request(`/api/owner/channels/${channelId}/attachments`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "text/plain; charset=utf-8",
        "x-mate-filename": encodeURIComponent(filename),
      },
      body: new TextEncoder().encode(body),
    });
  const publicUpload = await upload(publicRoom.id, "公开.txt", "public attachment body");
  expect(publicUpload.status).toBe(201);
  const publicAttachment = (await publicUpload.json()) as { attachment: { id: string } };
  expect((await upload(privateRoom.id, "机密.txt", "private attachment body")).status).toBe(201);
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.createMessage(ownDirect.id, "Start a conversation tool run.");
  const run = await waitForRun(socket, runStart);

  const publicList = await callAgentTool(app, socket, run, "list-public-files", "tools.call", {
    name: "attachments.list",
    input: { conversationId: publicRoom.id },
  });
  expect(publicList).toMatchObject({ ok: true });
  expect((publicList.result as { attachments: Array<{ id: string }> }).attachments).toEqual([
    expect.objectContaining({ id: publicAttachment.attachment.id }),
  ]);
  const publicChunk = await callAgentTool(app, socket, run, "read-public-file", "tools.call", {
    name: "attachments.read_chunk",
    input: {
      conversationId: publicRoom.id,
      attachmentId: publicAttachment.attachment.id,
      offset: 0,
    },
  });
  expect(publicChunk).toMatchObject({ ok: true });
  expect(Buffer.from((publicChunk.result as { base64: string }).base64, "base64").toString()).toBe(
    "public attachment body",
  );

  const privateList = await callAgentTool(app, socket, run, "list-private-files", "tools.call", {
    name: "attachments.list",
    input: { conversationId: privateRoom.id },
  });
  expect(privateList.ok).toBe(false);
  const publish = await callAgentTool(app, socket, run, "publish-public-file", "tools.call", {
    name: "attachments.publish",
    input: { conversationId: publicRoom.id, path: "notes.txt" },
  });
  expect(publish.ok).toBe(false);
});

it("does not let an outsider read or join a peer direct message through the public read path", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const firstAgentId = await prepareVerifiedAgent(app, nodeId, "Chatty colleague", 23006),
    secondAgentId = await prepareVerifiedAgent(app, nodeId, "Quiet colleague", 23007),
    outsiderId = await prepareVerifiedAgent(app, nodeId, "Outsider colleague", 23008);
  // Seed the peer DM through its own tables: the factory path requires the tool transaction.
  const outsiderDirect = app.chat.getOrCreateAgentDirectChannel(outsiderId)!;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.createMessage(outsiderDirect.id, "Start a conversation tool run.");
  const run = await waitForRun(socket, runStart);

  const peerDm = app.chat.createChannel({
      name: "Peer DM",
      description: "A private exchange between two colleagues.",
      visibility: "private",
    }),
    ordered = [firstAgentId, secondAgentId].sort(),
    seed = db.transaction(() => {
      db.prepare(
        "INSERT INTO owner_agent_peer_direct_channels(channel_id,first_agent_id,second_agent_id,created_at) VALUES(?,?,?,?)",
      ).run(peerDm.id, ordered[0], ordered[1], Date.now());
      db.prepare(
        "INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at) VALUES(?,?,?,1,?)",
      ).run(peerDm.id, "agent", firstAgentId, Date.now());
      db.prepare(
        "INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at) VALUES(?,?,?,1,?)",
      ).run(peerDm.id, "agent", secondAgentId, Date.now());
    });
  seed.immediate();
  const secret = app.chat.createMessage(peerDm.id, "A private peer exchange.")!;

  const read = await callAgentTool(app, socket, run, "read-peer-dm", "tools.call", {
    name: "conversations.read",
    input: { conversationId: peerDm.id },
  });
  expect(read).toMatchObject({ ok: false, error: "Conversation is not available" });
  const thread = await callAgentTool(app, socket, run, "thread-peer-dm", "tools.call", {
    name: "conversations.read_thread",
    input: { conversationId: peerDm.id, rootId: secret.id },
  });
  expect(thread).toMatchObject({ ok: false, error: "Conversation is not available" });
  const join = await callAgentTool(app, socket, run, "join-peer-dm", "tools.call", {
    name: "conversations.join",
    input: { conversationId: peerDm.id },
  });
  expect(join.ok).toBe(false);
  const listed = await callAgentTool(app, socket, run, "list-after-dm-probe", "tools.call", {
    name: "conversations.list",
    input: {},
  });
  expect(listed).toMatchObject({ ok: true });
  expect(
    (listed.result as { conversations: Array<{ id: string }> }).conversations.some(
      (conversation) => conversation.id === peerDm.id,
    ),
  ).toBe(false);

  // Even if a direct message's visibility were ever flipped, direct conversations stay
  // member-only: the public branch must exclude them on its own.
  db.prepare("UPDATE owner_channels SET visibility='public' WHERE id=?").run(peerDm.id);
  expect(
    await callAgentTool(app, socket, run, "read-published-peer-dm", "tools.call", {
      name: "conversations.read",
      input: { conversationId: peerDm.id },
    }),
  ).toMatchObject({ ok: false, error: "Conversation is not available" });
  expect(
    await callAgentTool(app, socket, run, "join-published-peer-dm", "tools.call", {
      name: "conversations.join",
      input: { conversationId: peerDm.id },
    }),
  ).toMatchObject({ ok: false, error: "Conversation is not available" });
  // Listing must not reveal it either, and the owner API refuses to publish any DM.
  const afterPublish = await callAgentTool(
    app,
    socket,
    run,
    "list-published-peer-dm",
    "tools.call",
    {
      name: "conversations.list",
      input: {},
    },
  );
  expect(afterPublish).toMatchObject({ ok: true });
  expect(
    (afterPublish.result as { conversations: Array<{ id: string }> }).conversations.some(
      (conversation) => conversation.id === peerDm.id,
    ),
  ).toBe(false);
  expect(() => app.chat.updateChannel(peerDm.id, { visibility: "public" })).toThrow(
    "A direct message cannot be made public",
  );
});

it("does not let a member transfer a task to a public-channel non-member", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const memberId = await prepareVerifiedAgent(app, nodeId, "Task owner", 23009),
    outsiderId = await prepareVerifiedAgent(app, nodeId, "Interested onlooker", 23010);
  const room = app.chat.createChannel({
    name: "Shared work",
    description: "A public room with a task.",
    visibility: "public",
  });
  app.chat.inviteAgentToChannel(room.id, memberId);
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-transfer-key" }),
  });
  // Start the non-member's own run first, from its private DM.
  const outsiderDirect = app.chat.getOrCreateAgentDirectChannel(outsiderId)!,
    outsiderStart = socket.sent.length;
  app.chat.createMessage(outsiderDirect.id, "Start an onlooker run.");
  const outsiderRun = await waitForRun(socket, outsiderStart);

  const memberStart = socket.sent.length;
  const anchor = app.chat.createMessage(room.id, "Review deployment", { asTask: true })!;
  const task = app.chat.taskForMessage(anchor.id)!;
  const memberRun = await waitForRun(socket, memberStart);

  // The onlooker can read the room, but tasks stay member-only: it neither sees this one
  // nor can it be handed the task, because task visibility did not follow the read widening.
  const claimed = await callAgentTool(app, socket, memberRun, "member-claim", "tools.call", {
    name: "tasks.claim",
    input: { taskId: task.id, expectedVersion: 1 },
  });
  expect(claimed).toMatchObject({ ok: true, result: { ownerAgentId: memberId, version: 2 } });
  const onlookerTasks = await callAgentTool(
    app,
    socket,
    outsiderRun,
    "onlooker-list",
    "tools.call",
    {
      name: "tasks.list",
      input: {},
    },
  );
  expect(onlookerTasks).toMatchObject({ ok: true });
  expect((onlookerTasks.result as { tasks: Array<{ id: string }> }).tasks).toEqual([]);

  const transfer = await callAgentTool(
    app,
    socket,
    memberRun,
    "transfer-to-outsider",
    "tools.call",
    {
      name: "tasks.transfer",
      input: { taskId: task.id, expectedVersion: 2, agentId: outsiderId },
    },
  );
  expect(transfer).toMatchObject({
    ok: false,
    error: "Transfer target is not a conversation member",
  });
  const after = app.chat.readTask(task.id)!;
  expect(after.ownerAgentId).toBe(memberId);
  expect(after.version).toBe(2);
  // The non-member still cannot act on a task it can merely read.
  expect(
    await callAgentTool(app, socket, outsiderRun, "outsider-claim", "tools.call", {
      name: "tasks.claim",
      input: { taskId: task.id, expectedVersion: 2 },
    }),
  ).toMatchObject({ ok: false, error: "Conversation is not available" });
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
      homeMarker: "a".repeat(64),
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
      homeMarker: "a".repeat(64),
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
    app.chat.recordAgentRunTranscript(firstRun.runId, nodeId, agentId, randomUUID(), "已完成。"),
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
      homeMarker: "a".repeat(64),
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
      transcript: async (text) => {
        const requestId = randomUUID();
        await app.nodes.receive(
          socket,
          JSON.stringify({
            type: "node.agent.run.transcript",
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

it("records every plain turn of one run, including narration beside a tool call", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Narrating partner",
    role: "Explains itself before calling a tool",
    description: "Synthetic multi-turn transcript fixture.",
    model: { provider: "openai", id: "gpt-4o-mini" },
  });
  app.agents.complete(
    agentId,
    {
      username: "mate_" + agentId.replaceAll("-", "").slice(0, 27),
      uid: 23001,
      gid: 23001,
      home: `/var/lib/mate/agents/${agentId}`,
      homeMarker: "a".repeat(64),
    },
    app.chat,
  );
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-key-narrated-tool-turn" }),
  });
  const runStart = socket.sent.length;
  app.chat.createMessage(direct.id, "先说明再发送这条消息。");
  const run = await waitForRun(socket, runStart);

  const resultAcks: Promise<void>[] = [];
  const transport: AgentRunTransport = {
    context: async () => callAgentRunContext(app, socket, run),
    transcript: async (text) => {
      const fromIndex = socket.sent.length;
      await app.nodes.receive(
        socket,
        JSON.stringify({
          type: "node.agent.run.transcript",
          requestId: randomUUID(),
          runId: run.runId,
          agentId,
          text,
        }),
      );
      return (JSON.parse(socket.sent.at(fromIndex)!) as { accepted?: boolean }).accepted === true;
    },
    tool: async (toolCallId, operation, input) => {
      const result = await callAgentTool(app, socket, run, toolCallId, operation, input);
      return result.ok
        ? { ok: true, result: result.result }
        : { ok: false, error: result.error ?? "Agent tool request was refused" };
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
  await runAgentModel(run, transport, new AbortController().signal, {
    modelWorkerEntry: resolve("tests/fixtures/direct-message-model-worker.mjs"),
  });
  await Promise.all(resultAcks);

  // Both plain turns of the run survive in its own session record instead of failing the run.
  expect(
    db
      .prepare(
        "SELECT text FROM owner_agent_session_journal WHERE run_id=? AND role='assistant' AND tool_action_id IS NULL ORDER BY seq",
      )
      .all(run.runId),
  ).toEqual([
    { text: "我先说明一下，然后发送这条消息。" },
    { text: "工具已发送，这是我的最终正文。" },
  ]);
  expect(db.prepare("SELECT state FROM owner_agent_runs WHERE id=?").get(run.runId)).toEqual({
    state: "completed",
  });
  // Only the explicit send became public; the narration and the final answer did not.
  expect(app.chat.listMessages(direct.id, undefined, 20)!.messages).toMatchObject([
    { author: { kind: "human" }, text: "先说明再发送这条消息。" },
    { author: { kind: "agent", id: agentId }, text: "带说明的工具发送消息。" },
  ]);
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toHaveLength(0);
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
        homeMarker: "a".repeat(64),
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
      homeMarker: "a".repeat(64),
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
        homeMarker: "a".repeat(64),
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
      homeMarker: "a".repeat(64),
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
      homeMarker: "a".repeat(64),
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
      type: "node.agent.run.transcript",
      requestId: randomUUID(),
      runId: firstRun.runId,
      agentId,
      text: "第一批次的私有正文。",
    }),
  );
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    type: "control.agent.run.transcript_ack",
    accepted: true,
  });
  expect(
    app.chat.listAgentSessionJournal(agentId, 0, 100).messages.map((message) => message.text),
  ).toContain("第一批次的私有正文。");
  // Recording a turn consumes nothing: the batch is covered only when the run succeeds.
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toMatchObject([
    { message: { text: "同一来源批次中的第一条频道输入。" } },
    { message: { text: "同一来源批次中的第二条频道输入。" } },
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
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toMatchObject([
    { message: { text: "运行开始后才到达的下一条频道输入。" } },
  ]);
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
    "第一批次的私有正文。",
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
  // Neither turn published anything: the conversation only holds the owner's inputs.
  expect(app.chat.listMessages(room.id, undefined, 20)?.messages).toMatchObject([
    { author: { kind: "human" }, text: "同一来源批次中的第一条频道输入。" },
    { author: { kind: "human" }, text: "同一来源批次中的第二条频道输入。" },
    { author: { kind: "human" }, text: "运行开始后才到达的下一条频道输入。" },
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
      homeMarker: "a".repeat(64),
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

  const writeTranscript = async (runId: string, text: string) => {
    await app.nodes.receive(
      socket,
      JSON.stringify({
        type: "node.agent.run.transcript",
        requestId: randomUUID(),
        runId,
        agentId,
        text,
      }),
    );
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: "control.agent.run.transcript_ack",
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

  await writeTranscript(firstRun.runId, "只写进自己会话记录的公开频道回合。");
  // A recorded turn publishes nothing and consumes nothing by itself.
  expect(app.chat.listMessages(publicRoom.id, undefined, 20)?.messages).toMatchObject([
    { author: { kind: "human" }, text: "公开输入必须触发公开频道 run。" },
  ]);
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toMatchObject([
    { channelId: publicRoom.id, message: { text: "公开输入必须触发公开频道 run。" } },
    { channelId: direct.id, message: { text: "这条私信不能进入公开回复。" } },
  ]);

  const privateRunStart = socket.sent.length;
  await finishRun(firstRun.runId);
  // Completing the run covers only the batch its boundary captured.
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toMatchObject([
    { channelId: direct.id, message: { text: "这条私信不能进入公开回复。" } },
  ]);
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
      text: "只写进自己会话记录的公开频道回合。",
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
  await writeTranscript(privateRun.runId, "私信输入对应的私有回合。");
  expect(app.chat.listMessages(direct.id, undefined, 20)?.messages).toMatchObject([
    { author: { kind: "human" }, text: "这条私信不能进入公开回复。" },
  ]);
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
  await writeTranscript(reversePrivateRun.runId, "反向顺序私信回合。");
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
  await writeTranscript(reversePublicRun.runId, "公开输入对应的私有回合。");
  expect(
    app.chat
      .listMessages(publicRoom.id, undefined, 20)!
      .messages.filter((message) => message.author.kind === "agent"),
  ).toHaveLength(0);
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
      homeMarker: "a".repeat(64),
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
      type: "node.agent.run.transcript",
      requestId: randomUUID(),
      runId: run.runId,
      agentId,
      text: "归档期间仍然只写进自己会话记录的正文。",
    }),
  );
  // The private record is accepted, but it still publishes nothing.
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    type: "control.agent.run.transcript_ack",
    accepted: true,
  });
  expect(app.chat.listMessages(direct.id, undefined, 20)?.messages).toMatchObject([
    { author: { kind: "human" }, text: "归档期间不可写入回复的私信。" },
  ]);

  // A successful turn still cannot consume an input from an archived conversation.
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: run.runId,
      runId: run.runId,
      agentId,
      ok: true,
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
      type: "node.agent.run.transcript",
      requestId: randomUUID(),
      runId: retry.runId,
      agentId,
      text: "频道恢复后记录的私有正文。",
    }),
  );
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    type: "control.agent.run.transcript_ack",
    accepted: true,
  });
  expect(app.chat.listMessages(direct.id, undefined, 20)?.messages).toMatchObject([
    { author: { kind: "human" }, text: "归档期间不可写入回复的私信。" },
  ]);
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: retry.runId,
      runId: retry.runId,
      agentId,
      ok: true,
    }),
  );
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
      homeMarker: "a".repeat(64),
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
      type: "node.agent.run.transcript",
      requestId: randomUUID(),
      runId: laterRun.runId,
      agentId,
      text: "只在来源 B 记录的私有正文。",
    }),
  );
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    type: "control.agent.run.transcript_ack",
    accepted: true,
  });
  expect(
    app.chat
      .listMessages(direct.id, undefined, 20)
      ?.messages.filter((message) => message.author.kind === "agent"),
  ).toHaveLength(0);
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
  // Completing the later run leaves the archived source's input untouched.
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toMatchObject([
    { channelId: earlierSource.id, message: { text: "较早来源 A 的待处理私信。" } },
  ]);

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
      text: "只在来源 B 记录的私有正文。",
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
      type: "node.agent.run.transcript",
      requestId: randomUUID(),
      runId: earlierRun.runId,
      agentId,
      text: "来源 A 恢复后记录的私有正文。",
    }),
  );
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    type: "control.agent.run.transcript_ack",
    accepted: true,
  });
  expect(
    app.chat
      .listMessages(earlierSource.id, undefined, 20)
      ?.messages.filter((message) => message.author.kind === "agent"),
  ).toHaveLength(0);
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: earlierRun.runId,
      runId: earlierRun.runId,
      agentId,
      ok: true,
    }),
  );
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
      homeMarker: "a".repeat(64),
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

it("authorizes workspace writes, reuses one action receipt, and reconciles a late node receipt", async () => {
  const { app, cookie, db, nodeId, socket } = await setup({ nodeOperationTimeoutMs: 40 });
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Workspace partner",
    role: "Uses a private Linux workspace",
    description: "Synthetic file-action fixture.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: "mate_" + agentId.replaceAll("-", "").slice(0, 27),
      uid: 23001,
      gid: 23001,
      home: `/var/lib/mate/agents/${agentId}`,
      homeMarker: "a".repeat(64),
    },
    app.chat,
  );
  const channel = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.createMessage(channel.id, "Use workspace files and publish the result.");
  const run = await waitForRun(socket, runStart);
  const requests: Array<Record<string, unknown>> = [],
    nodeReceipts = new Map<
      string,
      { code: number; stdout: string; stderr: string; truncated: boolean }
    >();
  let heldRequest: Record<string, unknown> | undefined,
    holdNextResponse = false,
    failNextResponse = false,
    expectedActionId: string | undefined,
    executingEnvelope: unknown;
  socket.onWorkspaceOperation = async (message) => {
    requests.push(message);
    const operationId = String(message.operationId),
      existingReceipt = nodeReceipts.get(operationId);
    if (existingReceipt) {
      if (!holdNextResponse)
        await app.nodes.receive(
          socket,
          JSON.stringify({
            type: "node.workspace.operation.result",
            requestId: message.requestId,
            operationId,
            agentId,
            ok: true,
            result: existingReceipt,
          }),
        );
      return;
    }
    const action = expectedActionId
      ? (db
          .prepare("SELECT result_json FROM owner_agent_tool_actions WHERE action_id=?")
          .get(expectedActionId) as { result_json: string } | undefined)
      : undefined;
    if (action) executingEnvelope = JSON.parse(action.result_json);
    const receipt = failNextResponse
      ? { code: 9, stdout: "", stderr: "permission_denied: file is protected", truncated: false }
      : {
          code: 0,
          stdout: JSON.stringify({ sha256: `receipt-${requests.length}` }),
          stderr: "",
          truncated: false,
        };
    failNextResponse = false;
    nodeReceipts.set(operationId, receipt);
    if (holdNextResponse) {
      holdNextResponse = false;
      heldRequest = message;
      return;
    }
    await app.nodes.receive(
      socket,
      JSON.stringify({
        type: "node.workspace.operation.result",
        requestId: message.requestId,
        operationId,
        agentId,
        ok: true,
        result: receipt,
      }),
    );
  };

  const discover = await callAgentTool(app, socket, run, "workspace-discovery", "tools.list", {});
  expect(discover).toMatchObject({
    ok: true,
    result: {
      tools: expect.arrayContaining([expect.objectContaining({ name: "workspace.write" })]),
    },
  });

  const firstInput = { name: "workspace.write", input: { path: "notes.txt", content: "hello" } },
    firstActionId = stableToolActionId(run.actionScopeId, firstInput);
  expectedActionId = firstActionId;
  const first = await callAgentTool(app, socket, run, firstActionId, "tools.call", firstInput);
  expect(first).toMatchObject({ ok: true, result: { sha256: "receipt-1" } });
  expect(executingEnvelope).toMatchObject({ state: "executing", operationId: expect.any(String) });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    type: "control.workspace.operation",
    agentId,
    runId: run.runId,
    mode: "agent_action",
    operation: { kind: "write", path: "notes.txt", content: "hello" },
  });
  const firstAction = db
    .prepare("SELECT result_json FROM owner_agent_tool_actions WHERE session_id=? AND action_id=?")
    .get(run.sessionId, firstActionId) as { result_json: string };
  expect(JSON.parse(firstAction.result_json)).toMatchObject({
    state: "succeeded",
    operationId: requests[0]!.operationId,
    result: { sha256: "receipt-1" },
  });
  const writeAudit = db
    .prepare(
      `SELECT actor_kind,actor_id,agent_id,run_id,operation,relative_paths,result,error_code
       FROM owner_workspace_access_audit WHERE agent_id=? AND operation='workspace.write'`,
    )
    .get(agentId) as Record<string, unknown>;
  expect(writeAudit).toMatchObject({
    actor_kind: "agent",
    actor_id: agentId,
    agent_id: agentId,
    run_id: run.runId,
    relative_paths: '["notes.txt"]',
    result: "succeeded",
    error_code: null,
  });
  expect(db.prepare("PRAGMA table_info(owner_workspace_access_audit)").all()).not.toContainEqual(
    expect.objectContaining({ name: "content" }),
  );
  const safeActivity = await app.request(`/api/owner/agents/${agentId}/activity`, {
    headers: { cookie },
  });
  expect(await safeActivity.text()).not.toContain("hello");
  const detailedActivity = await app.request(`/api/owner/agents/${agentId}/activity?detail=1`, {
    headers: { cookie },
  });
  expect(await detailedActivity.text()).toContain("notes.txt");
  expect(
    await callAgentTool(app, socket, run, firstActionId, "tools.call", firstInput),
  ).toMatchObject({ ok: true, result: first.result });
  expect(requests).toHaveLength(1);

  const delayedInput = { name: "workspace.write", input: { path: "late.txt", content: "saved" } },
    delayedActionId = stableToolActionId(run.actionScopeId, delayedInput);
  expectedActionId = delayedActionId;
  holdNextResponse = true;
  const unknown = await callAgentTool(
    app,
    socket,
    run,
    delayedActionId,
    "tools.call",
    delayedInput,
  );
  expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining("尚未确认") });
  expect(heldRequest).toBeDefined();
  const unknownAction = db
    .prepare("SELECT result_json FROM owner_agent_tool_actions WHERE session_id=? AND action_id=?")
    .get(run.sessionId, delayedActionId) as { result_json: string };
  expect(JSON.parse(unknownAction.result_json)).toMatchObject({
    state: "unknown",
    operationId: heldRequest!.operationId,
  });

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
  const compactStart = socket.sent.length;
  app.chat.createMessage(channel.id, "Summarize the uncertain file operation.");
  const compactRun = await waitForRun(socket, compactStart);
  const compactActionId = `mate:${compactRun.actionScopeId}:${"c".repeat(64)}:1`;
  expect(
    await callAgentTool(app, socket, compactRun, compactActionId, "tools.call", {
      name: "session.compact",
      input: { summary: "A file action has an unknown result.", snapshot: {} },
    }),
  ).toMatchObject({ ok: true });
  const unknownJournal = db
    .prepare("SELECT seq FROM owner_agent_session_journal WHERE session_id=? AND tool_action_id=?")
    .get(run.sessionId, delayedActionId) as { seq: number };
  const snapshot = db
    .prepare(
      "SELECT through_seq FROM owner_agent_session_snapshots WHERE agent_id=? ORDER BY rowid DESC LIMIT 1",
    )
    .get(agentId) as { through_seq: number };
  expect(snapshot.through_seq).toBeGreaterThanOrEqual(unknownJournal.seq);
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: randomUUID(),
      runId: compactRun.runId,
      agentId,
      ok: true,
    }),
  );

  const lateReceipt = nodeReceipts.get(String(heldRequest!.operationId))!;
  const correctedStart = socket.sent.length;
  const unavailableNotification = vi
    .spyOn(app.chat, "notifyAgentReceiptCorrection")
    .mockImplementation(() => {
      throw new Error("crash before notification commit");
    });
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.workspace.operation.result",
      requestId: heldRequest!.requestId,
      operationId: heldRequest!.operationId,
      agentId,
      ok: true,
      result: lateReceipt,
    }),
  );
  expect(
    JSON.parse(
      (
        db
          .prepare(
            "SELECT result_json FROM owner_agent_tool_actions WHERE session_id=? AND action_id=?",
          )
          .get(run.sessionId, delayedActionId) as { result_json: string }
      ).result_json,
    ).state,
  ).toBe("unknown");
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM owner_agent_activity WHERE reference_id=? AND kind='receipt.corrected'",
      )
      .get(heldRequest!.operationId),
  ).toEqual({ count: 0 });
  unavailableNotification.mockRestore();
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.workspace.operation.result",
      requestId: heldRequest!.requestId,
      operationId: heldRequest!.operationId,
      agentId,
      ok: true,
      result: lateReceipt,
    }),
  );
  const reconciled = db
    .prepare("SELECT result_json FROM owner_agent_tool_actions WHERE session_id=? AND action_id=?")
    .get(run.sessionId, delayedActionId) as { result_json: string };
  expect(JSON.parse(reconciled.result_json)).toMatchObject({
    state: "succeeded",
    operationId: heldRequest!.operationId,
    result: { sha256: "receipt-2" },
  });
  const correctedRun = await waitForRun(socket, correctedStart);
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.context",
      requestId: randomUUID(),
      runId: correctedRun.runId,
      agentId,
      cursor: 0,
      limit: 100,
    }),
  );
  const correctedContext = JSON.parse(socket.sent.at(-1)!) as { messages: Array<{ text: string }> };
  expect(
    correctedContext.messages.some(
      (message) => message.text.includes("workspace.write") && message.text.includes("receipt-2"),
    ),
  ).toBe(true);
  const correctedActivity = db
    .prepare(
      "SELECT COUNT(*) AS count FROM owner_agent_activity WHERE reference_id=? AND kind='receipt.corrected'",
    )
    .get(heldRequest!.operationId) as { count: number };
  expect(correctedActivity.count).toBe(1);
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.workspace.operation.result",
      requestId: heldRequest!.requestId,
      operationId: heldRequest!.operationId,
      agentId,
      ok: true,
      result: lateReceipt,
    }),
  );
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM owner_agent_activity WHERE reference_id=? AND kind='receipt.corrected'",
      )
      .get(heldRequest!.operationId),
  ).toEqual({ count: 1 });
  expect(requests).toHaveLength(2);

  const failedInput = { name: "workspace.write", input: { path: "denied.txt", content: "try" } },
    failedActionId = stableToolActionId(correctedRun.actionScopeId, failedInput);
  expectedActionId = failedActionId;
  holdNextResponse = true;
  expect(
    await callAgentTool(app, socket, correctedRun, failedActionId, "tools.call", failedInput),
  ).toMatchObject({ ok: false, error: expect.stringContaining("尚未确认") });
  const failedRequest = heldRequest!;
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.workspace.operation.result",
      requestId: failedRequest.requestId,
      operationId: failedRequest.operationId,
      agentId,
      ok: true,
      result: {
        code: 7,
        stdout: "",
        stderr: "permission_denied: file is protected",
        truncated: false,
      },
    }),
  );
  const failedAction = db
    .prepare("SELECT result_json FROM owner_agent_tool_actions WHERE session_id=? AND action_id=?")
    .get(run.sessionId, failedActionId) as { result_json: string };
  expect(JSON.parse(failedAction.result_json)).toMatchObject({
    state: "failed",
    result: { code: 7 },
  });
  expect(
    db
      .prepare(
        "SELECT summary FROM owner_agent_activity WHERE kind='receipt.corrected' AND reference_id=?",
      )
      .get(failedRequest.operationId),
  ).toMatchObject({ summary: expect.stringContaining("失败") });
  expect(
    db
      .prepare(
        "SELECT text FROM owner_agent_session_journal WHERE tool_action_id=? ORDER BY seq DESC LIMIT 1",
      )
      .get(failedActionId),
  ).toMatchObject({ text: expect.stringContaining('"state":"failed"') });
  const beforeFailedReplay = requests.length;
  const failedReplay = await callAgentTool(
    app,
    socket,
    correctedRun,
    failedActionId,
    "tools.call",
    failedInput,
  );
  expect(failedReplay).toMatchObject({ ok: false, error: expect.stringContaining("7") });
  expect(requests).toHaveLength(beforeFailedReplay);

  const immediateFailureInput = {
      name: "workspace.write",
      input: { path: "protected.txt", content: "no" },
    },
    immediateFailureId = stableToolActionId(correctedRun.actionScopeId, immediateFailureInput);
  expectedActionId = immediateFailureId;
  failNextResponse = true;
  const originalFailure = await callAgentTool(
    app,
    socket,
    correctedRun,
    immediateFailureId,
    "tools.call",
    immediateFailureInput,
  );
  expect(originalFailure).toMatchObject({ ok: false, error: expect.stringContaining("9") });
  const afterOriginalFailure = requests.length;
  const replayedFailure = await callAgentTool(
    app,
    socket,
    correctedRun,
    immediateFailureId,
    "tools.call",
    immediateFailureInput,
  );
  expect(replayedFailure).toMatchObject({ ok: false, error: originalFailure.error });
  expect(requests).toHaveLength(afterOriginalFailure);

  db.prepare(
    `UPDATE owner_channel_memberships SET active=0
     WHERE channel_id=? AND principal_kind='agent' AND principal_id=?`,
  ).run(channel.id, agentId);
  const denied = await callAgentTool(app, socket, run, firstActionId, "tools.call", firstInput);
  expect(denied).toMatchObject({ ok: false });
  expect(requests).toHaveLength(4);
});

it("replays a confirmed failed file action as the same error after control-plane restart", async () => {
  const { app, cookie, db, nodeId, socket, keyPair } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Failure replay",
    role: "File recovery",
    description: "Durable failed receipt fixture",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: `mate_${agentId.replaceAll("-", "").slice(0, 27)}`,
      uid: 23001,
      gid: 23001,
      home: `/var/lib/mate/agents/${agentId}`,
      homeMarker: "a".repeat(64),
    },
    app.chat,
  );
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-key" }),
  });
  const start = socket.sent.length;
  app.chat.createMessage(direct.id, "Attempt one file action.");
  const firstRun = await waitForRun(socket, start);
  const input = { name: "workspace.write", input: { path: "protected.txt", content: "no" } },
    actionId = stableToolActionId(firstRun.actionScopeId, input);
  let executions = 0;
  socket.onWorkspaceOperation = async (request) => {
    executions++;
    await app.nodes.receive(
      socket,
      JSON.stringify({
        type: "node.workspace.operation.result",
        requestId: request.requestId,
        operationId: request.operationId,
        agentId,
        ok: true,
        result: {
          code: 9,
          stdout: "",
          stderr: "permission_denied: file is protected",
          truncated: false,
        },
      }),
    );
  };
  const original = await callAgentTool(app, socket, firstRun, actionId, "tools.call", input);
  expect(original).toMatchObject({ ok: false, error: expect.stringContaining("9") });
  expect(executions).toBe(1);
  app.runs?.close();
  app.nodes.close(socket);
  const directory = fixtures.at(-1)!.directory;
  const restarted = createControlPlaneApp({
    dataDir: join(directory, "control-plane"),
    passwordFile: join(directory, "owner-password"),
  });
  try {
    const recovered = new FakeNodeSocket();
    recovered.onWorkspaceOperation = () => {
      executions++;
    };
    restarted.nodes.open(recovered);
    const challenge = JSON.parse(recovered.sent[0]!) as { nonce: string };
    await restarted.nodes.receive(
      recovered,
      JSON.stringify({
        type: "node.authenticate",
        requestId: randomUUID(),
        nodeId,
        signature: sign(null, Buffer.from(challenge.nonce), keyPair.privateKey).toString(
          "base64url",
        ),
      }),
    );
    const retryRun = await waitForRun(recovered, 0);
    expect(retryRun.runId).not.toBe(firstRun.runId);
    expect(retryRun.actionScopeId).toBe(firstRun.actionScopeId);
    const replay = await callAgentTool(
      restarted,
      recovered,
      retryRun,
      actionId,
      "tools.call",
      input,
    );
    expect(replay).toMatchObject({ ok: false, error: original.error });
    expect(executions).toBe(1);
    expect(
      db
        .prepare(
          "SELECT json_extract(result_json,'$.state') AS state FROM owner_agent_tool_actions WHERE action_id=?",
        )
        .get(actionId),
    ).toEqual({ state: "failed" });
  } finally {
    restarted.close();
  }
});

it("publishes Agent workspace files to a joined conversation in bounded chunks and rechecks ACL before replay", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Attachment publisher",
    role: "Shares a workspace file",
    description: "Synthetic attachment fixture.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: "mate_" + agentId.replaceAll("-", "").slice(0, 27),
      uid: 23001,
      gid: 23001,
      home: `/var/lib/mate/agents/${agentId}`,
      homeMarker: "a".repeat(64),
    },
    app.chat,
  );
  const channel = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  const destination = app.chat.createChannel({
    name: "Shared research",
    description: "Agent has explicitly joined this conversation.",
    visibility: "public",
  });
  expect(app.chat.inviteAgentToChannel(destination.id, agentId)).toBe(true);
  db.prepare(
    `UPDATE owner_channel_memberships SET active=0
     WHERE channel_id=? AND principal_kind='human' AND principal_id='owner'`,
  ).run(destination.id);
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.createMessage(channel.id, "Publish a note from the workspace.");
  const run = await waitForRun(socket, runStart),
    requests: Array<Record<string, unknown>> = [],
    version = { device: "1", inode: "2", size: 5, modifiedNs: "3", changedNs: "4" };
  socket.onWorkspaceOperation = async (message) => {
    requests.push(message);
    const operation = message.operation as { kind: string; offset?: number },
      result =
        operation.kind === "workspace_stat"
          ? {
              code: 0,
              stdout: JSON.stringify({ type: "file", size: 5, version }),
              stderr: "",
              truncated: false,
            }
          : {
              code: 0,
              stdout: JSON.stringify({
                offset: operation.offset,
                totalBytes: 5,
                base64: "aGVsbG8=",
                version,
              }),
              stderr: "",
              truncated: false,
            };
    await app.nodes.receive(
      socket,
      JSON.stringify({
        type: "node.workspace.operation.result",
        requestId: message.requestId,
        operationId: message.operationId,
        agentId,
        ok: true,
        result,
      }),
    );
  };

  const unjoined = app.chat.createChannel({
    name: "Not joined",
    description: "The Agent must not publish here.",
    visibility: "public",
  });
  const input = {
      name: "attachments.publish",
      input: { conversationId: destination.id, path: "notes.txt", filename: "共享笔记.txt" },
    },
    actionId = stableToolActionId(run.actionScopeId, input),
    deniedInput = {
      name: "attachments.publish",
      input: { conversationId: unjoined.id, path: "notes.txt", filename: "不应发布.txt" },
    },
    deniedActionId = stableToolActionId(run.actionScopeId, deniedInput),
    denied = await callAgentTool(app, socket, run, deniedActionId, "tools.call", deniedInput);
  expect(denied.ok).toBe(false);
  expect(requests).toHaveLength(0);
  const attempts = await Promise.all([
      callAgentTool(app, socket, run, actionId, "tools.call", input),
      callAgentTool(app, socket, run, actionId, "tools.call", input),
    ]),
    published = attempts.find((attempt) => attempt.ok)!;
  expect(attempts.filter((attempt) => attempt.ok)).toHaveLength(1);
  db.prepare(
    `UPDATE owner_channel_memberships SET active=1
     WHERE channel_id=? AND principal_kind='human' AND principal_id='owner'`,
  ).run(destination.id);
  expect(published).toMatchObject({
    ok: true,
    result: { filename: "共享笔记.txt", size: 5, uploader: { kind: "agent", id: agentId } },
  });
  expect(requests.map((request) => (request.operation as { kind: string }).kind)).toEqual([
    "workspace_stat",
    "workspace_read_chunk",
    "workspace_stat",
  ]);
  expect(requests.every((request) => request.mode === "agent_publish")).toBe(true);
  expect((requests[1]?.operation as { length: number }).length).toBeLessThanOrEqual(8192);

  const sourceList = await app.request(`/api/owner/channels/${channel.id}/attachments`, {
    headers: { cookie },
  });
  expect(((await sourceList.json()) as { attachments: unknown[] }).attachments).toEqual([]);
  const ownerList = await app.request(`/api/owner/channels/${destination.id}/attachments`, {
    headers: { cookie },
  });
  expect(ownerList.status).toBe(200);
  const items = (await ownerList.json()) as {
    attachments: Array<{ id: string; filename: string }>;
  };
  expect(items.attachments).toMatchObject([{ filename: "共享笔记.txt" }]);
  const content = await app.request(
    `/api/owner/channels/${destination.id}/attachments/${items.attachments[0]!.id}/content`,
    { headers: { cookie } },
  );
  expect(content.status).toBe(200);
  expect(await content.text()).toBe("hello");

  const replay = await callAgentTool(app, socket, run, actionId, "tools.call", input);
  expect(replay.result).toEqual(published.result);
  expect(requests).toHaveLength(3);
  db.prepare(
    `UPDATE owner_channel_memberships SET active=0 WHERE channel_id=? AND principal_kind='agent' AND principal_id=?`,
  ).run(destination.id, agentId);
  const revokedReplay = await callAgentTool(app, socket, run, actionId, "tools.call", input);
  expect(revokedReplay.ok).toBe(false);
  expect(requests).toHaveLength(3);
});

it("streams the owner workspace download one bounded node chunk at a time and stops on cancellation", async () => {
  const { app, cookie, db, nodeId, socket } = await setup(),
    agentId = randomUUID(),
    data = Buffer.from("agent workspace content ".repeat(1200)),
    version = {
      device: "1",
      inode: "2",
      size: data.byteLength,
      modifiedNs: "3",
      changedNs: "4",
    },
    requests: Array<{ kind: string; offset?: number; length?: number }> = [];
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Workspace browser",
    role: "Keeps research files",
    description: "Synthetic workspace test.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: "mate_" + agentId.replaceAll("-", "").slice(0, 27),
      uid: 23001,
      gid: 23001,
      home: `/var/lib/mate/agents/${agentId}`,
      homeMarker: "a".repeat(64),
    },
    app.chat,
  );
  socket.onWorkspaceOperation = async (message) => {
    const operation = message.operation as {
      kind: string;
      path: string;
      offset?: number;
      length?: number;
    };
    requests.push(operation);
    const stdout =
      operation.kind === "workspace_stat"
        ? JSON.stringify({ type: "file", size: data.byteLength, modifiedAt: 1, version })
        : operation.kind === "workspace_list"
          ? JSON.stringify({
              path: operation.path,
              entries: [{ name: "large.bin", type: "file", size: data.byteLength }],
              nextOffset: null,
            })
          : JSON.stringify({
              base64: data
                .subarray(operation.offset, operation.offset! + operation.length!)
                .toString("base64"),
              offset: operation.offset,
              totalBytes: data.byteLength,
              version,
            });
    await app.nodes.receive(
      socket,
      JSON.stringify({
        type: "node.workspace.operation.result",
        requestId: message.requestId,
        operationId: message.operationId,
        agentId,
        ok: true,
        result: { code: 0, stdout, stderr: "", truncated: false },
      }),
    );
  };

  const listing = await app.request(
    `/api/owner/agents/${agentId}/workspace?path=&offset=0&limit=32`,
    {
      headers: { cookie },
    },
  );
  expect(listing.status).toBe(200);
  expect(await listing.json()).toMatchObject({
    entries: [{ name: "large.bin", size: data.byteLength }],
  });

  const completedDownloadId = randomUUID(),
    download = await app.request(
      `/api/owner/agents/${agentId}/workspace/download?path=large.bin&downloadId=${completedDownloadId}`,
      { headers: { cookie } },
    );
  expect(download.status).toBe(200);
  expect(download.headers.get("content-length")).toBe(String(data.byteLength));
  expect(download.headers.get("x-mate-download-id")).toBe(completedDownloadId);
  expect(
    db
      .prepare("SELECT result,completed_at FROM owner_workspace_access_audit WHERE download_id=?")
      .get(completedDownloadId),
  ).toEqual({ result: "started", completed_at: null });
  const reader = download.body!.getReader(),
    chunks: Uint8Array[] = [];
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    expect(item.value.byteLength).toBeLessThanOrEqual(8192);
    chunks.push(item.value);
  }
  expect(Buffer.concat(chunks).equals(data)).toBe(true);
  expect(
    db
      .prepare("SELECT result,completed_at FROM owner_workspace_access_audit WHERE download_id=?")
      .get(completedDownloadId),
  ).toEqual({ result: "succeeded", completed_at: expect.any(Number) });
  expect(
    await (
      await app.request(`/api/owner/agents/${agentId}/workspace/downloads/${completedDownloadId}`, {
        headers: { cookie },
      })
    ).json(),
  ).toMatchObject({ state: "succeeded", errorCode: null });
  const secondLogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }),
    secondCookie = secondLogin.headers.get("set-cookie")!.split(";", 1)[0]!,
    otherSessionStatus = await app.request(
      `/api/owner/agents/${agentId}/workspace/downloads/${completedDownloadId}`,
      { headers: { cookie: secondCookie } },
    );
  expect(otherSessionStatus.status).toBe(404);
  db.prepare(
    "UPDATE owner_workspace_access_audit SET download_expires_at=? WHERE download_id=?",
  ).run(Date.now() - 1, completedDownloadId);
  const expiredStatus = await app.request(
    `/api/owner/agents/${agentId}/workspace/downloads/${completedDownloadId}`,
    { headers: { cookie } },
  );
  expect(expiredStatus.status).toBe(404);
  expect(
    db
      .prepare(
        "SELECT download_id,owner_session_hash,download_expires_at FROM owner_workspace_access_audit WHERE id=(SELECT id FROM owner_workspace_access_audit WHERE agent_id=? AND operation='download' AND result='succeeded' LIMIT 1)",
      )
      .get(agentId),
  ).toEqual({ download_id: null, owner_session_hash: null, download_expires_at: null });
  const downloadChunks = requests.filter((request) => request.kind === "workspace_read_chunk");
  expect(downloadChunks).toHaveLength(Math.ceil(data.byteLength / 8192));
  expect(downloadChunks.every((request) => request.length === 8192)).toBe(true);

  const previousChunks = requests.filter(
      (request) => request.kind === "workspace_read_chunk",
    ).length,
    interruptedDownloadId = randomUUID(),
    interrupted = await app.request(
      `/api/owner/agents/${agentId}/workspace/download?path=large.bin&downloadId=${interruptedDownloadId}`,
      { headers: { cookie } },
    ),
    interruptReader = interrupted.body!.getReader();
  const first = await interruptReader.read();
  expect(first.done).toBe(false);
  expect(first.value!.byteLength).toBeLessThanOrEqual(8192);
  await interruptReader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const interruptedChunks =
    requests.filter((request) => request.kind === "workspace_read_chunk").length - previousChunks;
  expect(interruptedChunks).toBeLessThanOrEqual(2);
  expect(
    await (
      await app.request(
        `/api/owner/agents/${agentId}/workspace/downloads/${interruptedDownloadId}`,
        { headers: { cookie } },
      )
    ).json(),
  ).toMatchObject({ state: "cancelled", errorCode: "download_cancelled" });
});

it("records owner workspace reads and safe failure codes without file contents", async () => {
  const { app, cookie, db, nodeId, socket } = await setup(),
    agentId = randomUUID(),
    version = { device: "1", inode: "2", size: 4, modifiedNs: "3", changedNs: "4" };
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Audited workspace",
    role: "Keeps private files",
    description: "Synthetic audit fixture.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: "mate_" + agentId.replaceAll("-", "").slice(0, 27),
      uid: 23001,
      gid: 23001,
      home: `/var/lib/mate/agents/${agentId}`,
      homeMarker: "a".repeat(64),
    },
    app.chat,
  );
  socket.onWorkspaceOperation = async (message) => {
    const operation = message.operation as { kind: string; path: string; offset?: number };
    let code = 0,
      stdout = "{}",
      stderr = "";
    if (operation.path.includes("..") || operation.path.includes("\0")) {
      code = 1;
      stderr = "unsafe_path: Path escapes the workspace";
    } else if (operation.path === "missing.txt") {
      code = 1;
      stderr = `Error: ENOENT: no such file or directory, open '${"m".repeat(650)}'\n    at openSync (node:fs:...)`;
    } else if (operation.path === "private.txt") {
      code = 1;
      stderr = "Error: EACCES: permission denied, open 'private.txt'";
    } else if (operation.path === "changed.txt" && operation.kind === "workspace_read_chunk") {
      code = 1;
      stderr = "file_changed: File changed while it was being read";
    } else if (operation.kind === "workspace_stat") {
      stdout = JSON.stringify({ type: "file", size: 4, modifiedAt: 1, version });
    } else if (operation.kind === "workspace_read_chunk") {
      stdout = JSON.stringify({
        offset: operation.offset,
        totalBytes: 4,
        base64: "c2FmZQ==",
        version,
      });
    } else if (operation.kind === "workspace_list") {
      stdout = JSON.stringify({ path: operation.path, entries: [], nextOffset: null });
    }
    await app.nodes.receive(
      socket,
      JSON.stringify({
        type: "node.workspace.operation.result",
        requestId: message.requestId,
        operationId: message.operationId,
        agentId,
        ok: true,
        result: { code, stdout, stderr, truncated: false },
      }),
    );
  };

  const listing = await app.request(`/api/owner/agents/${agentId}/workspace?path=`, {
      headers: { cookie },
    }),
    absoluteListing = await app.request(
      `/api/owner/agents/${agentId}/workspace?path=${encodeURIComponent(`/var/lib/mate/agents/${agentId}/notes`)}`,
      { headers: { cookie } },
    ),
    relativeTraversal = await app.request(
      `/api/owner/agents/${agentId}/workspace?path=${encodeURIComponent("../../etc/passwd")}`,
      { headers: { cookie } },
    ),
    absoluteTraversal = await app.request(
      `/api/owner/agents/${agentId}/workspace?path=${encodeURIComponent(`/var/lib/mate/agents/${agentId}/notes/../safe.txt`)}`,
      { headers: { cookie } },
    ),
    nulPath = await app.request(
      `/api/owner/agents/${agentId}/workspace?path=${encodeURIComponent("notes\0.txt")}`,
      { headers: { cookie } },
    ),
    outsideAbsoluteListing = await app.request(
      `/api/owner/agents/${agentId}/workspace?path=${encodeURIComponent("/etc/passwd")}`,
      { headers: { cookie } },
    ),
    missing = await app.request(`/api/owner/agents/${agentId}/workspace/stat?path=missing.txt`, {
      headers: { cookie },
    }),
    denied = await app.request(`/api/owner/agents/${agentId}/workspace/stat?path=private.txt`, {
      headers: { cookie },
    });
  expect(listing.status).toBe(200);
  expect(absoluteListing.status).toBe(200);
  expect(relativeTraversal.status).toBe(403);
  expect(absoluteTraversal.status).toBe(403);
  expect(nulPath.status).toBe(403);
  expect(outsideAbsoluteListing.status).toBe(200);
  expect(missing.status).toBe(404);
  expect(denied.status).toBe(403);
  const changedDownloadId = randomUUID(),
    changed = await app.request(
      `/api/owner/agents/${agentId}/workspace/download?path=changed.txt&downloadId=${changedDownloadId}`,
      { headers: { cookie } },
    );
  expect(changed.status).toBe(200);
  await expect(changed.arrayBuffer()).rejects.toThrow();
  expect(
    await (
      await app.request(`/api/owner/agents/${agentId}/workspace/downloads/${changedDownloadId}`, {
        headers: { cookie },
      })
    ).json(),
  ).toMatchObject({ state: "failed", errorCode: "file_changed" });

  const missingDownloadId = randomUUID(),
    missingDownload = await app.request(
      `/api/owner/agents/${agentId}/workspace/download?path=missing.txt&downloadId=${missingDownloadId}`,
      { headers: { cookie } },
    );
  expect(missingDownload.status).toBe(404);
  expect(await missingDownload.json()).toMatchObject({ code: "not_found" });
  expect(
    await (
      await app.request(`/api/owner/agents/${agentId}/workspace/downloads/${missingDownloadId}`, {
        headers: { cookie },
      })
    ).json(),
  ).toMatchObject({ state: "failed", errorCode: "not_found" });

  const permissionDownloadId = randomUUID(),
    permissionDownload = await app.request(
      `/api/owner/agents/${agentId}/workspace/download?path=private.txt&downloadId=${permissionDownloadId}`,
      { headers: { cookie } },
    );
  expect(permissionDownload.status).toBe(403);
  expect(await permissionDownload.json()).toMatchObject({ code: "permission_denied" });
  expect(
    await (
      await app.request(
        `/api/owner/agents/${agentId}/workspace/downloads/${permissionDownloadId}`,
        { headers: { cookie } },
      )
    ).json(),
  ).toMatchObject({ state: "failed", errorCode: "permission_denied" });

  const browserError = await app.request(
    `/api/owner/agents/${agentId}/workspace/download?path=missing.txt&downloadId=${randomUUID()}&format=browser`,
    { headers: { cookie } },
  );
  expect(browserError.status).toBe(404);
  expect(browserError.headers.get("content-type")).toContain("text/html");
  expect(await browserError.text()).toContain("文件或目录不存在");

  const audit = db
    .prepare(
      `SELECT actor_kind,actor_id,agent_id,operation,relative_paths,result,error_code,download_id
       FROM owner_workspace_access_audit WHERE agent_id=? ORDER BY id`,
    )
    .all(agentId) as Array<Record<string, unknown>>;
  expect(audit).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        actor_kind: "owner",
        actor_id: "owner",
        operation: "list",
        relative_paths: '[""]',
        result: "succeeded",
        error_code: null,
      }),
      expect.objectContaining({
        operation: "list",
        relative_paths: '["notes"]',
        result: "succeeded",
      }),
      expect.objectContaining({
        operation: "list",
        relative_paths: '["[absolute path request]"]',
        result: "succeeded",
      }),
      expect.objectContaining({
        operation: "stat",
        relative_paths: '["missing.txt"]',
        result: "failed",
        error_code: "not_found",
      }),
      expect.objectContaining({
        operation: "stat",
        relative_paths: '["private.txt"]',
        result: "failed",
        error_code: "permission_denied",
      }),
      expect.objectContaining({
        operation: "read_chunk",
        relative_paths: '["changed.txt"]',
        result: "failed",
        error_code: "file_changed",
      }),
      expect.objectContaining({
        operation: "download",
        relative_paths: '["changed.txt"]',
        result: "failed",
        error_code: "file_changed",
        download_id: changedDownloadId,
      }),
    ]),
  );
  expect(
    audit
      .filter((row) => row.operation === "list" && row.result === "failed")
      .map((row) => row.relative_paths),
  ).toEqual(['["[invalid path]"]', '["[invalid path]"]', '["[invalid path]"]']);
  expect(JSON.stringify(audit)).not.toContain("safe.txt");
  expect(db.prepare("PRAGMA table_info(owner_workspace_access_audit)").all()).not.toContainEqual(
    expect.objectContaining({ name: "content" }),
  );
});

it("marks an unfinished workspace download as interrupted after control-plane restart", async () => {
  const { app, db } = await setup(),
    agentId = randomUUID(),
    downloadId = randomUUID();
  db.prepare(
    `INSERT INTO owner_workspace_access_audit(
       at,actor_kind,actor_id,agent_id,operation,relative_paths,result,download_id
     ) VALUES(?,?,?,?,?,?,?,?)`,
  ).run(Date.now(), "owner", "owner", agentId, "download", '["notes.txt"]', "started", downloadId);

  const restartedWorkspace = new WorkspaceService(db, app.nodes, app.chat);

  expect(
    db
      .prepare("SELECT result,error_code FROM owner_workspace_access_audit WHERE download_id=?")
      .get(downloadId),
  ).toEqual({ result: "failed", error_code: "download_interrupted" });
  expect(
    db
      .prepare("SELECT completed_at FROM owner_workspace_access_audit WHERE download_id=?")
      .get(downloadId),
  ).toEqual({ completed_at: expect.any(Number) });
  restartedWorkspace.close();
});

it("expires abandoned download status with a terminal audit result and clears its session binding", async () => {
  const { app, db } = await setup(),
    agentId = randomUUID(),
    downloadId = randomUUID();
  db.prepare(
    `INSERT INTO owner_workspace_access_audit(
       at,actor_kind,actor_id,agent_id,operation,relative_paths,result,
       download_id,owner_session_hash,download_expires_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    Date.now() - 2,
    "owner",
    "owner",
    agentId,
    "download",
    '["notes.txt"]',
    "started",
    downloadId,
    "synthetic-session-hash",
    Date.now() - 1,
  );

  expect(() => app.workspace.downloadStatus(agentId, downloadId, "unrelated-session")).toThrow(
    "找不到这次文件下载记录",
  );
  expect(
    db
      .prepare(
        `SELECT result,error_code,completed_at,download_id,owner_session_hash,download_expires_at
         FROM owner_workspace_access_audit WHERE agent_id=?`,
      )
      .get(agentId),
  ).toEqual({
    result: "failed",
    error_code: "download_status_expired",
    completed_at: expect.any(Number),
    download_id: null,
    owner_session_hash: null,
    download_expires_at: null,
  });
});

it("persists separate attention and draft choices while gating stale sends", async () => {
  const { app, cookie, nodeId, socket, db, directory } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Attentive peer",
    role: "Synthetic",
    description: "Attention fixture",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: "mate_" + agentId.replaceAll("-", "").slice(0, 27),
      uid: 23001,
      gid: 23001,
      home: `/var/lib/mate/agents/${agentId}`,
      homeMarker: "a".repeat(64),
    },
    app.chat,
  );
  const dm = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-attention-key" }),
  });
  const from = socket.sent.length;
  const first = app.chat.createMessage(dm.id, "Initial context")!;
  const run = await waitForRun(socket, from);
  async function tool(id: string, name: string, input: Record<string, unknown>) {
    const result = await callAgentTool(app, socket, run, id, "tools.call", { name, input });
    expect(result.ok).toBe(true);
    return result.result as Record<string, unknown>;
  }
  const notice = await tool("attention-before", "attention.list", { conversationId: dm.id });
  expect(notice.items).toEqual([
    expect.objectContaining({ messageId: first.id, unread: 1, seen: 0, presented: 0 }),
  ]);
  await tool("attention-seen", "attention.update", {
    conversationId: dm.id,
    messageId: first.id,
    seen: true,
    deferred: true,
    muted: true,
  });
  const seen = await tool("attention-after", "attention.list", { conversationId: dm.id });
  expect(seen.items).toEqual([
    expect.objectContaining({
      messageId: first.id,
      unread: 1,
      seen: 1,
      deferred: 1,
      muted: 1,
      presented: 0,
    }),
  ]);
  await tool("read-body", "conversations.read", { conversationId: dm.id });
  const presented = await tool("attention-presented", "attention.list", { conversationId: dm.id });
  expect(presented.items).toEqual([
    expect.objectContaining({ messageId: first.id, unread: 1, presented: 1 }),
  ]);
  app.chat.createMessage(dm.id, "Before unprepared send");
  const unprepared = await tool("unprepared-send", "messages.send", {
    conversationId: dm.id,
    text: "Must review first",
  });
  expect(unprepared).toMatchObject({
    status: "needs_review",
    changes: [expect.objectContaining({ text: "Before unprepared send" })],
  });
  const unpreparedDraft = unprepared.draftId as string;
  await tool("unprepared-defer", "drafts.review", { draftId: unpreparedDraft, choice: "defer" });
  const saved = await tool("draft-save", "drafts.save", {
    conversationId: dm.id,
    text: "First attempt",
  });
  const draftId = saved.id as string;
  app.chat.createMessage(dm.id, "Concurrent change");
  const changes = await tool("draft-inspect", "drafts.review", { draftId, choice: "inspect" });
  expect(changes.changes).toEqual([expect.objectContaining({ text: "Concurrent change" })]);
  await tool("draft-keep", "drafts.review", { draftId, choice: "keep" });
  const refused = await callAgentTool(app, socket, run, "draft-premature-send", "tools.call", {
    name: "messages.send",
    input: { conversationId: dm.id, text: "First attempt", draftId },
  });
  expect(refused).toMatchObject({ ok: false, error: "Draft is not ready for this message" });
  await tool("draft-continue", "drafts.review", { draftId, choice: "continue" });
  app.chat.createMessage(dm.id, "Another concurrent change");
  const stale = await callAgentTool(app, socket, run, "draft-stale-send", "tools.call", {
    name: "messages.send",
    input: { conversationId: dm.id, text: "First attempt", draftId },
  });
  expect(stale).toMatchObject({ ok: false, error: "Conversation changed; review the draft again" });
  const uninformed = await callAgentTool(
    app,
    socket,
    run,
    "draft-uninformed-continue",
    "tools.call",
    { name: "drafts.review", input: { draftId, choice: "continue" } },
  );
  expect(uninformed).toMatchObject({
    ok: false,
    error: "Conversation changed; inspect the draft before continuing",
  });
  await tool("draft-inspect-again", "drafts.review", { draftId, choice: "inspect" });
  await tool("draft-continue-again", "drafts.review", { draftId, choice: "continue" });
  const sent = await tool("draft-send", "messages.send", {
    conversationId: dm.id,
    text: "First attempt",
    draftId,
  });
  expect(sent.text).toBe("First attempt");
  const threadReply = app.chat.createMessage(dm.id, "Full thread reply", { rootId: first.id })!;
  expect(
    app.chat
      .listPendingDeliveries("agent", agentId)
      .deliveries.find((delivery) => delivery.messageId === threadReply.id)?.message.rootId,
  ).toBe(first.id);
  const fullThread = await tool("full-thread", "conversations.read_thread", {
    conversationId: dm.id,
    rootId: first.id,
  });
  expect(fullThread).toMatchObject({
    root: { id: first.id },
    replies: [{ id: threadReply.id, rootId: first.id }],
  });
  const second = await tool("draft-second", "drafts.save", {
    conversationId: dm.id,
    text: "Abandon this",
  });
  await tool("draft-abandon", "drafts.review", { draftId: second.id, choice: "abandon" });
  expect(db.prepare("SELECT state FROM owner_agent_drafts WHERE id=?").get(second.id)).toEqual({
    state: "abandoned",
  });
  app.close();
  const restarted = createControlPlaneApp({
    dataDir: join(directory, "control-plane"),
    passwordFile: join(directory, "owner-password"),
  });
  fixtures.push({
    app: restarted,
    directory,
    db: new Database(join(directory, "control-plane", "control-plane.sqlite")),
  });
  expect(restarted.chat.listAgentAttention(agentId, dm.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        messageId: first.id,
        unread: 1,
        seen: 1,
        deferred: 1,
        muted: 1,
        presented: 1,
      }),
    ]),
  );
  expect(restarted.chat.readPersistedAgentDraft(agentId, second.id as string)).toMatchObject({
    state: "abandoned",
    text: "Abandon this",
    channelId: dm.id,
  });
});

it("does not let a saved draft or a later paginated read hide unseen conversation changes", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Freshness peer",
    role: "Synthetic",
    description: "Freshness fixture",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: "mate_" + agentId.replaceAll("-", "").slice(0, 27),
      uid: 23001,
      gid: 23001,
      home: `/var/lib/mate/agents/${agentId}`,
      homeMarker: "a".repeat(64),
    },
    app.chat,
  );
  const dm = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-freshness-key" }),
  });
  const from = socket.sent.length;
  app.chat.createMessage(dm.id, "Run input");
  const run = await waitForRun(socket, from);
  async function tool(id: string, name: string, input: Record<string, unknown>) {
    return callAgentTool(app, socket, run, id, "tools.call", { name, input });
  }
  const firstChange = app.chat.createMessage(dm.id, "Earlier unseen change")!;
  const secondChange = app.chat.createMessage(dm.id, "Later visible change")!;
  const read = await tool("read-latest-only", "conversations.read", {
    conversationId: dm.id,
    limit: 1,
  });
  expect(read).toMatchObject({ ok: true, result: { messages: [{ id: secondChange.id }] } });
  const forged = await tool("forge-presented", "attention.update", {
    conversationId: dm.id,
    messageId: firstChange.id,
    presented: true,
  });
  expect(forged).toMatchObject({ ok: false, error: "Invalid tool input" });
  const saved = await tool("save-after-changes", "drafts.save", {
    conversationId: dm.id,
    text: "Draft text",
  });
  expect(saved).toMatchObject({
    ok: true,
    result: {
      changes: [expect.objectContaining({ id: firstChange.id, text: "Earlier unseen change" })],
    },
  });
  const draftId = (saved.result as { id: string }).id;
  const continued = await tool("continue-after-save", "drafts.review", {
    draftId,
    choice: "continue",
  });
  expect(continued.ok).toBe(true);
  const sent = await tool("send-after-review", "messages.send", {
    conversationId: dm.id,
    text: "Draft text",
    draftId,
  });
  expect(sent).toMatchObject({ ok: true, result: { text: "Draft text" } });
});

it("holds Agent task changes for fresh discussion and queues an offline reminder without marking it handled", async () => {
  const { app, cookie, nodeId, socket, db } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Task partner",
    role: "Coordinates work",
    description: "Synthetic fixture",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: "mate_" + agentId.replaceAll("-", "").slice(0, 27),
      uid: 23001,
      gid: 23001,
      home: `/var/lib/mate/agents/${agentId}`,
      homeMarker: "a".repeat(64),
    },
    app.chat,
  );
  const dm = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-task-key" }),
  });
  const from = socket.sent.length;
  const anchor = app.chat.createMessage(dm.id, "Investigate the alert", { asTask: true })!;
  const task = app.chat.taskForMessage(anchor.id)!;
  const run = await waitForRun(socket, from);
  const changedMessage = app.chat.createMessage(dm.id, "Please include the restart case")!;
  async function tool(id: string, name: string, input: Record<string, unknown>) {
    return callAgentTool(app, socket, run, id, "tools.call", { name, input });
  }
  const held = await tool("claim-held", "tasks.claim", { taskId: task.id, expectedVersion: 1 });
  expect(held).toMatchObject({ ok: true, result: { status: "needs_review" } });
  expect(app.chat.listAgentAttention(agentId, dm.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        messageId: changedMessage.id,
        unread: 1,
        seen: 0,
        deferred: 0,
        presented: 1,
      }),
    ]),
  );
  expect(app.chat.readTask(task.id)).toMatchObject({ ownerAgentId: null, version: 1 });
  expect(app.chat.taskActivity(task.id)).toHaveLength(1);
  const draftId = (held.result as { draftId: string }).draftId;
  expect((await tool("claim-keep", "tasks.review", { draftId, choice: "keep" })).ok).toBe(true);
  expect((await tool("claim-continue", "tasks.review", { draftId, choice: "continue" })).ok).toBe(
    true,
  );
  const lateChange = app.chat.createMessage(dm.id, "A newer decision arrived")!;
  expect(
    await tool("claim-stale", "tasks.claim", { taskId: task.id, expectedVersion: 1, draftId }),
  ).toMatchObject({ ok: false, error: "Conversation changed; review the task draft again" });
  expect(app.chat.readTask(task.id)).toMatchObject({ ownerAgentId: null, version: 1 });
  await tool("claim-inspect-late", "tasks.review", { draftId, choice: "inspect" });
  expect(app.chat.listAgentAttention(agentId, dm.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        messageId: lateChange.id,
        unread: 1,
        seen: 0,
        deferred: 0,
        presented: 1,
      }),
    ]),
  );
  await tool("claim-continue-late", "tasks.review", { draftId, choice: "continue" });
  const claimed = await tool("claim-applied", "tasks.claim", {
    taskId: task.id,
    expectedVersion: 1,
    draftId,
  });
  expect(claimed).toMatchObject({
    ok: true,
    result: { ownerAgentId: agentId, status: "in_progress" },
  });
  expect(
    await tool("claim-applied", "tasks.claim", { taskId: task.id, expectedVersion: 1, draftId }),
  ).toMatchObject({ ok: true, result: { ownerAgentId: agentId, version: 2 } });
  expect(
    await tool("claim-applied", "tasks.update", {
      taskId: task.id,
      expectedVersion: 2,
      status: "done",
    }),
  ).toMatchObject({ ok: false, error: "Action ID was already used for a different request" });
  expect(
    await callAgentTool(
      app,
      socket,
      { ...run, runId: randomUUID() },
      "stale-run-task",
      "tools.call",
      {
        name: "tasks.yield",
        input: { taskId: task.id, expectedVersion: 2 },
      },
    ),
  ).toMatchObject({ ok: false });
  expect(app.chat.taskActivity(task.id)).toHaveLength(2);
  expect(app.chat.listMessages(dm.id, undefined, 100)?.messages).toHaveLength(3);
  const updated = await tool("update-direct", "tasks.update", {
    taskId: task.id,
    expectedVersion: 2,
    status: "done",
    note: "Verified after restart",
  });
  expect(updated).toMatchObject({ ok: true, result: { status: "done", version: 3 } });
  const taskSource = app.chat.createMessage(dm.id, "A separate new task")!;
  const createHeld = await tool("create-held", "tasks.create", { messageId: taskSource.id });
  expect(createHeld.error).toBeUndefined();
  expect(createHeld).toMatchObject({ ok: true, result: { status: "needs_review" } });
  const createDraft = (createHeld.result as { draftId: string }).draftId;
  await tool("create-keep", "tasks.review", { draftId: createDraft, choice: "keep" });
  await tool("create-continue", "tasks.review", { draftId: createDraft, choice: "continue" });
  expect(
    await tool("create-applied", "tasks.create", {
      messageId: taskSource.id,
      draftId: createDraft,
    }),
  ).toMatchObject({
    ok: true,
    result: { messageId: taskSource.id, title: taskSource.text },
  });
  const inaccessible = app.chat.createChannel({
    name: "Private",
    description: "",
    visibility: "private",
  });
  const secret = app.chat.createMessage(inaccessible.id, "Secret task", { asTask: true })!;
  expect(
    await tool("secret-claim", "tasks.claim", {
      taskId: app.chat.taskForMessage(secret.id)!.id,
      expectedVersion: 1,
    }),
  ).toMatchObject({ ok: false, error: "Conversation is not available" });
  const later = await tool("reminder-later", "reminders.create", {
    conversationId: dm.id,
    text: "Follow up tomorrow",
    dueAt: Date.now() + 86_400_000,
  });
  expect(later.ok).toBe(true);
  const laterId = (later.result as { id: string }).id;
  expect(
    await tool("reminder-reschedule", "reminders.reschedule", {
      reminderId: laterId,
      expectedVersion: 1,
      dueAt: Date.now() + 172_800_000,
    }),
  ).toMatchObject({ ok: true, result: { version: 2 } });
  expect(
    await tool("reminder-stale-cancel", "reminders.cancel", {
      reminderId: laterId,
      expectedVersion: 1,
    }),
  ).toMatchObject({ ok: false, error: "Reminder version or state changed" });
  expect(
    await tool("reminder-cancel", "reminders.cancel", {
      reminderId: laterId,
      expectedVersion: 2,
    }),
  ).toMatchObject({ ok: true, result: { state: "cancelled", version: 3 } });
  const reminder = await tool("reminder-create", "reminders.create", {
    conversationId: dm.id,
    taskId: task.id,
    text: "Check the alert again",
    dueAt: 1,
  });
  expect(reminder.ok).toBe(true);
  const reminderId = (reminder.result as { id: string }).id;
  app.nodes.closeAll();
  app.chat.fireDueReminders();
  const reminders = app.chat.listAgentReminders(agentId);
  expect(reminders).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: reminderId,
        state: "fired",
        firing: {
          firedAt: expect.any(Number),
          handledAt: null,
        },
      }),
    ]),
  );
  const delivery = db
    .prepare(
      "SELECT id,state FROM owner_message_deliveries WHERE id=(SELECT delivery_id FROM owner_reminder_firings WHERE reminder_id=?)",
    )
    .get(reminderId) as { id: string; state: string };
  expect(app.chat.acknowledgeDelivery(delivery.id, "agent", agentId)).toBe(false);
  expect(delivery.state).toBe("pending");
  expect(app.chat.listMessages(dm.id, undefined, 100)?.messages).toHaveLength(4);
  app.close();
  const restarted = createControlPlaneApp({
    dataDir: join(fixtures.at(-1)!.directory, "control-plane"),
    passwordFile: join(fixtures.at(-1)!.directory, "owner-password"),
  });
  fixtures.push({
    app: restarted,
    directory: fixtures.at(-1)!.directory,
    db: new Database(join(fixtures.at(-1)!.directory, "control-plane", "control-plane.sqlite")),
  });
  expect(restarted.chat.listAgentReminders(agentId)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: reminderId,
        state: "fired",
        firing: { firedAt: expect.any(Number), handledAt: null },
      }),
    ]),
  );
});

it("lets peers coordinate on one task without a tree and preserves a newer claim when the former owner yields", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const firstId = randomUUID(),
    secondId = randomUUID();
  for (const [id, uid] of [
    [firstId, 23001],
    [secondId, 23002],
  ] as const) {
    app.agents.prepare({
      id,
      nodeId,
      name: `Peer ${uid}`,
      role: "Collaborates directly",
      description: "Synthetic fixture",
      model: { provider: "openai", id: "gpt-4.1" },
    });
    app.agents.complete(
      id,
      {
        username: "mate_" + id.replaceAll("-", "").slice(0, 27),
        uid,
        gid: uid,
        home: `/var/lib/mate/agents/${id}`,
        homeMarker: "a".repeat(64),
      },
      app.chat,
    );
  }
  const room = app.chat.createChannel({
    name: "Shared work",
    description: "",
    visibility: "public",
  });
  expect(app.chat.inviteAgentToChannel(room.id, firstId)).toBe(true);
  expect(app.chat.inviteAgentToChannel(room.id, secondId)).toBe(true);
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-peer-key" }),
  });
  const from = socket.sent.length;
  const anchor = app.chat.createMessage(room.id, "Review deployment", { asTask: true })!;
  const task = app.chat.taskForMessage(anchor.id)!;
  await waitForRun(socket, from);
  let runs: Array<Extract<NodeControlMessage, { type: "control.agent.run" }>> = [];
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    runs = socket.sent
      .slice(from)
      .map((text) => JSON.parse(text) as Extract<NodeControlMessage, { type: "control.agent.run" }>)
      .filter((value) => value.type === "control.agent.run");
    if (runs.some((run) => run.agentId === firstId) && runs.some((run) => run.agentId === secondId))
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const first = runs.find((run) => run.agentId === firstId)!,
    second = runs.find((run) => run.agentId === secondId)!;
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  async function action(
    run: typeof first,
    id: string,
    name: string,
    input: Record<string, unknown>,
  ) {
    return callAgentTool(app, socket, run, id, "tools.call", { name, input });
  }
  expect(
    await action(first, "first-claim", "tasks.claim", { taskId: task.id, expectedVersion: 1 }),
  ).toMatchObject({ ok: true, result: { ownerAgentId: firstId, version: 2 } });
  expect(
    await action(first, "first-yield", "tasks.yield", { taskId: task.id, expectedVersion: 2 }),
  ).toMatchObject({ ok: true, result: { ownerAgentId: null, version: 3 } });
  expect(
    await action(second, "second-claim", "tasks.claim", { taskId: task.id, expectedVersion: 3 }),
  ).toMatchObject({ ok: true, result: { ownerAgentId: secondId, version: 4 } });
  expect(
    await action(first, "late-yield", "tasks.yield", { taskId: task.id, expectedVersion: 2 }),
  ).toMatchObject({ ok: true, result: { ownerAgentId: secondId, version: 5 } });
  expect(
    await action(second, "peer-transfer", "tasks.transfer", {
      taskId: task.id,
      expectedVersion: 5,
      agentId: firstId,
    }),
  ).toMatchObject({ ok: true, result: { ownerAgentId: firstId, version: 6 } });
  expect(app.chat.taskActivity(task.id)).toHaveLength(6);
  expect(app.chat.listMessages(room.id, undefined, 10)?.messages).toHaveLength(1);
});

async function startReminderFixture(fixture: Awaited<ReturnType<typeof setup>>) {
  const { app, cookie, nodeId, socket } = fixture;
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Reminder partner",
    role: "Remembers work",
    description: "Synthetic reminder fixture",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: "mate_" + agentId.replaceAll("-", "").slice(0, 27),
      uid: 23001,
      gid: 23001,
      home: `/var/lib/mate/agents/${agentId}`,
      homeMarker: "a".repeat(64),
    },
    app.chat,
  );
  const dm = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-reminder-key" }),
  });
  const from = socket.sent.length;
  app.chat.createMessage(dm.id, "Set a follow-up reminder");
  const initialRun = await waitForRun(socket, from);
  const create = await callAgentTool(app, socket, initialRun, "create-followup", "tools.call", {
    name: "reminders.create",
    input: { conversationId: dm.id, text: "Check deployment", dueAt: Date.now() + 250 },
  });
  expect(create).toMatchObject({ ok: true });
  const reminderId = (create.result as { id: string }).id;
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: initialRun.runId,
      runId: initialRun.runId,
      agentId,
      ok: true,
    }),
  );
  return { agentId, dm, reminderId };
}

it("delivers an offline reminder from an archived DM after reconnect without reopening ordinary chat writes", async () => {
  const fixture = await setup();
  const { app, cookie, nodeId, socket, nodePrivateKey } = fixture;
  const { agentId, dm, reminderId } = await startReminderFixture(fixture);
  app.nodes.close(socket);
  const archivedOrdinary = app.chat.createMessage(dm.id, "Keep this ordinary input pending")!;
  const archive = await app.request(`/api/owner/channels/${dm.id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });
  expect(archive.status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 280));
  app.chat.fireDueReminders();
  expect(app.chat.listAgentReminders(agentId)).toEqual([
    expect.objectContaining({
      id: reminderId,
      state: "fired",
      firing: { firedAt: expect.any(Number), handledAt: null },
    }),
  ]);
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toHaveLength(2);
  const reconnected = await reconnectNode(app, nodeId, nodePrivateKey);
  const run = await waitForRun(reconnected, 0);
  expect(run.channelId).toBe(dm.id);
  const context = await callAgentRunContext(app, reconnected, run);
  expect(
    context.messages.filter((message) => message.currentRunInput).map((message) => message.text),
  ).toEqual(["提醒：Check deployment"]);
  const denied = await callAgentTool(app, reconnected, run, "archived-send", "tools.call", {
    name: "messages.send",
    input: { conversationId: dm.id, text: "Must stay archived" },
  });
  expect(denied).toMatchObject({ ok: false });
  await app.nodes.receive(
    reconnected,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: run.runId,
      runId: run.runId,
      agentId,
      ok: true,
    }),
  );
  app.chat.syncHandledReminders();
  expect(app.chat.listAgentReminders(agentId)[0]?.firing?.handledAt).not.toBeNull();
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toMatchObject([
    { messageId: archivedOrdinary.id },
  ]);
  expect(app.chat.listMessages(dm.id, undefined, 10)?.messages).toHaveLength(2);
});

it("keeps a real Pi model reply private when its reminder runs in an archived DM", async () => {
  const fixture = await setup();
  const { app, cookie, db, nodeId, socket, nodePrivateKey } = fixture;
  const { agentId, dm, reminderId } = await startReminderFixture(fixture);
  app.nodes.close(socket);
  await app.request(`/api/owner/channels/${dm.id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });
  await new Promise((resolve) => setTimeout(resolve, 280));
  app.chat.fireDueReminders();
  const reconnected = await reconnectNode(app, nodeId, nodePrivateKey);
  const run = await waitForRun(reconnected, 0);
  const alternate = app.chat.createChannel({
    name: "Active reminder update",
    description: "An authorized alternate route",
    visibility: "private",
  });
  expect(app.chat.inviteAgentToChannel(alternate.id, agentId)).toBe(true);
  expect(
    await callAgentTool(app, reconnected, run, "alternate-reminder-send", "tools.call", {
      name: "messages.send",
      input: { conversationId: alternate.id, text: "A conscious update in an active conversation" },
    }),
  ).toMatchObject({ ok: true });
  const responses: Array<{ ok: boolean; code?: string }> = [];
  let transcriptRequestId = "";
  const transport: AgentRunTransport = {
    context: async () => callAgentRunContext(app, reconnected, run),
    transcript: async (text) => {
      transcriptRequestId = randomUUID();
      await app.nodes.receive(
        reconnected,
        JSON.stringify({
          type: "node.agent.run.transcript",
          requestId: transcriptRequestId,
          runId: run.runId,
          agentId,
          text,
        }),
      );
      return (JSON.parse(reconnected.sent.at(-1)!) as { accepted: boolean }).accepted;
    },
    tool: async () => ({ ok: false, error: "Unexpected tool call" }),
    result: (ok, code) => responses.push({ ok, ...(code ? { code } : {}) }),
  };
  await runAgentModel(run, transport, new AbortController().signal, {
    modelWorkerEntry: resolve("tests/fixtures/direct-message-model-worker.mjs"),
  });
  expect(responses).toEqual([{ ok: true }]);
  await app.nodes.receive(
    reconnected,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: randomUUID(),
      runId: run.runId,
      agentId,
      ok: true,
    }),
  );
  app.chat.syncHandledReminders();
  expect(app.chat.listAgentReminders(agentId)[0]).toMatchObject({
    id: reminderId,
    firing: { handledAt: expect.any(Number) },
  });
  expect(app.chat.listMessages(dm.id, undefined, 10)?.messages).toHaveLength(1);
  expect(app.chat.listMessages(alternate.id, undefined, 10)?.messages).toMatchObject([
    { text: "A conscious update in an active conversation" },
  ]);
  expect(
    db.prepare("SELECT state,error_code FROM owner_agent_runs WHERE id=?").get(run.runId),
  ).toMatchObject({
    state: "completed",
    error_code: null,
  });
  // The archived reminder run still records its own turn privately and keeps it verbatim.
  expect(
    db
      .prepare(
        "SELECT message_id,text FROM owner_agent_session_journal WHERE run_id=? AND role='assistant' AND tool_action_id IS NULL",
      )
      .get(run.runId),
  ).toMatchObject({
    message_id: null,
    text: "这是首次测试回复。",
  });
  expect(
    app.chat.recordAgentRunTranscript(
      run.runId,
      nodeId,
      agentId,
      transcriptRequestId,
      "这是首次测试回复。",
    ),
  ).toBe(true);
  expect(
    app.chat.recordAgentRunTranscript(
      run.runId,
      nodeId,
      agentId,
      randomUUID(),
      "这是首次测试回复。",
    ),
  ).toBe(false);
});

it("marks a reminder handled when a preceding DM delivery starts the completed batch", async () => {
  const fixture = await setup();
  const { app, nodeId, socket, nodePrivateKey, db } = fixture;
  const { agentId, dm, reminderId } = await startReminderFixture(fixture);
  app.nodes.close(socket);
  const ordinary = app.chat.createMessage(dm.id, "An earlier offline message")!;
  await new Promise((resolve) => setTimeout(resolve, 280));
  app.chat.fireDueReminders();
  const pending = app.chat.listPendingDeliveries("agent", agentId).deliveries;
  expect(pending).toHaveLength(2);
  expect(pending[0]?.messageId).toBe(ordinary.id);
  const reconnected = await reconnectNode(app, nodeId, nodePrivateKey);
  const run = await waitForRun(reconnected, 0);
  const seed = db.prepare("SELECT delivery_id FROM owner_agent_runs WHERE id=?").get(run.runId) as {
    delivery_id: string;
  };
  expect(seed.delivery_id).toBe(pending[0]?.id);
  await app.nodes.receive(
    reconnected,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: run.runId,
      runId: run.runId,
      agentId,
      ok: true,
    }),
  );
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toHaveLength(0);
  app.chat.syncHandledReminders();
  expect(app.chat.listAgentReminders(agentId)[0]).toMatchObject({
    id: reminderId,
    firing: { handledAt: expect.any(Number) },
  });
});

it("does not consume an older archived ordinary message if a reminder run is unarchived before completion", async () => {
  const fixture = await setup();
  const { app, cookie, nodeId, socket, nodePrivateKey } = fixture;
  const { agentId, dm } = await startReminderFixture(fixture);
  app.nodes.close(socket);
  const ordinary = app.chat.createMessage(dm.id, "Still unread after reminder")!;
  await app.request(`/api/owner/channels/${dm.id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });
  await new Promise((resolve) => setTimeout(resolve, 280));
  app.chat.fireDueReminders();
  const reconnected = await reconnectNode(app, nodeId, nodePrivateKey);
  const run = await waitForRun(reconnected, 0);
  const context = await callAgentRunContext(app, reconnected, run);
  expect(
    context.messages.filter((message) => message.currentRunInput).map((message) => message.text),
  ).toEqual(["提醒：Check deployment"]);
  await app.request(`/api/owner/channels/${dm.id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ archived: false }),
  });
  await app.nodes.receive(
    reconnected,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: run.runId,
      runId: run.runId,
      agentId,
      ok: true,
    }),
  );
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toMatchObject([
    { messageId: ordinary.id },
  ]);
});

it("keeps one logical session across a DM, a channel and a thread and reaches its task, reminder and memory after restart and compaction", async () => {
  const fixture = await setup();
  const { app, cookie, nodeId, socket, nodePrivateKey } = fixture;
  const directory = fixtures.at(-1)!.directory;
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "持续工作伙伴",
    role: "Continues its own unfinished work",
    description: "Synthetic continuity fixture.",
    model: { provider: "openai", id: "gpt-4o-mini" },
  });
  app.agents.complete(
    agentId,
    {
      username: "mate_" + agentId.replaceAll("-", "").slice(0, 27),
      uid: 23001,
      gid: 23001,
      home: `/var/lib/mate/agents/${agentId}`,
      homeMarker: "a".repeat(64),
    },
    app.chat,
  );
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-key-continuity-setup" }),
  });

  // The Agent's own home is ordinary storage, so its memory outlives the control-plane process.
  const agentHome = join(directory, "agent-home", agentId);
  mkdirSync(agentHome, { recursive: true });
  const serveWorkspace = (
    target: ReturnType<typeof createControlPlaneApp>,
    targetSocket: FakeNodeSocket,
  ) => {
    targetSocket.onWorkspaceOperation = async (request) => {
      const operation = request.operation as { kind: string; path: string; content?: string },
        file = join(agentHome, operation.path),
        content = operation.content ?? "";
      if (operation.kind === "write") writeFileSync(file, content);
      await target.nodes.receive(
        targetSocket,
        JSON.stringify({
          type: "node.workspace.operation.result",
          requestId: request.requestId,
          operationId: request.operationId,
          agentId,
          ok: true,
          result:
            operation.kind === "write"
              ? {
                  code: 0,
                  stdout: JSON.stringify({
                    sha256: createHash("sha256").update(content).digest("hex"),
                  }),
                  stderr: "",
                  truncated: false,
                }
              : existsSync(file)
                ? { code: 0, stdout: readFileSync(file, "utf8"), stderr: "", truncated: false }
                : { code: 2, stdout: "", stderr: "not_found", truncated: false },
        }),
      );
    };
  };
  serveWorkspace(app, socket);

  // While handling its first input the Agent claims the work, leaves itself a reminder and writes
  // the memory it will need later. It publishes nothing, which is still a successful run.
  const anchor = app.chat.createMessage(direct.id, "请接手这项工作。")!;
  const firstRun = await waitForRun(socket, 0);
  const claim = await callAgentTool(app, socket, firstRun, "continuity-claim", "tools.call", {
    name: "tasks.claim_message",
    input: { messageId: anchor.id },
  });
  expect(claim.ok).toBe(true);
  const claimedTask = (claim.result as { outcome: string; task: { id: string } }).task;
  expect((claim.result as { outcome: string }).outcome).toBe("claimed");
  const createdReminder = await callAgentTool(
    app,
    socket,
    firstRun,
    "continuity-reminder",
    "tools.call",
    {
      name: "reminders.create",
      input: { conversationId: direct.id, text: "检查部署日志。", dueAt: Date.now() + 3_600_000 },
    },
  );
  expect(createdReminder).toMatchObject({ ok: true });
  const memory = { name: "workspace.write", input: { path: "plan.md", content: "部署检查清单" } };
  const written = await callAgentTool(
    app,
    socket,
    firstRun,
    stableToolActionId(firstRun.actionScopeId, memory),
    "tools.call",
    memory,
  );
  expect(written).toMatchObject({ ok: true });
  expect(readFileSync(join(agentHome, "plan.md"), "utf8")).toBe("部署检查清单");
  await finishRun(app, socket, firstRun);
  expect(
    app.chat
      .listMessages(direct.id, undefined, 100)!
      .messages.filter((message) => message.author.kind === "agent"),
  ).toHaveLength(0);

  // There is no owner-facing view of the logical session, so read it with a brand-new connection:
  // this is the durable fact that compaction must replace the model session without duplicating.
  const readLogicalSession = () => {
    const reader = new Database(join(directory, "control-plane", "control-plane.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      return reader
        .prepare("SELECT id,model_session_id FROM owner_agent_sessions WHERE agent_id=?")
        .all(agentId) as Array<{ id: string; model_session_id: string | null }>;
    } finally {
      reader.close();
    }
  };
  const sessionBeforeRestart = readLogicalSession();
  expect(sessionBeforeRestart).toHaveLength(1);
  const logicalSessionId = sessionBeforeRestart[0]!.id;

  // The whole service stops: every timer and database handle of the old process goes away.
  app.close();
  const restarted = createControlPlaneApp({
    dataDir: join(directory, "control-plane"),
    passwordFile: join(directory, "owner-password"),
  });
  try {
    const recovered = await reconnectNode(restarted, nodeId, nodePrivateKey);
    serveWorkspace(restarted, recovered);
    await restarted.request("/api/owner/model-credentials/openai", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "synthetic-key-continuity-plan" }),
    });

    // A different conversation after the restart continues the same logical session, and the task
    // and reminder entry points still answer.
    const channel = restarted.chat.createChannel({
      name: "持续工作频道",
      description: "Synthetic continuity fixture.",
      visibility: "private",
    });
    expect(restarted.chat.inviteAgentToChannel(channel.id, agentId)).toBe(true);
    const restartStart = recovered.sent.length;
    const channelRoot = restarted.chat.createMessage(channel.id, "重启后的本次输入。")!;
    const secondRun = await waitForRun(recovered, restartStart);
    expect(secondRun.sessionId).toBe(logicalSessionId);
    const listedReminders = await callAgentTool(
      restarted,
      recovered,
      secondRun,
      "restart-reminders",
      "tools.call",
      { name: "reminders.list", input: {} },
    );
    expect(
      (listedReminders.result as { reminders: Array<{ text: string }> }).reminders.map(
        (reminder) => reminder.text,
      ),
    ).toContain("检查部署日志。");
    const listedTasks = await callAgentTool(
      restarted,
      recovered,
      secondRun,
      "restart-tasks",
      "tools.call",
      { name: "tasks.list", input: {} },
    );
    expect((listedTasks.result as { tasks: unknown[] }).tasks).toMatchObject([
      { id: claimedTask.id, status: "in_progress", ownerAgentId: agentId },
    ]);
    const discovered = await callAgentTool(
      restarted,
      recovered,
      secondRun,
      "restart-tools",
      "tools.list",
      {},
    );
    expect(discovered).toMatchObject({
      ok: true,
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "tasks.list" }),
          expect.objectContaining({ name: "reminders.list" }),
          expect.objectContaining({ name: "workspace.list" }),
          expect.objectContaining({ name: "workspace.read" }),
        ]),
      },
    });

    // Compaction replaces the model session for later runs without creating a second one.
    const compaction = {
      name: "session.compact",
      input: { summary: "重启前的上下文已摘要。", snapshot: { work: "继续未完成任务" } },
    };
    const compacted = await callAgentTool(
      restarted,
      recovered,
      secondRun,
      stableToolActionId(secondRun.actionScopeId, compaction),
      "tools.call",
      compaction,
    );
    expect(compacted).toMatchObject({ ok: true, result: { effective: "next_run" } });
    const replacementSessionId = (compacted.result as { sessionId: string }).sessionId;
    expect(replacementSessionId).not.toBe(logicalSessionId);
    // A thread reply on that channel message is the next queued input.
    const reply = restarted.chat.createMessage(channel.id, "讨论串中的本次输入。", {
      rootId: channelRoot.id,
    })!;
    const replyStart = recovered.sent.length;
    await finishRun(restarted, recovered, secondRun);
    expect(readLogicalSession()).toEqual([
      { id: logicalSessionId, model_session_id: replacementSessionId },
    ]);

    // The thread reply starts the next run in the replacement model session, and the scripted Agent
    // chooses reminders first, then its own memory, then the current input, then the task it still
    // owns, and finishes without a private plain turn.
    const thirdRun = await waitForRun(recovered, replyStart);
    expect(thirdRun.sessionId).toBe(replacementSessionId);
    expect(
      restarted.chat
        .listMessages(channel.id, undefined, 100)!
        .messages.find((message) => message.id === channelRoot.id),
    ).toMatchObject({ replyCount: 1, recentReplies: [{ id: reply.id, rootId: channelRoot.id }] });
    // The thread reply, not the channel's root message, is this run's current input.
    expect(
      (await callAgentRunContext(restarted, recovered, thirdRun)).messages
        .filter((message) => message.currentRunInput)
        .map((message) => message.text),
    ).toEqual(["讨论串中的本次输入。"]);
    const scripted = async (
      run: Extract<NodeControlMessage, { type: "control.agent.run" }>,
    ): Promise<{ results: Array<{ ok: boolean; code?: string }>; transcripts: string[] }> => {
      const resultAcks: Promise<void>[] = [],
        results: Array<{ ok: boolean; code?: string }> = [],
        transcripts: string[] = [],
        controller = new AbortController();
      await runAgentModel(
        run,
        {
          context: async () => {
            const page = await callAgentRunContext(restarted, recovered, run);
            return { messages: page.messages, nextCursor: page.nextCursor };
          },
          transcript: async (text) => {
            transcripts.push(text);
            await restarted.nodes.receive(
              recovered,
              JSON.stringify({
                type: "node.agent.run.transcript",
                requestId: randomUUID(),
                runId: run.runId,
                agentId,
                text,
              }),
            );
            return (JSON.parse(recovered.sent.at(-1)!) as { accepted?: boolean }).accepted === true;
          },
          tool: async (toolCallId, operation, input) => {
            const reply = await callAgentTool(
              restarted,
              recovered,
              run,
              toolCallId,
              operation,
              input,
            );
            return reply.ok
              ? { ok: true as const, result: reply.result }
              : { ok: false as const, error: reply.error ?? "Agent tool request was refused" };
          },
          result: (ok, code) => {
            results.push({ ok, ...(code ? { code } : {}) });
            resultAcks.push(
              restarted.nodes.receive(
                recovered,
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
        },
        controller.signal,
        { modelWorkerEntry: resolve("tests/fixtures/direct-message-model-worker.mjs") },
      );
      await Promise.all(resultAcks);
      return { results, transcripts };
    };
    const { results, transcripts } = await scripted(thirdRun);
    expect(results).toEqual([{ ok: true }]);
    expect(transcripts).toEqual([]);
    expect(
      restarted.chat
        .listMessages(channel.id, undefined, 100)!
        .messages.filter((message) => message.author.kind === "agent")
        .map((message) => message.text),
    ).toEqual(["先看提醒：检查部署日志。 记忆：部署检查清单"]);
    const ownerTasks = await restarted.request("/api/owner/tasks", { headers: { cookie } });
    expect(ownerTasks.status).toBe(200);
    expect(
      (
        (await ownerTasks.json()) as {
          tasks: Array<{ id: string; status: string; ownerAgentId: string | null }>;
        }
      ).tasks
        .filter((task) => task.id === claimedTask.id)
        .map(({ id, status, ownerAgentId }) => ({ id, status, ownerAgentId })),
    ).toEqual([{ id: claimedTask.id, status: "done", ownerAgentId: agentId }]);
    expect(readLogicalSession()).toEqual([
      { id: logicalSessionId, model_session_id: replacementSessionId },
    ]);
  } finally {
    restarted.close();
  }
});
