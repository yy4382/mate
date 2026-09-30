import { toolTestApp, toolTestInput, type TestRun } from "../helpers/tool-run.js";
import { AgentSession } from "../../src/agent-session.js";
import { assistantEntry } from "../helpers/session.js";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/http.js";
import { deriveAgentProcessOperationId } from "../../src/agent-process-operations.js";
import type { NodeSocket } from "../../src/nodes/directory.js";
import type { NodeControlMessage } from "@mate/protocol";

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
  const app = toolTestApp({ dataDir: join(directory, "control-plane"), passwordFile });
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
  await toolTestInput(
    app,
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

async function waitForRun(socket: FakeNodeSocket, startAt: number): Promise<TestRun> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const message = socket.sent
      .slice(startAt)
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find((candidate) => candidate.type === "test.run.started");
    if (message) return message as unknown as TestRun;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The Agent process tool test did not start a run");
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The Agent process recovery condition did not settle");
}

async function sendTool(
  app: ReturnType<typeof createControlPlaneApp>,
  socket: FakeNodeSocket,
  run: { runId: string; agentId: string },
  toolCallId: string,
  operation: string,
  input: Record<string, unknown>,
): Promise<void> {
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "tools.execute",
      requestId: randomUUID(),
      runId: run.runId,
      agentId: run.agentId,
      toolCallId,
      operation,
      input,
    }),
  );
}

