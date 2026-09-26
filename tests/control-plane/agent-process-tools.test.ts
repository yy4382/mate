import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/control-plane/http.js";
import { deriveAgentProcessOperationId } from "../../src/control-plane/agent-process-operations.js";
import type { NodeSocket } from "../../src/control-plane/nodes/directory.js";
import type { NodeControlMessage } from "../../src/nodes/protocol.js";

const password = "agent-process-tool-test-owner-password";
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
  onSend?: (message: Record<string, unknown>) => void;
  send(data: string) {
    this.sent.push(data);
    this.onSend?.(JSON.parse(data) as Record<string, unknown>);
  }
  close() {}
  terminate() {}
}

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-process-tool-"));
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
  const tokenResponse = await app.request("/api/owner/nodes/pairing-tokens", {
    method: "POST",
    headers: { cookie },
  });
  const pairingToken = ((await tokenResponse.json()) as { pairingToken: string }).pairingToken;
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
  return { app, cookie, db, nodeId, socket, keyPair };
}

async function waitForRun(
  socket: FakeNodeSocket,
  startAt: number,
): Promise<Extract<NodeControlMessage, { type: "control.agent.run" }>> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const message = socket.sent
      .slice(startAt)
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find((candidate) => candidate.type === "control.agent.run");
    if (message)
      return message as unknown as Extract<NodeControlMessage, { type: "control.agent.run" }>;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The Agent process tool test did not start a run");
}

async function sendTool(
  app: ReturnType<typeof createControlPlaneApp>,
  socket: FakeNodeSocket,
  run: { runId: string; agentId: string },
  toolCallId: string,
  operation: string,
  input: Record<string, unknown>,
): Promise<void> {
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.tool",
      requestId: randomUUID(),
      runId: run.runId,
      agentId: run.agentId,
      toolCallId,
      operation,
      input,
    }),
  );
}

it("marks a committed process intent unknown before a recovered node can start another run", async () => {
  const { app, cookie, db, nodeId, socket, keyPair } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Missing receipt",
    role: "Process recovery",
    description: "Committed intent without dispatch",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: `mate_${agentId.replaceAll("-", "").slice(0, 27)}`,
      uid: 23003,
      gid: 23003,
      home: `/var/lib/mate/agents/${agentId}`,
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
  app.chat.createMessage(direct.id, "Run a command once.");
  const run = await waitForRun(socket, start);
  const actionId = `mate:${run.actionScopeId}:${"f".repeat(64)}:1`,
    operationId = deriveAgentProcessOperationId(agentId, actionId),
    at = Date.now();
  db.prepare(
    `INSERT INTO owner_agent_process_operations(
    operation_id,run_id,agent_id,node_id,action_scope_id,stable_action_id,
    request_hash,request_json,state,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,'executing',?,?)`,
  ).run(
    operationId,
    run.runId,
    agentId,
    nodeId,
    run.actionScopeId,
    actionId,
    "f".repeat(64),
    JSON.stringify({ operation: { kind: "exec", command: "true" } }),
    at,
    at,
  );
  app.runs?.close(); // The original control-plane process crashed before dispatch.
  const directory = fixtures.at(-1)!.directory;
  const restarted = createControlPlaneApp({
    dataDir: join(directory, "control-plane"),
    passwordFile: join(directory, "owner-password"),
  });
  try {
    const recovered = new FakeNodeSocket();
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
    const reconcile = recovered.sent
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find((message) => message.type === "control.process.reconcile")!;
    expect(reconcile).toMatchObject({ operations: [{ operationId, agentId }] });
    expect(recovered.sent.some((text) => text.includes('"type":"control.agent.run"'))).toBe(false);
    await restarted.nodes.receive(
      recovered,
      JSON.stringify({
        type: "node.process.reconcile.result",
        requestId: reconcile.requestId,
        receipts: [],
      }),
    );
    expect(
      db
        .prepare("SELECT state FROM owner_agent_process_operations WHERE operation_id=?")
        .get(operationId),
    ).toEqual({ state: "unknown" });
    expect(
      db
        .prepare("SELECT text FROM owner_agent_session_journal WHERE process_operation_id=?")
        .get(operationId),
    ).toMatchObject({ text: expect.stringContaining("unknown") });
    expect(db.prepare("SELECT error_code FROM owner_agent_runs WHERE id=?").get(run.runId)).toEqual(
      { error_code: "interrupted" },
    );
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM owner_agent_activity WHERE kind='run.interrupted' AND reference_id=?",
        )
        .get(run.runId),
    ).toEqual({ count: 1 });
    const next = await waitForRun(recovered, 0);
    expect(next.runId).not.toBe(run.runId);
  } finally {
    restarted.close();
  }
});

