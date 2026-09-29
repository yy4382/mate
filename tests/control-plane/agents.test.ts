import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/control-plane/http.js";
import { OwnerAuth } from "../../src/control-plane/owner-auth.js";
import { nodeDirectorySchema } from "../../src/control-plane/nodes/schema.js";
import { newAgentRequestSchema } from "../../src/control-plane/agents/contracts.js";
import { AgentDirectory, AgentRequestConflict } from "../../src/control-plane/agents/directory.js";
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

/** A second connection to the fixture's own database, for asserting stored rows directly. */
function databaseFor(app: ReturnType<typeof createControlPlaneApp>): Database.Database {
  const fixture = fixtures.find((entry) => entry.app === app);
  if (!fixture) throw new Error("The fixture was already cleaned up");
  return new Database(join(fixture.directory, "control-plane", "control-plane.sqlite"));
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

it("edits each profile field without changing an Agent's identity or session", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId } = await pairNode(app, cookie);
  const id = randomUUID();
  const input = {
    id,
    nodeId,
    name: "Original",
    role: "Researcher",
    description: "First description",
    model: { provider: "openai", id: "gpt-4.1" },
  };
  app.agents.prepare(input);
  app.agents.complete(
    id,
    {
      username: `mate_${id.replaceAll("-", "").slice(0, 27)}`,
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${id}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  const before = app.agents.get(id)!;
  for (const patch of [
    { name: "Renamed" },
    { role: "Writer" },
    { description: "New description" },
  ]) {
    const response = await app.request(`/api/owner/agents/${id}/profile`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    expect(response.status).toBe(200);
  }
  expect(app.agents.get(id)).toMatchObject({
    id,
    nodeId,
    name: "Renamed",
    role: "Writer",
    description: "New description",
    sessionId: before.sessionId,
    linuxIdentity: before.linuxIdentity,
  });
});

it("requires an existing provider key before changing the model and preserves the Agent session", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId } = await pairNode(app, cookie);
  const id = randomUUID();
  app.agents.prepare({
    id,
    nodeId,
    name: "Partner",
    role: "Writer",
    description: "",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    id,
    {
      username: `mate_${id.replaceAll("-", "").slice(0, 27)}`,
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${id}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  const sessionId = app.agents.get(id)!.sessionId;
  const change = (model: object) =>
    app.request(`/api/owner/agents/${id}/model`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(model),
    });
  expect((await change({ provider: "openai", id: "gpt-4.1-mini" })).status).toBe(409);
  expect(app.agents.get(id)!.model).toEqual({ provider: "openai", id: "gpt-4.1" });
  const key = await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-key" }),
  });
  expect(key.status).toBe(204);
  expect((await change({ provider: "openai", id: "gpt-4.1-mini" })).status).toBe(200);
  expect(app.agents.get(id)).toMatchObject({
    model: { provider: "openai", id: "gpt-4.1-mini" },
    sessionId,
  });
});