it.each(["restart", "reconnect", "conflicting receipt", "malformed workspace"])(
  "continues the same session without new input after %s and presents uncertainty first",
  async (mode) => {
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
        workspace: `/var/lib/mate/agents/${agentId}`,
        workspaceMarker: "a".repeat(64),
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
    operation_id,run_id,agent_id,node_id,
    request_hash,request_json,state,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,'executing',?,?)`,
    ).run(
      operationId,
      run.runId,
      agentId,
      nodeId,
      "f".repeat(64),
      JSON.stringify({
        actionScopeId: run.actionScopeId,
        stableActionId: actionId,
        nodeId,
        agentId,
        operation: { kind: "exec", command: "true" },
      }),
      at,
      at,
    );
    if (mode === "malformed workspace")
      db.prepare(
        `INSERT INTO owner_agent_tool_actions
    (session_id,action_id,agent_id,operation,request_hash,result_json,created_at)
    VALUES(?,?,?,'workspace.write_file',?,'{',?)`,
      ).run(run.sessionId, "broken-file-action", agentId, "b".repeat(64), at);
    if (mode === "reconnect") app.nodes.close(socket);
    else app.runs?.close(); // The original control-plane process crashed before dispatch.
    const directory = fixtures.at(-1)!.directory;
    const restarted =
      mode === "reconnect"
        ? app
        : toolTestApp({
            dataDir: join(directory, "control-plane"),
            passwordFile: join(directory, "owner-password"),
          });
    try {
      const recovered = new FakeNodeSocket();
      restarted.nodes.open(recovered);
      const challenge = JSON.parse(recovered.sent[0]!) as { nonce: string };
      await toolTestInput(
        restarted,
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
      expect(recovered.sent.some((text) => text.includes('"type":"test.run.started"'))).toBe(false);
      await toolTestInput(
        restarted,
        recovered,
        JSON.stringify({
          type: "node.process.reconcile.result",
          requestId: reconcile.requestId,
          receipts:
            mode === "conflicting receipt"
              ? [
                  {
                    operationId,
                    agentId: randomUUID(),
                    state: "succeeded",
                    receipt: { code: 0 },
                    revision: 2,
                  },
                ]
              : [],
        }),
      );
      expect(
        db
          .prepare("SELECT state FROM owner_agent_process_operations WHERE operation_id=?")
          .get(operationId),
      ).toEqual({ state: "unknown" });

      expect(
        db.prepare("SELECT error_code FROM owner_agent_runs WHERE id=?").get(run.runId),
      ).toEqual({ error_code: "interrupted" });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM owner_agent_activity WHERE kind='run.interrupted' AND reference_id=?",
          )
          .get(run.runId),
      ).toEqual({ count: 1 });
      const next = await waitForRun(recovered, 0);
      expect(next.runId).not.toBe(run.runId);
      expect(next.sessionId).toBe(run.sessionId);
      await toolTestInput(
        restarted,
        recovered,
        JSON.stringify({
          type: "session.read",
          requestId: randomUUID(),
          runId: next.runId,
          agentId,
          cursor: 0,
          limit: 100,
        }),
      );
      const context = JSON.parse(recovered.sent.at(-1)!);
      expect(JSON.stringify(context.messages)).toContain(operationId);
      expect(JSON.stringify(context.messages)).toContain(
        mode === "conflicting receipt"
          ? "node_receipt_identity_conflict"
          : "no_durable_node_receipt",
      );
      expect(JSON.stringify(context.messages)).toContain("仍可能运行");
      expect(JSON.stringify(context.messages)).toContain("true");
      expect(
        recovered.sent.some((text) => JSON.parse(text).type === "control.process.operation"),
      ).toBe(false);
      if (mode === "malformed workspace") {
        expect(JSON.stringify(context.messages)).toContain("broken-file-action");
        expect(JSON.stringify(context.messages)).toContain("historical_information_unreadable");
      }
      const corrections = context.messages.filter(
        (entry: { message: { content: unknown } }) =>
          typeof entry.message.content === "string" &&
          entry.message.content.startsWith("Mate 收据更正："),
      );
      for (const entry of corrections)
        await toolTestInput(
          restarted,
          recovered,
          JSON.stringify({
            type: "session.append",
            requestId: entry.id,
            runId: next.runId,
            agentId,
            entry: { kind: "message", id: entry.id, message: entry.message },
          }),
        );
      await toolTestInput(
        restarted,
        recovered,
        JSON.stringify({
          type: "session.read",
          requestId: randomUUID(),
          runId: next.runId,
          agentId,
          cursor: 0,
          limit: 100,
        }),
      );
      const consumed = JSON.parse(recovered.sent.at(-1)!);
      expect(
        consumed.messages.filter((entry: { id: string }) =>
          corrections.some((fact: { id: string }) => fact.id === entry.id),
        ),
      ).toHaveLength(corrections.length);
      expect(
        consumed.messages.filter(
          (entry: { id: string; pending?: boolean }) =>
            entry.pending && corrections.some((fact: { id: string }) => fact.id === entry.id),
        ),
      ).toHaveLength(0);
    } finally {
      restarted.close();
    }
  },
);

it("rechecks stopped scopes after a restarted node confirms an ordinary operation remains unknown", async () => {
  const { app, cookie, db, nodeId, socket, keyPair } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Interrupted command",
    role: "Process recovery",
    description: "Unknown command effect after restart",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  const identity = {
    username: `mate_${agentId.replaceAll("-", "").slice(0, 27)}`,
    uid: 23003,
    gid: 23003,
    workspace: `/var/lib/mate/agents/${agentId}`,
    workspaceMarker: "a".repeat(64),
  };
  app.agents.complete(agentId, identity, app.chat);
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-key" }),
  });
  const start = socket.sent.length;
  app.chat.createMessage(direct.id, "Start a command.");
  const run = await waitForRun(socket, start);
  const operationId = randomUUID(),
    stableActionId = `mate:${run.actionScopeId}:${"c".repeat(64)}:1`;
  db.prepare(
    `INSERT INTO owner_agent_process_operations(
      operation_id,run_id,agent_id,node_id,
      request_hash,request_json,state,receipt_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,'unknown',?,?,?)`,
  ).run(
    operationId,
    run.runId,
    agentId,
    nodeId,
    "c".repeat(64),
    JSON.stringify({
      actionScopeId: run.actionScopeId,
      stableActionId,
      nodeId,
      agentId,
      operation: { kind: "exec", command: "true" },
    }),
    JSON.stringify({ reason: "node_response_unavailable" }),
    Date.now(),
    Date.now(),
  );
  app.runs?.pauseAgent(agentId);
  const stopRequests = (target: FakeNodeSocket) =>
    target.sent
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .filter(
        (message) =>
          message.type === "control.process.operation" &&
          (message.operation as { kind?: string })?.kind === "process.stop_all",
      );
  const firstStop = stopRequests(socket)[0]!;
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "node.process.operation.result",
      requestId: firstStop.requestId,
      operationId: firstStop.operationId,
      agentId,
      state: "succeeded",
      receipt: { stopped: true, units: [] },
    }),
  );
  await waitFor(() => app.runs?.stopStatus(agentId).state === "unknown");
  expect(app.runs?.stopStatus(agentId).receipt).toEqual({ reason: "pending_process_receipts" });
  expect(app.runs?.pauseReason(agentId)).toBe("manual");

  app.nodes.close(socket);
  const reconnect = new FakeNodeSocket();
  app.nodes.open(reconnect);
  const challenge = JSON.parse(reconnect.sent[0]!) as { nonce: string };
  await toolTestInput(
    app,
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
  expect(reconcile.operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ operationId, agentId }),
      expect.objectContaining({ operationId: firstStop.operationId, agentId }),
    ]),
  );
  await toolTestInput(
    app,
    reconnect,
    JSON.stringify({
      type: "node.process.reconcile.result",
      requestId: reconcile.requestId,
      receipts: [
        {
          operationId: firstStop.operationId,
          agentId,
          state: "succeeded",
          receipt: { stopped: true, units: [] },
        },
        {
          operationId,
          agentId,
          state: "unknown",
          receipt: { reason: "node_restarted_during_operation" },
        },
      ],
    }),
  );
  expect(
    db
      .prepare(
        "SELECT state,node_receipt_confirmed FROM owner_agent_process_operations WHERE operation_id=?",
      )
      .get(operationId),
  ).toEqual({ state: "unknown", node_receipt_confirmed: 1 });
  await waitFor(() => stopRequests(reconnect).length > 0);
  const secondStop = stopRequests(reconnect)[0]!;
  expect(secondStop.operationId).not.toBe(firstStop.operationId);
  expect(
    reconnect.sent.some(
      (text) =>
        text.includes(`\"operationId\":\"${operationId}\"`) &&
        text.includes("control.process.operation"),
    ),
  ).toBe(false);
  await toolTestInput(
    app,
    reconnect,
    JSON.stringify({
      type: "node.process.operation.result",
      requestId: secondStop.requestId,
      operationId: secondStop.operationId,
      agentId,
      state: "unknown",
      receipt: { reason: "old_command_may_still_run" },
    }),
  );
  await waitFor(() => app.runs?.stopStatus(agentId).state === "unknown");
  await toolTestInput(
    app,
    reconnect,
    JSON.stringify({
      type: "node.process.operation.result",
      requestId: randomUUID(),
      operationId,
      agentId,
      state: "succeeded",
      receipt: { code: 0, processGroupRunning: true },
      revision: 2,
    }),
  );
  const resuming = app.runs!.resumeAgent(agentId);
  await waitFor(() =>
    reconnect.sent.some(
      (text) =>
        text.includes('"type":"control.agent.provision"') && text.includes('"verifyOnly":true'),
    ),
  );
  const verify = reconnect.sent
    .map((text) => JSON.parse(text) as Record<string, unknown>)
    .find((message) => message.type === "control.agent.provision" && message.verifyOnly)!;
  await toolTestInput(
    app,
    reconnect,
    JSON.stringify({
      type: "node.agent.provision.result",
      requestId: verify.requestId,
      agentId,
      ok: true,
      identity,
    }),
  );
  expect(await resuming).toEqual({ ok: true });
  expect(app.runs?.pauseReason(agentId)).toBeNull();
  const resumed = await waitForRun(reconnect, 0);
  await toolTestInput(
    app,
    reconnect,
    JSON.stringify({
      type: "session.read",
      requestId: randomUUID(),
      runId: resumed.runId,
      agentId,
      cursor: 0,
      limit: 100,
    }),
  );
  const context = JSON.parse(reconnect.sent.at(-1)!);
  expect(JSON.stringify(context.messages)).toContain(secondStop.operationId);
  expect(JSON.stringify(context.messages)).toContain("old_command_may_still_run");
  const session = new AgentSession(db);
  for (const entry of session.pendingCorrections(agentId, resumed.runId))
    expect(
      session.append(resumed.runId, nodeId, agentId, {
        kind: "message",
        id: entry.id,
        message: entry.message,
      }),
    ).toBe(true);
  const lateStop = {
    type: "node.process.operation.result",
    requestId: randomUUID(),
    operationId: secondStop.operationId,
    agentId,
    state: "succeeded",
    receipt: { stopped: true, units: [] },
    revision: 3,
  };
  await toolTestInput(app, reconnect, JSON.stringify(lateStop));
  await toolTestInput(
    app,
    reconnect,
    JSON.stringify({
      type: "session.read",
      requestId: randomUUID(),
      runId: resumed.runId,
      agentId,
      cursor: 0,
      limit: 100,
    }),
  );
  const corrected = JSON.parse(reconnect.sent.at(-1)!);
  const additions = session.pendingCorrections(agentId, resumed.runId);
  expect(additions).toHaveLength(1);
  expect(JSON.stringify(additions)).toContain(secondStop.operationId);
  expect(JSON.stringify(additions)).toContain("succeeded");
  expect(JSON.stringify(corrected.messages)).toContain(JSON.stringify(additions[0]!.message));
  expect(
    session.append(resumed.runId, nodeId, agentId, {
      kind: "message",
      id: additions[0]!.id,
      message: additions[0]!.message,
    }),
  ).toBe(true);
  await toolTestInput(app, reconnect, JSON.stringify(lateStop));
  expect(session.pendingCorrections(agentId, resumed.runId)).toEqual([]);
  expect(JSON.stringify(session.read(agentId))).toContain("old_command_may_still_run");
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
      workspace: `/var/lib/mate/agents/${agentId}`,
      workspaceMarker: "a".repeat(64),
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

  await toolTestInput(
    app,
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
    type: "tools.result",
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

it("offers no privileged request or approval-status tool and no owner approval route", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Ordinary operator",
    role: "Runs ordinary commands",
    description: "Synthetic tool surface fixture.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: `mate_${agentId.replaceAll("-", "").slice(0, 27)}`,
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${agentId}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tool-surface-key" }),
  });
  const startAt = socket.sent.length;
  app.chat.createMessage(direct.id, "What can you run?");
  const run = await waitForRun(socket, startAt);

  await sendTool(app, socket, run, "list-all-tools", "tools.list", {});
  const names = (
    JSON.parse(socket.sent.at(-1)!) as { result?: { tools?: Array<{ name: string }> } }
  ).result?.tools?.map((tool) => tool.name);
  expect(names).toContain("process.exec");
  expect(names).not.toContain("system.exec");
  expect(names).not.toContain("system.status");

  for (const name of ["system.exec", "system.status"])
    await sendTool(app, socket, run, `describe-${name}`, "tools.describe", { name });
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ ok: false, error: "Unknown operation" });

  await sendTool(app, socket, run, "request-root", "tools.call", {
    name: "system.exec",
    input: { program: "/usr/bin/id", args: ["-u"], cwd: "/tmp" },
  });
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ ok: false, error: "Unknown operation" });
  expect(socket.sent.some((text) => text.includes("control.privileged"))).toBe(false);

  const requestId = randomUUID();
  expect(
    (await app.request(`/api/owner/channels/${direct.id}/approvals`, { headers: { cookie } }))
      .status,
  ).toBe(404);
  expect(
    (await app.request(`/api/owner/approvals/${requestId}`, { headers: { cookie } })).status,
  ).toBe(404);
  expect(
    (
      await app.request(`/api/owner/approvals/${requestId}/decision`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ decision: "approve" }),
      })
    ).status,
  ).toBe(404);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%privileged%'").all()).toEqual(
    [],
  );
});

