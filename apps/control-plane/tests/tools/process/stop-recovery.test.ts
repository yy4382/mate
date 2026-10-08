import { toolTestInput } from "../../support/agent/tool-run.js";
import { AgentSession } from "../../../src/runtime/session/service.js";

import { randomUUID, sign } from "node:crypto";

import { afterEach, expect, it } from "vitest";

import {
  cleanupFixture,
  FakeNodeSocket,
  setup,
  waitForRun,
  waitFor,
} from "../../support/agent/process-tool-fixture.js";
afterEach(cleanupFixture);

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
  const direct = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
  await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-key" }),
  });
  const start = socket.sent.length;
  app.chat.messages.createMessage({ channelId: direct.id, text: "Start a command." });
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