it("keeps manual pause until explicit resume, requires the original workspace, and allows unknown command results", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId, socket } = await pairNode(app, cookie);
  const id = randomUUID();
  app.agents.prepare({
    id,
    nodeId,
    name: "Partner",
    role: "Writer",
    description: "",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  const identity = {
    username: `mate_${id.replaceAll("-", "").slice(0, 27)}`,
    uid: 23001,
    gid: 23001,
    workspace: `/var/lib/mate/agents/${id}`,
    workspaceMarker: "a".repeat(64),
  };
  app.agents.complete(id, identity, app.chat);
  const sessionId = app.agents.get(id)!.sessionId;
  const pause = await app.request(`/api/owner/agents/${id}/pause`, {
    method: "POST",
    headers: { cookie },
  });
  expect(pause.status).toBe(200);
  expect(await pause.json()).toMatchObject({
    pausedReason: "manual",
    stop: { state: "executing" },
  });
  expect(app.runs?.pauseReason(id)).toBe("manual");
  expect(app.agents.get(id)).toMatchObject({
    sessionId,
    linuxIdentity: {
      username: identity.username,
      uid: identity.uid,
      gid: identity.gid,
      workspace: identity.workspace,
    },
  });
  const stopRequest = socket.sent
    .map((text) => JSON.parse(text) as Record<string, unknown>)
    .find(
      (message) =>
        message.type === "control.process.operation" &&
        (message.operation as { kind?: string })?.kind === "process.stop_all",
    )!;
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.process.operation.result",
      requestId: stopRequest.requestId,
      operationId: stopRequest.operationId,
      agentId: id,
      state: "unknown",
      receipt: { reason: "old_command_may_still_run" },
    }),
  );
  for (let attempt = 0; attempt < 30 && app.runs?.stopStatus(id).state !== "unknown"; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const resuming = app.request(`/api/owner/agents/${id}/resume`, {
    method: "POST",
    headers: { cookie },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const verify = socket.sent
    .map((text) => JSON.parse(text) as Record<string, unknown>)
    .find((message) => message.type === "control.agent.provision" && message.verifyOnly)!;
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.provision.result",
      requestId: verify.requestId,
      agentId: id,
      ok: true,
      identity: { ...identity, workspaceMarker: "b".repeat(64) },
    }),
  );
  expect((await resuming).status).toBe(409);
  expect(app.runs?.pauseReason(id)).toBe("manual");
  const repaired = app.request(`/api/owner/agents/${id}/resume`, {
    method: "POST",
    headers: { cookie },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const retry = socket.sent
    .map((text) => JSON.parse(text))
    .filter((message) => message.type === "control.agent.provision")
    .at(-1)!;
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.provision.result",
      requestId: retry.requestId,
      agentId: id,
      ok: true,
      identity,
    }),
  );
  expect((await repaired).status).toBe(200);
  expect(app.runs?.pauseReason(id)).toBeNull();
  expect(app.runs?.stopStatus(id).state).toBe("unknown");
  expect(app.agents.get(id)!.sessionId).toBe(sessionId);
});