it("runs an explicit sudo the Agent wrote as one ordinary command with its own result", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Sudo operator",
    role: "Runs ordinary commands",
    description: "Synthetic sudo fixture.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: `mate_${agentId.replaceAll("-", "").slice(0, 27)}`,
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${agentId}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-sudo-key" }),
  });
  const startAt = socket.sent.length;
  app.chat.createMessage(direct.id, "Run a command that asks for root.");
  const run = await waitForRun(socket, startAt);

  const command = "sudo -n systemctl restart nginx";
  const toolResult = sendTool(
    app,
    socket,
    run,
    `mate:${run.actionScopeId}:${"b".repeat(64)}:1`,
    "tools.call",
    {
      name: "process.exec",
      input: { command },
    },
  );
  const deadline = Date.now() + 4000;
  let processRequest: Record<string, unknown> | undefined;
  while (Date.now() < deadline && !processRequest) {
    processRequest = socket.sent
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find((message) => message.type === "control.process.operation");
    if (!processRequest) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The command reaches the node exactly as written: no elevation, wrapping or approval step.
  expect(processRequest).toMatchObject({
    type: "control.process.operation",
    operation: { kind: "exec", command },
  });

  // The host decided the command failed; the Agent gets that ordinary receipt and nothing else.
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "node.process.operation.result",
      requestId: processRequest!.requestId,
      operationId: processRequest!.operationId,
      agentId,
      state: "failed",
      receipt: { code: 1, stdout: "", stderr: "sudo: a password is required\n" },
    }),
  );
  await toolResult;
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    ok: true,
    result: {
      state: "failed",
      receipt: { code: 1, stderr: "sudo: a password is required\n" },
    },
  });
  expect(
    db
      .prepare(
        `SELECT state FROM owner_agent_process_operations WHERE operation_id=? AND agent_id=?`,
      )
      .get(processRequest!.operationId, agentId),
  ).toEqual({ state: "failed" });
  expect(socket.sent.some((text) => text.includes("privileged"))).toBe(false);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%privileged%'").all()).toEqual(
    [],
  );
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
      workspace: `/var/lib/mate/agents/${agentId}`,
      workspaceMarker: "a".repeat(64),
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
  await toolTestInput(
    app,
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
  expect(reconcile.operations).toMatchObject([{ operationId: operation!.operationId, agentId }]);
  expect(reconnect.sent.some((text) => text.includes('test.run.started"'))).toBe(false);
  await toolTestInput(
    app,
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
  await toolTestInput(
    app,
    reconnect,
    JSON.stringify({
      type: "session.read",
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
        JSON.stringify(message).includes(String(operation!.operationId)) &&
        JSON.stringify(message).includes("succeeded"),
    ),
  ).toBe(true);
  await toolTestInput(
    app,
    reconnect,
    JSON.stringify({
      type: "session.append",
      requestId: randomUUID(),
      runId: oldRun.runId,
      agentId,
      entry: assistantEntry("stale transcript"),
    }),
  );
  expect(JSON.parse(reconnect.sent.at(-1)!)).toMatchObject({
    type: "session.commit",
    accepted: false,
  });
  await toolTestInput(
    app,
    reconnect,
    JSON.stringify({
      type: "tools.execute",
      requestId: randomUUID(),
      runId: oldRun.runId,
      agentId,
      toolCallId: "stale",
      operation: "tools.list",
      input: {},
    }),
  );
  expect(JSON.parse(reconnect.sent.at(-1)!)).toMatchObject({
    type: "tools.result",
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
  await toolTestInput(
    app,
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
  expect(secondSync.operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ operationId: secondOperation!.operationId, agentId }),
    ]),
  );
  await toolTestInput(
    app,
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
  await toolTestInput(
    app,
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
  db.prepare(
    `UPDATE owner_agent_process_operations SET state='unknown',receipt_json=?,
    node_receipt_confirmed=1,node_receipt_revision=3 WHERE operation_id=?`,
  ).run(JSON.stringify({ code: 0 }), secondOperation!.operationId);
  expect(
    app.runs?.processOperations.reconcile(nodeId, {
      operationId: secondOperation!.operationId as string,
      agentId,
      state: "failed",
      receipt: { code: 1 },
      revision: 2,
    }),
  ).toMatchObject({ corrected: false });
  expect(
    db
      .prepare(
        `SELECT state,node_receipt_revision,receipt_json FROM owner_agent_process_operations
    WHERE operation_id=?`,
      )
      .get(secondOperation!.operationId),
  ).toEqual({
    state: "unknown",
    node_receipt_revision: 3,
    receipt_json: JSON.stringify({ code: 0 }),
  });

  const stored = db
    .prepare(`SELECT run_id,request_json FROM owner_agent_process_operations WHERE operation_id=?`)
    .get(secondOperation!.operationId) as {
    run_id: string;
    request_json: string;
  };
  // The committed request is the only record of the operation's identity; a replay reads it there.
  const originalRequest = JSON.parse(stored.request_json) as {
    actionScopeId: string;
    stableActionId: string;
    operation: unknown;
  };
  const replayStart = again.sent.length;
  const replay = app.runs!.processOperations.execute({
    runId: stored.run_id,
    nodeId,
    agentId,
    actionScopeId: originalRequest.actionScopeId,
    stableActionId: originalRequest.stableActionId,
    operationId: secondOperation!.operationId as string,
    operation: originalRequest.operation,
  });
  expect(
    again.sent
      .slice(replayStart)
      .some((text) => JSON.parse(text).type === "control.process.operation"),
  ).toBe(false);
  expect(await replay).toMatchObject({ state: "unknown", receipt: { code: 0 } });
  expect(
    db
      .prepare(
        `SELECT state,node_receipt_revision,receipt_json FROM owner_agent_process_operations
    WHERE operation_id=?`,
      )
      .get(secondOperation!.operationId),
  ).toEqual({
    state: "unknown",
    node_receipt_revision: 3,
    receipt_json: JSON.stringify({ code: 0 }),
  });
});
