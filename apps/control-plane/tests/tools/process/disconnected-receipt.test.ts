import { toolTestInput } from "../../support/agent/tool-run.js";

import { assistantEntry } from "../../support/agent/session.js";

import { randomUUID, sign } from "node:crypto";

import { afterEach, expect, it } from "vitest";

import {
  cleanupFixture,
  FakeNodeSocket,
  setup,
  waitForRun,
  sendTool,
} from "../../support/agent/process-tool-fixture.js";
afterEach(cleanupFixture);

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