it("reports an earlier command whose termination the node cannot confirm as unknown, not stopped", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId, socket } = await pairNode(app, cookie);
  const id = randomUUID();
  app.agents.prepare({
    id,
    nodeId,
    name: "Interrupted command",
    role: "Writer",
    description: "",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    id,
    {
      username: `mate_${id.replaceAll("-", "").slice(0, 27)}`,
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${id}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  // A command really started, and the node then restarted: the node's own restart mute says its
  // shutdown left the command's fate unproven. Only the node's durable receipt can say that.
  const directory = fixtures.at(-1)!.directory,
    db = new Database(join(directory, "control-plane", "control-plane.sqlite")),
    earlierOperationId = randomUUID(),
    runId = randomUUID(),
    at = Date.now();
  try {
    const channel = app.chat.getOrCreateAgentDirectChannel(id)!;
    app.chat.createMessage(channel.id, "先跑一条普通命令。");
    const delivery = db
      .prepare(
        `SELECT id FROM owner_message_deliveries
         WHERE recipient_kind='agent' AND recipient_id=? ORDER BY seq DESC LIMIT 1`,
      )
      .get(id) as { id: string };
    db.prepare(
      `INSERT INTO owner_agent_runs(
         id,agent_id,node_id,delivery_id,state,started_at,input_end_seq,context_history_end_seq
       ) VALUES(?,?,?,?, 'failed',?,1,1)`,
    ).run(runId, id, nodeId, delivery.id, at);
    db.prepare(
      `INSERT INTO owner_agent_process_operations(
        operation_id,run_id,agent_id,node_id,
        request_hash,request_json,state,receipt_json,node_receipt_confirmed,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,'unknown',?,1,?,?)`,
    ).run(
      earlierOperationId,
      runId,
      id,
      nodeId,
      "d".repeat(64),
      JSON.stringify({
        actionScopeId: delivery.id,
        stableActionId: `mate:${delivery.id}:${"d".repeat(64)}:1`,
        nodeId,
        agentId: id,
        operation: { kind: "exec", command: "sleep 300" },
      }),
      JSON.stringify({ reason: "node_restarted_during_operation" }),
      at,
      at,
    );
    expect(
      (await app.request(`/api/owner/agents/${id}/pause`, { method: "POST", headers: { cookie } }))
        .status,
    ).toBe(200);
    const stopRequest = socket.sent
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find(
        (message) =>
          message.type === "control.process.operation" &&
          (message.operation as { kind?: string })?.kind === "process.stop_all",
      )!;
    await app.nodes.receive(
      socket,
      JSON.stringify({
        type: "node.process.operation.result",
        requestId: stopRequest.requestId,
        operationId: stopRequest.operationId,
        agentId: id,
        state: "succeeded",
        receipt: { stopped: true, operationIds: [], scope: "this_node_run" },
      }),
    );
    for (let attempt = 0; attempt < 30 && app.runs?.stopStatus(id).state !== "succeeded"; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const stop = app.runs!.stopStatus(id);
    // This node run started nothing, so its stop is a real success — but the earlier command is
    // exactly the gap it cannot speak for, and the owner must see that as unknown.
    expect(stop).toMatchObject({ state: "succeeded", scope: "this_node_run" });
    expect(stop.unconfirmedOperationIds).toEqual([earlierOperationId]);
  } finally {
    db.close();
  }
});

it("counts every command whose termination nothing proved, however the node answered", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId, socket } = await pairNode(app, cookie);
  const id = randomUUID();
  app.agents.prepare({
    id,
    nodeId,
    name: "Surviving group",
    role: "Writer",
    description: "",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    id,
    {
      username: `mate_${id.replaceAll("-", "").slice(0, 27)}`,
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${id}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  const directory = fixtures.at(-1)!.directory,
    db = new Database(join(directory, "control-plane", "control-plane.sqlite")),
    at = Date.now();
  // Four durable records: a command the node itself could not end, one Mate had to end that still
  // left a descendant alive, one that exited zero but left a background descendant in its group, and
  // one that provably never launched a shell.
  const survivedStop = randomUUID(),
    survivorsLeft = randomUUID(),
    descendantLeft = randomUUID(),
    neverStarted = randomUUID(),
    rejectedByNode = randomUUID();
  try {
    const channel = app.chat.getOrCreateAgentDirectChannel(id)!;
    app.chat.createMessage(channel.id, "先跑几条普通命令。");
    const delivery = db
      .prepare(
        `SELECT id FROM owner_message_deliveries
         WHERE recipient_kind='agent' AND recipient_id=? ORDER BY seq DESC LIMIT 1`,
      )
      .get(id) as { id: string };
    const runId = randomUUID();
    db.prepare(
      `INSERT INTO owner_agent_runs(
         id,agent_id,node_id,delivery_id,state,started_at,input_end_seq,context_history_end_seq
       ) VALUES(?,?,?,?, 'failed',?,1,1)`,
    ).run(runId, id, nodeId, delivery.id, at);
    const insert = (operationId: string, command: string, state: string, receipt: unknown) =>
      db
        .prepare(
          `INSERT INTO owner_agent_process_operations(
             operation_id,run_id,agent_id,node_id,
             request_hash,request_json,state,receipt_json,node_receipt_confirmed,created_at,updated_at
           ) VALUES(?,?,?,?,?,?,?,?,1,?,?)`,
        )
        .run(
          operationId,
          runId,
          id,
          nodeId,
          "e".repeat(64),
          JSON.stringify({
            actionScopeId: delivery.id,
            stableActionId: `mate:${delivery.id}:${"e".repeat(64)}:1`,
            nodeId,
            agentId: id,
            operation: { kind: "exec", command },
          }),
          state,
          JSON.stringify(receipt),
          at,
          at,
        );
    insert(neverStarted, "true", "failed", { reason: "command_not_started" });
    insert(survivorsLeft, "sleep 300", "failed", {
      code: null,
      signal: "SIGKILL",
      timedOut: true,
      processGroupRunning: true,
    });
    insert(survivedStop, "sleep 300", "failed", { reason: "process_stop_unconfirmed" });
    // A successful shell that left a background descendant: the command exited 0 and its process
    // group is still there, which is exactly what the node reports as "descendants_running".
    insert(descendantLeft, "sleep 300 &", "succeeded", {
      code: 0,
      signal: null,
      timedOut: false,
      processGroupRunning: true,
    });
    await app.request(`/api/owner/agents/${id}/pause`, { method: "POST", headers: { cookie } });
    const stopRequest = socket.sent
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find(
        (message) =>
          message.type === "control.process.operation" &&
          (message.operation as { kind?: string })?.kind === "process.stop_all",
      )!;
    // The restarted node's stop ran, and it says which group it could not end.
    await app.nodes.receive(
      socket,
      JSON.stringify({
        type: "node.process.operation.result",
        requestId: stopRequest.requestId,
        operationId: stopRequest.operationId,
        agentId: id,
        state: "failed",
        receipt: {
          reason: "process_stop_unconfirmed",
          stopped: false,
          operationIds: [],
          unconfirmedOperationIds: [survivedStop],
          scope: "this_node_run",
        },
      }),
    );
    for (let attempt = 0; attempt < 30 && app.runs?.stopStatus(id).state === "executing"; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const stop = app.runs!.stopStatus(id);
    expect(stop).toMatchObject({ state: "failed", scope: "this_node_run" });
    expect(stop.unconfirmedOperationIds?.slice().sort()).toEqual(
      [descendantLeft, survivedStop, survivorsLeft].sort(),
    );
    // A command whose shell never started is a proven result, not an unproven one.
    expect(stop.unconfirmedOperationIds).not.toContain(neverStarted);
    expect(stop.unconfirmedOperationIds).not.toContain(rejectedByNode);
    const activity = (await (
      await app.request(`/api/owner/agents/${id}/activity?detail=1`, { headers: { cookie } })
    ).json()) as {
      events: Array<{ kind: string; summary: string; referenceId: string | null }>;
    };
    const finished = activity.events.find(
      (event) =>
        event.kind === "operation.finished" && event.referenceId === stopRequest.operationId,
    );
    expect(finished?.summary).toContain("3 条命令的终止无法确认");
  } finally {
    db.close();
  }
});

it("uses a fresh stop operation ID after an unknown node receipt", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId, socket } = await pairNode(app, cookie);
  const id = randomUUID();
  app.agents.prepare({
    id,
    nodeId,
    name: "Partner",
    role: "Writer",
    description: "",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    id,
    {
      username: `mate_${id.replaceAll("-", "").slice(0, 27)}`,
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${id}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  const pause = () =>
    app.request(`/api/owner/agents/${id}/pause`, { method: "POST", headers: { cookie } });
  expect((await pause()).status).toBe(200);
  const stopRequests = () =>
    socket.sent
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .filter(
        (message) =>
          message.type === "control.process.operation" &&
          (message.operation as { kind?: string })?.kind === "process.stop_all",
      );
  const first = stopRequests()[0]!;
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.process.operation.result",
      requestId: first.requestId,
      operationId: first.operationId,
      agentId: id,
      state: "unknown",
      receipt: { reason: "synthetic_systemctl_timeout" },
    }),
  );
  for (let attempt = 0; attempt < 30 && app.runs?.stopStatus(id).state === "executing"; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(app.runs?.stopStatus(id).state).toBe("unknown");
  expect((await pause()).status).toBe(200);
  const second = stopRequests()[1]!;
  expect(second.operationId).not.toBe(first.operationId);
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.process.operation.result",
      requestId: first.requestId,
      operationId: first.operationId,
      agentId: id,
      state: "succeeded",
      receipt: { stopped: true, units: [] },
    }),
  );
  expect(app.runs?.stopStatus(id).state).toBe("executing");
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.process.operation.result",
      requestId: second.requestId,
      operationId: second.operationId,
      agentId: id,
      state: "succeeded",
      receipt: { stopped: true, units: [] },
    }),
  );
  for (let attempt = 0; attempt < 30 && app.runs?.stopStatus(id).state !== "succeeded"; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(app.runs?.stopStatus(id).state).toBe("succeeded");
});

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