it("projects the last committed snapshot when two compactions share one clock tick", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Snapshot order",
    role: "Context",
    description: "Equal timestamp fixture",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: `mate_${agentId.replaceAll("-", "").slice(0, 27)}`,
      uid: 23003,
      gid: 23003,
      home: `/var/lib/mate/agents/${agentId}`,
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
  app.chat.createMessage(direct.id, "Current input.");
  const run = await waitForRun(socket, start);
  const insert = db.prepare(`INSERT INTO owner_agent_session_snapshots(
    id,agent_id,action_id,request_hash,through_seq,model_session_id,summary,snapshot_json,created_at
  ) VALUES(?,?,?,?,0,?,?,'{}',1234)`);
  insert.run(
    "ffffffff-ffff-4fff-8fff-ffffffffffff",
    agentId,
    "old",
    "a".repeat(64),
    randomUUID(),
    "Older summary",
  );
  insert.run(
    "00000000-0000-4000-8000-000000000000",
    agentId,
    "new",
    "b".repeat(64),
    randomUUID(),
    "Newer summary",
  );
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.context",
      requestId: randomUUID(),
      runId: run.runId,
      agentId,
      cursor: 0,
      limit: 100,
    }),
  );
  const context = JSON.parse(socket.sent.at(-1)!) as { messages: Array<{ text: string }> };
  expect(context.messages.some((message) => message.text.includes("Newer summary"))).toBe(true);
  expect(context.messages.some((message) => message.text.includes("Older summary"))).toBe(false);
});

it("dispatches ordinary commands from a durable intent without privileged approval", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Process operator",
    role: "Runs ordinary commands",
    description: "Synthetic process tool fixture.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: `mate_${agentId.replaceAll("-", "").slice(0, 27)}`,
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
    body: JSON.stringify({ apiKey: "synthetic-process-tool-key" }),
  });
  const startAt = socket.sent.length;
  app.chat.createMessage(direct.id, "Use the ordinary process tools.");
  const run = await waitForRun(socket, startAt);

  await sendTool(app, socket, run, "list-process-tools", "tools.list", {});
  const listed = JSON.parse(socket.sent.at(-1)!) as {
    result?: { tools?: Array<{ name: string }> };
  };
  expect(listed.result?.tools?.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["process.exec", "process.list", "process.inspect", "process.stop"]),
  );
  await sendTool(app, socket, run, "describe-process-exec", "tools.describe", {
    name: "process.exec",
  });
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    ok: true,
    result: {
      name: "process.exec",
      inputSchema: { properties: { command: { type: "string" } } },
    },
  });

  const scope = run.actionScopeId,
    toolCallId = `mate:${scope}:${"a".repeat(64)}:1`;
  let intentWasCommittedBeforeDispatch = false;
  socket.onSend = (message) => {
    if (message.type !== "control.process.operation") return;
    intentWasCommittedBeforeDispatch = Boolean(
      db
        .prepare(
          `SELECT 1 FROM owner_agent_process_operations
           WHERE operation_id=? AND agent_id=? AND state='executing'`,
        )
        .get(message.operationId, agentId),
    );
  };
  const toolResultPromise = sendTool(app, socket, run, toolCallId, "tools.call", {
    name: "process.exec",
    input: { command: "printf command-ran" },
  });
  const deadline = Date.now() + 4000;
  let processRequest: Record<string, unknown> | undefined;
  while (Date.now() < deadline && !processRequest) {
    processRequest = socket.sent
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find((message) => message.type === "control.process.operation");
    if (!processRequest) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(processRequest).toMatchObject({
    type: "control.process.operation",
    agentId,
    operation: { kind: "exec", command: "printf command-ran", cwd: "." },
  });
  expect(intentWasCommittedBeforeDispatch).toBe(true);
  expect(
    db
      .prepare("SELECT state FROM owner_agent_process_operations WHERE operation_id=?")
      .get(processRequest!.operationId),
  ).toEqual({ state: "executing" });

  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.process.operation.result",
      requestId: processRequest!.requestId,
      operationId: processRequest!.operationId,
      agentId,
      state: "succeeded",
      receipt: { code: 0, stdout: "command-ran", stderr: "", truncated: false },
    }),
  );
  await toolResultPromise;
  const reply = JSON.parse(socket.sent.at(-1)!) as {
    type: string;
    ok: boolean;
    result?: { operationId: string; state: string; receipt: { stdout: string } };
  };
  expect(reply).toMatchObject({
    type: "control.agent.run.tool_result",
    ok: true,
    result: {
      operationId: processRequest!.operationId,
      state: "succeeded",
      receipt: { stdout: "command-ran" },
    },
  });
  expect(
    db
      .prepare("SELECT state FROM owner_agent_process_operations WHERE operation_id=?")
      .get(processRequest!.operationId),
  ).toEqual({ state: "succeeded" });
  expect(socket.sent.some((text) => text.includes("approval"))).toBe(false);
});

