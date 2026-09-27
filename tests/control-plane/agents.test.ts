import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/control-plane/http.js";
import { OwnerAuth } from "../../src/control-plane/owner-auth.js";
import {
  controlPlaneMigrations,
  controlPlaneSchemaV4,
  controlPlaneSchemaV11,
  controlPlaneSchemaV8,
  controlPlaneSchemaV14,
  controlPlaneSchemaV15,
  controlPlaneSchemaV23,
} from "../../src/control-plane/schema.js";
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

it("keeps a deactivated Agent stopped when node process stopping is unconfirmed", async () => {
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
  const resume = await app.request(`/api/owner/agents/${id}/resume`, {
    method: "POST",
    headers: { cookie },
  });
  expect(resume.status).toBe(409);
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
      state: "succeeded",
      receipt: { stopped: true, units: [] },
    }),
  );
  for (let attempt = 0; attempt < 30 && app.runs?.stopStatus(id).state !== "succeeded"; attempt++)
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
        operation_id,run_id,agent_id,node_id,action_scope_id,stable_action_id,
        request_hash,request_json,state,receipt_json,node_receipt_confirmed,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,'unknown',?,1,?,?)`,
    ).run(
      earlierOperationId,
      runId,
      id,
      nodeId,
      delivery.id,
      `mate:${delivery.id}:${"d".repeat(64)}:1`,
      "d".repeat(64),
      JSON.stringify({ operation: { kind: "exec", command: "sleep 300" } }),
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
             operation_id,run_id,agent_id,node_id,action_scope_id,stable_action_id,
             request_hash,request_json,state,receipt_json,node_receipt_confirmed,created_at,updated_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)`,
        )
        .run(
          operationId,
          runId,
          id,
          nodeId,
          delivery.id,
          `mate:${delivery.id}:${randomUUID().replaceAll("-", "").padEnd(64, "0").slice(0, 64)}:1`,
          "e".repeat(64),
          JSON.stringify({ operation: { kind: "exec", command } }),
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
    expect(auth.db.pragma("user_version", { simple: true })).toBe(24);
    expect(auth.db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(auth.db.prepare("SELECT id FROM nodes").get()).toEqual({
      id: "c5342142-9cf5-4b22-86f3-bdc46bb471f2",
    });
    expect(
      auth.db.prepare("SELECT name FROM sqlite_master WHERE name='owner_agents'").get(),
    ).toEqual({
      name: "owner_agents",
    });
    expect(controlPlaneMigrations.map((migration) => migration.fromRevision)).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    ]);
    for (const [table, column] of [
      ["owner_agent_process_operations", "node_receipt_revision"],
      ["owner_agent_stop_intents", "node_receipt_revision"],
      ["owner_privileged_approvals", "node_receipt_revision"],
    ])
      expect(
        (auth.db.pragma(`table_info(${table})`) as Array<{ name: string }>).some(
          (item) => item.name === column,
        ),
      ).toBe(true);
  } finally {
    auth.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("adds workspace access metadata on new and upgraded control-plane databases", () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-workspace-audit-migration-")),
    databasePath = join(directory, "control-plane.sqlite"),
    old = new Database(databasePath);
  old.exec(controlPlaneSchemaV14);
  old.pragma("application_id = 1296257100");
  old.pragma("user_version = 14");
  old.close();

  const auth = new OwnerAuth({ dataDir: directory });
  try {
    expect(auth.db.pragma("user_version", { simple: true })).toBe(24);
    expect(
      auth.db
        .prepare("SELECT name FROM sqlite_master WHERE name='owner_workspace_access_audit'")
        .get(),
    ).toEqual({ name: "owner_workspace_access_audit" });
    expect(auth.db.prepare("PRAGMA table_info(owner_workspace_access_audit)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "download_id" }),
        expect.objectContaining({ name: "owner_session_hash" }),
        expect.objectContaining({ name: "download_expires_at" }),
        expect.objectContaining({ name: "completed_at" }),
      ]),
    );
    const newDirectory = mkdtempSync(join(tmpdir(), "mate-workspace-audit-new-")),
      newAuth = new OwnerAuth({ dataDir: newDirectory });
    try {
      expect(newAuth.db.pragma("user_version", { simple: true })).toBe(24);
      expect(
        newAuth.db
          .prepare("SELECT name FROM sqlite_master WHERE name='owner_workspace_access_audit'")
          .get(),
      ).toEqual({ name: "owner_workspace_access_audit" });
    } finally {
      newAuth.close();
      rmSync(newDirectory, { recursive: true, force: true });
    }
  } finally {
    auth.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("adds Agent recovery state to a revision 15 database while preserving file access audit", () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-recovery-migration-")),
    databasePath = join(directory, "control-plane.sqlite"),
    old = new Database(databasePath);
  old.exec(controlPlaneSchemaV15);
  old.pragma("application_id = 1296257100");
  old.pragma("user_version = 15");
  old.close();

  const auth = new OwnerAuth({ dataDir: directory });
  try {
    expect(auth.db.pragma("user_version", { simple: true })).toBe(24);
    for (const table of [
      "owner_workspace_access_audit",
      "owner_agent_activity",
      "owner_agent_run_control",
    ]) {
      expect(auth.db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table)).toEqual({
        name: table,
      });
    }
  } finally {
    auth.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("backfills committed conversation tool actions into recoverable journal history", () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-action-history-migration-")),
    databasePath = join(directory, "control-plane.sqlite"),
    old = new Database(databasePath);
  old.exec(controlPlaneSchemaV11);
  old.exec(`
    INSERT INTO nodes(id,public_key,paired_at) VALUES('node','synthetic-public-key',1);
    INSERT INTO owner_channels(id,name,description,visibility,created_at,updated_at)
      VALUES('room','Research','Synthetic migration fixture','private',1,1);
    INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at)
      VALUES('room','human','owner',1,1),('room','agent','agent',1,1);
    INSERT INTO owner_agents(
      id,node_id,name,role,description,provider,model_id,request_json,request_hash,
      provision_request_id,status,stage,linux_username,uid,gid,home,created_at,updated_at,model_ready
    ) VALUES(
      'agent','node','Partner','Replies','Migration fixture','openai','gpt-4.1','{}',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','provision',
      'waiting_credentials','complete','mate_agent',23001,23001,'/var/lib/mate/agents/agent',1,1,0
    );
    INSERT INTO owner_agent_sessions(id,agent_id,created_at,verified_at)
      VALUES('session','agent',1,1);
    INSERT INTO owner_messages(id,channel_id,order_seq,text,author_kind,author_id,created_at)
      VALUES('sent-message','room',1,'Persisted action text','agent','agent',2);
    INSERT INTO owner_agent_session_journal(
      session_id,agent_id,channel_id,message_id,role,text,created_at
    ) VALUES('session','agent','room','sent-message','assistant','Persisted action text',2);
  `);
  old
    .prepare(
      `INSERT INTO owner_agent_tool_actions(
         session_id,action_id,agent_id,operation,request_hash,result_json,created_at
       ) VALUES(?,?,?,?,?,?,?)`,
    )
    .run(
      "session",
      "legacy-action",
      "agent",
      "messages.send",
      "b".repeat(64),
      JSON.stringify({ id: "sent-message", channelId: "room", text: "Persisted action text" }),
      2,
    );
  old.pragma("application_id = 1296257100");
  old.pragma("user_version = 11");
  old.close();

  const auth = new OwnerAuth({ dataDir: directory });
  try {
    expect(auth.db.pragma("user_version", { simple: true })).toBe(24);
    expect(
      auth.db
        .prepare(
          `SELECT message_id,tool_action_id FROM owner_agent_session_journal
           WHERE message_id='sent-message'`,
        )
        .get(),
    ).toEqual({ message_id: "sent-message", tool_action_id: "legacy-action" });
    const receipt = auth.db
      .prepare(
        `SELECT text,tool_action_id FROM owner_agent_session_journal
         WHERE message_id IS NULL AND tool_action_id='legacy-action'`,
      )
      .get() as { text: string; tool_action_id: string } | undefined;
    expect(receipt?.tool_action_id).toBe("legacy-action");
    expect(receipt?.text).toContain('messages.send {"id":"sent-message","channelId":"room"}');
    expect(receipt?.text).not.toContain("Persisted action text");
  } finally {
    auth.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("backfills pending channel deliveries into the shared session journal when upgrading revision 8", () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-batch-migration-")),
    databasePath = join(directory, "control-plane.sqlite");
  const old = new Database(databasePath);
  old.exec(controlPlaneSchemaV8);
  old.exec(`
    INSERT INTO nodes(id,public_key,paired_at) VALUES('node','synthetic-public-key',1);
    INSERT INTO owner_channels(id,name,description,visibility,created_at,updated_at)
      VALUES('room','Research','Synthetic migration fixture','private',1,1),
            ('room-2','Research 2','Second migration fixture','private',1,1);
    INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at)
      VALUES('room','human','owner',1,1),('room','agent','agent',1,1),
            ('room-2','human','owner',1,1),('room-2','agent','agent',1,1);
    INSERT INTO owner_agents(
      id,node_id,name,role,description,provider,model_id,request_json,request_hash,
      provision_request_id,status,stage,linux_username,uid,gid,home,created_at,updated_at,model_ready
    ) VALUES(
      'agent','node','Partner','Replies','Migration fixture','openai','gpt-4.1','{}',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','provision',
      'waiting_credentials','complete','mate_agent',23001,23001,'/var/lib/mate/agents/agent',1,1,0
    );
    INSERT INTO owner_agent_sessions(id,agent_id,created_at,verified_at)
      VALUES('session','agent',1,1);
    INSERT INTO owner_messages(id,channel_id,order_seq,text,author_kind,author_id,created_at)
      VALUES('message','room',1,'旧版频道排队输入','human','owner',1),
            ('message-2','room-2',1,'旧版第二频道排队输入','human','owner',2);
    INSERT INTO owner_message_deliveries(id,message_id,channel_id,recipient_kind,recipient_id,state,created_at)
      VALUES('delivery','message','room','agent','agent','pending',1);
    INSERT INTO owner_message_deliveries(id,message_id,channel_id,recipient_kind,recipient_id,state,created_at)
      VALUES('delivery-2','message-2','room-2','agent','agent','pending',2);
  `);
  old.pragma("application_id = 1296257100");
  old.pragma("user_version = 8");
  old.close();

  const auth = new OwnerAuth({ dataDir: directory });
  try {
    expect(auth.db.pragma("user_version", { simple: true })).toBe(24);
    expect(
      auth.db
        .prepare(
          "SELECT role,text FROM owner_agent_session_journal WHERE agent_id='agent' ORDER BY seq",
        )
        .all(),
    ).toEqual([
      { role: "user", text: "旧版频道排队输入" },
      { role: "user", text: "旧版第二频道排队输入" },
    ]);
    expect(
      auth.db.prepare("SELECT input_end_seq FROM owner_agent_runs WHERE id='missing'").get(),
    ).toBeUndefined();
    expect(
      auth.db
        .prepare("SELECT context_history_end_seq FROM owner_agent_runs WHERE id='missing'")
        .get(),
    ).toBeUndefined();
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
  expect(app.chat.listAgentSessionJournal(input.id, 0, 10).messages).toMatchObject([
    { role: "user", text: "A queued first message" },
  ]);
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
      true,
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
    true,
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

it("upgrades a version 23 Agent row to the single-account stage names and foreign keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-single-account-migration-")),
    databasePath = join(directory, "control-plane.sqlite");
  const old = new Database(databasePath);
  old.exec(controlPlaneSchemaV23);
  old.exec(`
    INSERT INTO nodes(id,public_key,paired_at) VALUES('node','synthetic-public-key',1);
    INSERT INTO owner_channels(id,name,description,visibility,created_at,updated_at)
      VALUES('room','Research','Migration fixture','private',1,1);
  `);
  const insertAgent = old.prepare(`
    INSERT INTO owner_agents(
      id,node_id,name,role,description,provider,model_id,request_json,request_hash,
      provision_request_id,status,stage,error,linux_username,uid,gid,home,home_marker,
      created_at,updated_at,model_ready
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  insertAgent.run(
    "agent-a",
    "node",
    "A",
    "Replies",
    "Old account fixture",
    "openai",
    "gpt-4.1",
    "{}",
    "a".repeat(64),
    "provision-a",
    "waiting_credentials",
    "preparing_home",
    "旧版建账号失败：需要 root 权限。",
    "mate_agent",
    23001,
    23001,
    "/var/lib/mate/agents/agent-a",
    "a1".repeat(32),
    1,
    1,
    1,
  );
  insertAgent.run(
    "agent-b",
    "node",
    "B",
    "Replies",
    "Interrupted old account fixture",
    "openai",
    "gpt-4.1",
    "{}",
    "b".repeat(64),
    "provision-b",
    "provisioning",
    "creating_account",
    null,
    null,
    null,
    null,
    null,
    null,
    2,
    2,
    0,
  );
  old.exec(`
    INSERT INTO owner_agent_sessions(id,agent_id,created_at,verified_at)
      VALUES('session-a','agent-a',1,1),('session-b','agent-b',2,NULL);
  `);
  old.pragma("application_id = 1296257100");
  old.pragma("user_version = 23");
  old.close();

  const auth = new OwnerAuth({ dataDir: directory });
  try {
    expect(auth.db.pragma("user_version", { simple: true })).toBe(24);
    expect(auth.db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(auth.db.pragma("foreign_key_check")).toEqual([]);
    // Every row that carried a per-Agent identity is queued for one workspace re-verification, so
    // the obsolete stage names never survive, no row keeps claiming a removed account, and the
    // failure text that named that account goes with it.
    expect(
      auth.db.prepare("SELECT id,stage,status,error FROM owner_agents ORDER BY id").all(),
    ).toEqual([
      { id: "agent-a", stage: "queued", status: "provisioning", error: null },
      { id: "agent-b", stage: "queued", status: "provisioning", error: null },
    ]);
    expect(
      auth.db.prepare("SELECT id,agent_id FROM owner_agent_sessions ORDER BY id").all(),
    ).toEqual([
      { id: "session-a", agent_id: "agent-a" },
      { id: "session-b", agent_id: "agent-b" },
    ]);
    expect(
      auth.db.prepare("SELECT id,home_marker,model_ready FROM owner_agents ORDER BY id").all(),
    ).toEqual([
      { id: "agent-a", home_marker: "a1".repeat(32), model_ready: 1 },
      { id: "agent-b", home_marker: null, model_ready: 0 },
    ]);
    // A row that never had an account keeps its own stage vocabulary mapping instead of being
    // reset, so an upgrade does not lose the progress of an Agent that was still being prepared.
    const freshRowId = "agent-b";
    // The single account replaces the per-Agent account, so the recorded per-Agent identity no
    // longer describes anything this release can use. It is cleared rather than left behind to
    // disagree with the account the node will report on the next verification.
    expect(
      auth.db
        .prepare("SELECT id,status,stage,linux_username,uid,gid,home FROM owner_agents ORDER BY id")
        .all(),
    ).toEqual([
      {
        id: "agent-a",
        status: "provisioning",
        stage: "queued",
        linux_username: null,
        uid: null,
        gid: null,
        home: null,
      },
      {
        id: "agent-b",
        status: "provisioning",
        stage: "queued",
        linux_username: null,
        uid: null,
        gid: null,
        home: null,
      },
    ]);
    // The rebuilt table still enforces the stage vocabulary it declares.
    expect(() =>
      auth.db.prepare("UPDATE owner_agents SET stage='creating_account' WHERE id='agent-a'").run(),
    ).toThrow();
  } finally {
    auth.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("creates a new Agent on a node that carries an upgraded single-account row", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-mixed-account-")),
    databasePath = join(directory, "control-plane.sqlite");
  const old = new Database(databasePath);
  old.exec(controlPlaneSchemaV23);
  old.exec(`
    INSERT INTO nodes(id,public_key,paired_at) VALUES('node','synthetic-public-key',1);
  `);
  old
    .prepare(
      "INSERT INTO owner_agents(id,node_id,name,role,description,provider,model_id,request_json,request_hash,provision_request_id,status,stage,error,linux_username,uid,gid,home,home_marker,created_at,updated_at,model_ready) VALUES('legacy','node','Legacy','Partner','Old account fixture','openai','gpt-4.1','{}',?,'provision-legacy','failed','failed','旧版建账号失败：需要 root 权限。','mate_legacy',23001,23001,'/var/lib/mate/agents/legacy',?,1,1,0)",
    )
    .run("c".repeat(64), "b2".repeat(32));
  old.exec(
    "INSERT INTO owner_agent_sessions(id,agent_id,created_at,verified_at) VALUES('session','legacy',1,1)",
  );
  old.pragma("application_id = 1296257100");
  old.pragma("user_version = 23");
  old.close();

  const auth = new OwnerAuth({ dataDir: directory });
  try {
    // The upgraded row no longer claims a per-Agent account, so it cannot block a later Agent, and
    // the failure text that named that removed account is cleared with it.
    expect(auth.db.pragma("user_version", { simple: true })).toBe(24);
    expect(
      auth.db
        .prepare(
          "SELECT status,stage,error,linux_username,uid,gid,home FROM owner_agents WHERE id='legacy'",
        )
        .get(),
    ).toEqual({
      status: "provisioning",
      stage: "queued",
      error: null,
      linux_username: null,
      uid: null,
      gid: null,
      home: null,
    });
    const agents = new AgentDirectory(auth.db);
    const freshId = randomUUID();
    agents.prepare({
      id: freshId,
      nodeId: "node",
      name: "Fresh partner",
      role: "Runs under one account",
      description: "Synthetic post-upgrade fixture.",
      model: { provider: "openai", id: "gpt-4.1" },
    });
    expect(() =>
      agents.complete(
        freshId,
        {
          username: "mate-node-account",
          uid: 23001,
          gid: 23001,
          workspace: `/var/lib/mate/agents/${freshId}`,
          workspaceMarker: "a".repeat(64),
        },
        {} as never,
      ),
    ).not.toThrow();
  } finally {
    auth.close();
    rmSync(directory, { recursive: true, force: true });
  }
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
    expect(app.agents.get(secondId)?.status).toBe("provisioning");
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