it("rejects a model outside the provider registry before persisting an Agent", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId, socket } = await pairNode(app, cookie);
  const input = {
    id: randomUUID(),
    name: "Invalid model partner",
    role: "Uses an available model",
    description: "A model registry validation fixture.",
    nodeId,
    model: { provider: "openai", id: "gpt-4.1-typo" },
  };
  const creation = app.request("/api/owner/agents", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const provision = socket.sent
    .map((text) => JSON.parse(text) as Record<string, unknown>)
    .find((message) => message.type === "control.agent.provision");
  if (provision) {
    await app.nodes.receive(
      socket,
      JSON.stringify({
        type: "node.agent.provision.result",
        requestId: provision.requestId,
        agentId: input.id,
        ok: false,
        code: "unsupported_host",
        message: "Synthetic provisioning failure.",
      }),
    );
  }
  const response = await creation;
  expect(response.status).toBe(400);
  expect(app.agents.list()).toHaveLength(0);
  expect(provision).toBeUndefined();
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
      stage: "preparing_workspace",
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
        workspace: "/var/lib/mate/agents/ed1e60c8-bdda-4f46-a857-bbd542f82640",
        workspaceMarker: "a".repeat(64),
      },
    }),
  );

  await expect(completed).resolves.toMatchObject({
    ok: true,
    identity: { uid: 23001, gid: 23001 },
  });
  expect(stages).toEqual(["preparing_workspace"]);
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
      stage: "preparing_workspace",
    }),
  );
  const progressResponse = await app.request("/api/owner/agents", { headers: { cookie } });
  const progress = (await progressResponse.json()) as { agents: Array<{ stage: string }> };
  expect(progress.agents[0]?.stage).toBe("preparing_workspace");
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
        workspace: `/var/lib/mate/agents/${input.id}`,
        workspaceMarker: "a".repeat(64),
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
      linuxIdentity: { username: string; uid: number; gid: number; workspace: string };
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
      workspace: `/var/lib/mate/agents/${input.id}`,
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