it("reconciles a durable node receipt before resuming a disconnected Agent", async () => {
  const { app, cookie, db, nodeId, socket, keyPair } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Recovering Agent",
    role: "Runs commands",
    description: "Synthetic recovery fixture.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: `mate_${agentId.replaceAll("-", "").slice(0, 27)}`,
      uid: 23002,
      gid: 23002,
      home: `/var/lib/mate/agents/${agentId}`,
    },
    app.chat,
  );
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-recovery-key" }),
  });
  const start = socket.sent.length;
  app.chat.createMessage(direct.id, "Run one command.");
  const oldRun = await waitForRun(socket, start);
  const toolCallId = `mate:${oldRun.actionScopeId}:${"b".repeat(64)}:1`;
  const pendingTool = sendTool(app, socket, oldRun, toolCallId, "tools.call", {
    name: "process.exec",
    input: { command: "printf once" },
  });
  let operation: Record<string, unknown> | undefined;
  const deadline = Date.now() + 3000;
  while (!operation && Date.now() < deadline) {
    operation = socket.sent
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find((message) => message.type === "control.process.operation");
    if (!operation) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(operation).toBeDefined();
  app.nodes.close(socket);
  await pendingTool;
  expect(
    db
      .prepare("SELECT state FROM owner_agent_process_operations WHERE operation_id=?")
      .get(operation!.operationId),
  ).toEqual({ state: "unknown" });
  expect(
    db.prepare("SELECT error_code FROM owner_agent_runs WHERE id=?").get(oldRun.runId),
  ).toEqual({ error_code: "interrupted" });
  expect(
    db.prepare("SELECT state FROM owner_message_deliveries WHERE id=?").get(oldRun.actionScopeId),
  ).toEqual({ state: "pending" });

  const reconnect = new FakeNodeSocket();
  app.nodes.open(reconnect);
  const challenge = JSON.parse(reconnect.sent[0]!) as { nonce: string };
  await app.nodes.receive(
    reconnect,
    JSON.stringify({
      type: "node.authenticate",
      requestId: randomUUID(),
      nodeId,
      signature: sign(null, Buffer.from(challenge.nonce), keyPair.privateKey).toString("base64url"),
    }),
  );
  const reconcile = reconnect.sent
    .map((text) => JSON.parse(text) as Record<string, unknown>)
    .find((message) => message.type === "control.process.reconcile")!;
  expect(reconcile.operations).toEqual([{ operationId: operation!.operationId, agentId }]);
  expect(reconnect.sent.some((text) => text.includes('control.agent.run"'))).toBe(false);
  await app.nodes.receive(
    reconnect,
    JSON.stringify({
      type: "node.process.reconcile.result",
      requestId: reconcile.requestId,
      receipts: [
        { operationId: operation!.operationId, agentId, state: "succeeded", receipt: { code: 0 } },
      ],
    }),
  );
  expect(
    db
      .prepare("SELECT state FROM owner_agent_process_operations WHERE operation_id=?")
      .get(operation!.operationId),
  ).toEqual({ state: "succeeded" });
  const next = await waitForRun(reconnect, 0);
  expect(next.runId).not.toBe(oldRun.runId);
  await app.nodes.receive(
    reconnect,
    JSON.stringify({
      type: "node.agent.run.context",
      requestId: randomUUID(),
      runId: next.runId,
      agentId,
      cursor: 0,
      limit: 100,
    }),
  );
  const context = JSON.parse(reconnect.sent.at(-1)!) as { messages: Array<{ text: string }> };
  expect(
    context.messages.some(
      (message) =>
        message.text.includes(String(operation!.operationId)) &&
        message.text.includes('"state":"succeeded"'),
    ),
  ).toBe(true);
  await app.nodes.receive(
    reconnect,
    JSON.stringify({
      type: "node.agent.run.journal",
      requestId: randomUUID(),
      runId: oldRun.runId,
      agentId,
      text: "stale reply",
    }),
  );
  expect(JSON.parse(reconnect.sent.at(-1)!)).toMatchObject({
    type: "control.agent.run.journal_ack",
    accepted: false,
  });
  await app.nodes.receive(
    reconnect,
    JSON.stringify({
      type: "node.agent.run.tool",
      requestId: randomUUID(),
      runId: oldRun.runId,
      agentId,
      toolCallId: "stale",
      operation: "tools.list",
      input: {},
    }),
  );
  expect(JSON.parse(reconnect.sent.at(-1)!)).toMatchObject({
    type: "control.agent.run.tool_result",
    ok: false,
  });
  const safeResponse = await app.request(`/api/owner/agents/${agentId}/activity`, {
    headers: { cookie },
  });
  expect(safeResponse.status).toBe(200);
  const safe = (await safeResponse.json()) as {
    events: Array<{ kind: string; summary: string; detail?: unknown }>;
  };
  expect(safe.events.some((event) => event.kind === "receipt.corrected")).toBe(true);
  expect(safe.events.every((event) => event.detail === undefined)).toBe(true);
  expect(JSON.stringify(safe)).not.toContain("printf once");
  const expandedResponse = await app.request(`/api/owner/agents/${agentId}/activity?detail=1`, {
    headers: { cookie },
  });
  const expanded = (await expandedResponse.json()) as { events: Array<{ detail?: unknown }> };
  expect(JSON.stringify(expanded)).toContain("printf once");
  const notification = db
    .prepare(
      `SELECT m.text,m.author_id,d.state FROM owner_messages m
     JOIN owner_message_deliveries d ON d.message_id=m.id AND d.recipient_id=?
     WHERE m.author_id='mate-system' ORDER BY m.created_at DESC LIMIT 1`,
    )
    .get(agentId) as { text: string; author_id: string; state: string };
  expect(notification).toMatchObject({ author_id: "mate-system", state: "pending" });
  expect(notification.text).toContain(String(operation!.operationId));

  const secondAction = `mate:${next.actionScopeId}:${"c".repeat(64)}:1`;
  const secondPending = sendTool(app, reconnect, next, secondAction, "tools.call", {
    name: "process.exec",
    input: { command: "printf uncertain" },
  });
  let secondOperation: Record<string, unknown> | undefined;
  const secondDeadline = Date.now() + 3000;
  while (!secondOperation && Date.now() < secondDeadline) {
    secondOperation = reconnect.sent
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find(
        (message) =>
          message.type === "control.process.operation" &&
          message.operationId !== operation!.operationId,
      );
    if (!secondOperation) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(secondOperation).toBeDefined();
  app.nodes.close(reconnect);
  await secondPending;
  const again = new FakeNodeSocket();
  app.nodes.open(again);
  const secondChallenge = JSON.parse(again.sent[0]!) as { nonce: string };
  await app.nodes.receive(
    again,
    JSON.stringify({
      type: "node.authenticate",
      requestId: randomUUID(),
      nodeId,
      signature: sign(null, Buffer.from(secondChallenge.nonce), keyPair.privateKey).toString(
        "base64url",
      ),
    }),
  );
  const secondSync = again.sent
    .map((text) => JSON.parse(text) as Record<string, unknown>)
    .find((message) => message.type === "control.process.reconcile")!;
  expect(secondSync.operations).toEqual([{ operationId: secondOperation!.operationId, agentId }]);
  await app.nodes.receive(
    again,
    JSON.stringify({
      type: "node.process.reconcile.result",
      requestId: secondSync.requestId,
      receipts: [],
    }),
  );
  expect(
    db
      .prepare("SELECT state FROM owner_agent_process_operations WHERE operation_id=?")
      .get(secondOperation!.operationId),
  ).toEqual({ state: "unknown" });
  await waitForRun(again, 0); // No proof delays neither this Agent nor other online Agents.
  await app.nodes.receive(
    again,
    JSON.stringify({
      type: "node.process.operation.result",
      requestId: secondOperation!.requestId,
      operationId: secondOperation!.operationId,
      agentId,
      state: "succeeded",
      receipt: { code: 0 },
    }),
  );
  expect(
    db
      .prepare("SELECT state FROM owner_agent_process_operations WHERE operation_id=?")
      .get(secondOperation!.operationId),
  ).toEqual({ state: "succeeded" });
});

it("commits a compaction snapshot and replacement session before ACK and recovers it after disconnect", async () => {
  const { app, cookie, db, nodeId, socket, keyPair } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Compacting Agent",
    role: "Keeps context",
    description: "Synthetic compaction fixture.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: `mate_${agentId.replaceAll("-", "").slice(0, 27)}`,
      uid: 23003,
      gid: 23003,
      home: `/var/lib/mate/agents/${agentId}`,
    },
    app.chat,
  );
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-compaction-key" }),
  });
  let start = socket.sent.length;
  app.chat.createMessage(direct.id, "Earlier handled context.");
  const first = await waitForRun(socket, start);
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: randomUUID(),
      runId: first.runId,
      agentId,
      ok: true,
    }),
  );
  app.runs?.pauseAgent(agentId);
  const otherRoom = app.chat.createChannel({
    name: "Later source",
    description: "Delayed delivery",
    visibility: "public",
  });
  expect(app.chat.inviteAgentToChannel(otherRoom.id, agentId)).toBe(true);
  start = socket.sent.length;
  app.chat.createMessage(direct.id, "Current pending input.");
  app.chat.createMessage(otherRoom.id, "Later source must survive compaction.");
  app.runs?.resumeAgent(agentId);
  const second = await waitForRun(socket, start);
  const actionId = `mate:${second.actionScopeId}:${"d".repeat(64)}:1`;
  const input = {
    name: "session.compact",
    input: { summary: "Earlier context summarized safely.", snapshot: { work: "keep this fact" } },
  };
  await sendTool(app, socket, second, actionId, "tools.call", input);
  const ack = JSON.parse(socket.sent.at(-1)!) as {
    ok: boolean;
    result: { sessionId: string; effective: string };
  };
  expect(ack).toMatchObject({ ok: true, result: { effective: "next_run" } });
  expect(
    db
      .prepare("SELECT COUNT(*) AS count FROM owner_agent_session_snapshots WHERE agent_id=?")
      .get(agentId),
  ).toEqual({ count: 1 });
  // The response is deliberately ignored as if its ACK were lost. A replay is idempotent.
  await sendTool(app, socket, second, actionId, "tools.call", input);
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    ok: true,
    result: { sessionId: ack.result.sessionId },
  });
  expect(
    db
      .prepare("SELECT COUNT(*) AS count FROM owner_agent_session_snapshots WHERE agent_id=?")
      .get(agentId),
  ).toEqual({ count: 1 });
  app.nodes.close(socket);
  const reconnect = new FakeNodeSocket();
  app.nodes.open(reconnect);
  const challenge = JSON.parse(reconnect.sent[0]!) as { nonce: string };
  await app.nodes.receive(
    reconnect,
    JSON.stringify({
      type: "node.authenticate",
      requestId: randomUUID(),
      nodeId,
      signature: sign(null, Buffer.from(challenge.nonce), keyPair.privateKey).toString("base64url"),
    }),
  );
  const resumed = await waitForRun(reconnect, 0);
  expect(resumed.sessionId).toBe(ack.result.sessionId);
  await app.nodes.receive(
    reconnect,
    JSON.stringify({
      type: "node.agent.run.context",
      requestId: randomUUID(),
      runId: resumed.runId,
      agentId,
      cursor: 0,
      limit: 100,
    }),
  );
  const page = JSON.parse(reconnect.sent.at(-1)!) as { messages: Array<{ text: string }> };
  expect(
    page.messages.some(
      (message) =>
        message.text.includes("Mate 会话摘要：Earlier context summarized safely.") &&
        message.text.includes('"work":"keep this fact"'),
    ),
  ).toBe(true);
  expect(page.messages.map((message) => message.text)).toContain("Current pending input.");
  expect(page.messages.map((message) => message.text)).not.toContain("Earlier handled context.");
  const afterCurrentStart = reconnect.sent.length;
  await app.nodes.receive(
    reconnect,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: randomUUID(),
      runId: resumed.runId,
      agentId,
      ok: true,
    }),
  );
  const later = await waitForRun(reconnect, afterCurrentStart);
  expect(later.channelId).toBe(otherRoom.id);
  const afterLaterStart = reconnect.sent.length;
  await app.nodes.receive(
    reconnect,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: randomUUID(),
      runId: later.runId,
      agentId,
      ok: true,
    }),
  );
  app.chat.createMessage(direct.id, "Check later source history.");
  const finalRun = await waitForRun(reconnect, afterLaterStart);
  await app.nodes.receive(
    reconnect,
    JSON.stringify({
      type: "node.agent.run.context",
      requestId: randomUUID(),
      runId: finalRun.runId,
      agentId,
      cursor: 0,
      limit: 100,
    }),
  );
  const finalContext = JSON.parse(reconnect.sent.at(-1)!) as { messages: Array<{ text: string }> };
  expect(finalContext.messages.map((message) => message.text)).toContain(
    "Later source must survive compaction.",
  );
});