it("finds an online Agent beyond more than one page of offline deliveries", async () => {
  const app = setup();
  const cookie = await login(app);
  const offlineNode = await pairNode(app, cookie),
    onlineNode = await pairNode(app, cookie);
  app.nodes.close(offlineNode.socket);

  for (let index = 0; index < 105; index++) {
    const id = randomUUID();
    app.agents.prepare({
      id,
      nodeId: offlineNode.id,
      name: `Offline ${index}`,
      role: "Waits for a model run",
      description: "Synthetic scheduler fairness fixture.",
      model: { provider: "openai", id: "gpt-4.1" },
    });
    app.agents.complete(
      id,
      {
        // One ordinary account carries every Agent on a node; only the workspace differs.
        username: "mate-offline-node",
        uid: 24000,
        gid: 24000,
        workspace: `/var/lib/mate/agents/${id}`,
        workspaceMarker: "a".repeat(64),
      },
      app.chat,
    );
    const direct = app.chat.getOrCreateAgentDirectChannel(id)!;
    app.chat.createMessage(direct.id, `离线 Agent ${index} 的排队输入。`);
  }

  const onlineAgentId = randomUUID();
  app.agents.prepare({
    id: onlineAgentId,
    nodeId: onlineNode.id,
    name: "Online partner",
    role: "Runs when ready",
    description: "Must not be starved by offline entries.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    onlineAgentId,
    {
      username: "mate-online-node",
      uid: 25001,
      gid: 25001,
      workspace: `/var/lib/mate/agents/${onlineAgentId}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  const onlineDirect = app.chat.getOrCreateAgentDirectChannel(onlineAgentId)!;
  app.chat.createMessage(onlineDirect.id, "在线 Agent 的排队输入。");

  const credential = await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-scheduler-key" }),
  });
  expect(credential.status).toBe(204);
  const deadline = Date.now() + 3000;
  let run: Record<string, unknown> | undefined;
  while (Date.now() < deadline && !run) {
    run = onlineNode.socket.sent
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find((message) => message.type === "control.agent.run" && message.agentId === onlineAgentId);
    if (!run) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(run).toMatchObject({
    type: "control.agent.run",
    agentId: onlineAgentId,
    channelId: onlineDirect.id,
  });
  expect(app.chat.listPendingDeliveries("agent", onlineAgentId).deliveries).toHaveLength(1);
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
  const concurrentDuplicate = app.request("/api/owner/agents", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.provision.result",
      requestId: firstCommand.requestId,
      agentId: input.id,
      ok: false,
      code: "permission_denied",
      message: "节点无法创建 Agent 工作区根路径，请检查运行账号的写入权限。",
    }),
  );
  const [failed, concurrentFailed] = await Promise.all([failedCreation, concurrentDuplicate]);
  expect(failed.status).toBe(502);
  expect(concurrentFailed.status).toBe(502);
  const failedAgent = (await failed.json()) as { agent: { sessionId: string; status: string } };
  const concurrentFailedAgent = (await concurrentFailed.json()) as {
    agent: { sessionId: string; status: string };
  };
  expect(failedAgent.agent.status).toBe("failed");
  expect(concurrentFailedAgent.agent).toEqual(failedAgent.agent);

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
        workspace: `/var/lib/mate/agents/${input.id}`,
        workspaceMarker: "a".repeat(64),
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

it("refuses an Agent whose node reports a different account than the one it already runs", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId } = await pairNode(app, cookie);
  const request = (id: string, name: string) => ({
    id,
    name,
    role: "Runs under one account",
    description: "Synthetic single-account identity fixture.",
    nodeId,
    model: { provider: "openai", id: "gpt-4.1" },
  });
  const identity = (agentId: string, account: { username: string; uid: number; gid: number }) => ({
    ...account,
    workspace: `/var/lib/mate/agents/${agentId}`,
    workspaceMarker: "a".repeat(64),
  });
  const firstId = "a82eb7db-26f7-40f8-9bb8-8baf21dc5c0a";
  app.agents.prepare(request(firstId, "First partner"));
  expect(() =>
    app.agents.complete(
      firstId,
      identity(firstId, { username: "mate-node-account", uid: 23001, gid: 23001 }),
      app.chat,
    ),
  ).not.toThrow();

  // The second Agent on the same node must report the identical account; a different username,
  // UID or GID means the node is not the single ordinary account this release requires.
  for (const account of [
    { username: "mate-other-account", uid: 23001, gid: 23001 },
    { username: "mate-node-account", uid: 23002, gid: 23001 },
    { username: "mate-node-account", uid: 23001, gid: 23002 },
  ]) {
    const secondId = randomUUID();
    app.agents.prepare(request(secondId, "Second partner"));
    expect(() => app.agents.complete(secondId, identity(secondId, account), app.chat)).toThrow(
      AgentRequestConflict,
    );
    // A refused account leaves no partial completion behind: the node keeps the account it
    // already runs under, and the Agent keeps neither a workspace nor a finished stage.
    expect(app.agents.get(secondId)).toMatchObject({
      status: "provisioning",
      stage: "queued",
      linuxIdentity: null,
    });
    const inspect = databaseFor(app);
    try {
      expect(
        inspect.prepare("SELECT home,home_marker FROM owner_agents WHERE id=?").get(secondId),
      ).toEqual({ home: null, home_marker: null });
    } finally {
      inspect.close();
    }
  }
  const inspect = databaseFor(app);
  try {
    expect(
      inspect.prepare("SELECT linux_username,uid,gid FROM nodes WHERE id=?").get(nodeId),
    ).toEqual({ linux_username: "mate-node-account", uid: 23001, gid: 23001 });
  } finally {
    inspect.close();
  }

  const thirdId = randomUUID();
  app.agents.prepare(request(thirdId, "Third partner"));
  const completed = app.agents.complete(
    thirdId,
    identity(thirdId, { username: "mate-node-account", uid: 23001, gid: 23001 }),
    app.chat,
  );
  expect(completed.linuxIdentity).toEqual({
    username: "mate-node-account",
    uid: 23001,
    gid: 23001,
    workspace: `/var/lib/mate/agents/${thirdId}`,
  });
});

it("refuses to complete an Agent whose node reports it is running as root", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId } = await pairNode(app, cookie);
  const identity = (agentId: string, account: { uid: number; gid: number }) => ({
    username: "root",
    ...account,
    workspace: `/home/mate/agents/${agentId}`,
    workspaceMarker: "a".repeat(64),
  });

  // A first Agent must not be accepted either: this release never runs the node as root, so a
  // root-account report is a deployment fact the owner has to fix, not a usable Agent identity.
  for (const account of [
    { uid: 0, gid: 0 },
    { uid: 0, gid: 1000 },
    { uid: 1000, gid: 0 },
  ]) {
    const agentId = randomUUID();
    app.agents.prepare({
      id: agentId,
      nodeId,
      name: "Root partner",
      role: "Runs under one account",
      description: "Synthetic root-account rejection fixture.",
      model: { provider: "openai", id: "gpt-4.1" },
    });
    expect(() => app.agents.complete(agentId, identity(agentId, account), app.chat)).toThrow(
      AgentRequestConflict,
    );
    expect(app.agents.get(agentId)?.status).toBe("provisioning");
    expect(app.agents.get(agentId)?.linuxIdentity).toBeNull();
  }
});

it("refuses an older experimental database without modifying its schema or node facts", () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-session-reset-"));
  const databasePath = join(directory, "control-plane.sqlite");
  const old = new Database(databasePath);
  old.exec(nodeDirectorySchema);
  old.prepare("INSERT INTO nodes(id,public_key,paired_at) VALUES('node','synthetic',10)").run();
  old.pragma("application_id = 1296257100");
  old.pragma("user_version = 4");
  old.close();
  try {
    expect(() => new OwnerAuth({ dataDir: directory })).toThrow("schema revision 4");
    const check = new Database(databasePath);
    expect(check.pragma("user_version", { simple: true })).toBe(4);
    expect(check.prepare("SELECT id FROM nodes").get()).toEqual({ id: "node" });
    check.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