it("pauses for credential failures and owner choice while transient model failures back off", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Pause Agent",
    role: "Tests retry state",
    description: "Synthetic model failure fixture.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: `mate_${agentId.replaceAll("-", "").slice(0, 27)}`,
      uid: 23004,
      gid: 23004,
      home: `/var/lib/mate/agents/${agentId}`,
    },
    app.chat,
  );
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-key-a" }),
  });
  const start = socket.sent.length;
  app.chat.createMessage(direct.id, "Pending while credentials fail.");
  const run = await waitForRun(socket, start);
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: randomUUID(),
      runId: run.runId,
      agentId,
      ok: false,
      code: "credentials_invalid",
    }),
  );
  expect(app.runs?.pauseReason(agentId)).toBe("credentials");
  expect(
    db.prepare("SELECT state FROM owner_message_deliveries WHERE id=?").get(run.actionScopeId),
  ).toEqual({ state: "pending" });
  const credentialActivity = await app.request(`/api/owner/agents/${agentId}/activity`, {
    headers: { cookie },
  });
  expect(((await credentialActivity.json()) as { pausedReason: string }).pausedReason).toBe(
    "credentials",
  );
  const pausedCount = socket.sent.filter((text) =>
    text.includes('"type":"control.agent.run"'),
  ).length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(socket.sent.filter((text) => text.includes('"type":"control.agent.run"'))).toHaveLength(
    pausedCount,
  );
  const retryStart = socket.sent.length;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-key-b" }),
  });
  const retry = await waitForRun(socket, retryStart);
  expect(retry.runId).not.toBe(run.runId);
  const pause = await app.request(`/api/owner/agents/${agentId}/pause`, {
    method: "POST",
    headers: { cookie },
  });
  expect(pause.status).toBe(200);
  expect(app.runs?.pauseReason(agentId)).toBe("manual");
  expect(db.prepare("SELECT error_code FROM owner_agent_runs WHERE id=?").get(retry.runId)).toEqual(
    { error_code: "manual_pause" },
  );
  const resumedStart = socket.sent.length;
  const resume = await app.request(`/api/owner/agents/${agentId}/resume`, {
    method: "POST",
    headers: { cookie },
  });
  expect(resume.status).toBe(200);
  const third = await waitForRun(socket, resumedStart);
  expect(third.runId).not.toBe(retry.runId);
  const before = Date.now();
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: randomUUID(),
      runId: third.runId,
      agentId,
      ok: false,
      code: "model_failed",
    }),
  );
  const failed = db
    .prepare("SELECT error_code,retry_at FROM owner_agent_runs WHERE id=?")
    .get(third.runId) as { error_code: string; retry_at: number };
  expect(failed.error_code).toBe("model_failed");
  expect(failed.retry_at).toBeGreaterThanOrEqual(before + 1000);
  expect(app.runs?.pauseReason(agentId)).toBeNull();
});
