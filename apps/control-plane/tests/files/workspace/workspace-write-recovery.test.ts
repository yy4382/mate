import { toolTestInput } from "../../support/agent/tool-run.js";
import { type ModelContextMessage } from "../../../src/runtime/session/record.js";

import { randomUUID } from "node:crypto";

import { afterEach, expect, it, vi } from "vitest";

import {
  cleanupFixture,
  setup,
  waitForRun,
  callAgentTool,
  stableToolActionId,
} from "../../support/agent/conversation-fixture.js";
afterEach(cleanupFixture);

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
      username: "mate-node-account",
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${agentId}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  const channel = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
  await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.messages.createMessage({
    channelId: channel.id,
    text: "Use workspace files and publish the result.",
  });
  const run = await waitForRun(socket, runStart);
  const requests: Array<Record<string, unknown>> = [];
  const nodeReceipts = new Map<
    string,
    { code: number; stdout: string; stderr: string; truncated: boolean }
  >();
  let heldRequest: Record<string, unknown> | undefined;
  let holdNextResponse = false;
  let failNextResponse = false;
  let expectedActionId: string | undefined;
  let executingEnvelope: unknown;
  socket.onWorkspaceOperation = async (message) => {
    requests.push(message);
    const operationId = String(message.operationId),
      existingReceipt = nodeReceipts.get(operationId);
    if (existingReceipt) {
      if (!holdNextResponse)
        await toolTestInput(
          app,
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
    await toolTestInput(
      app,
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
  const safeActivity = await app.http.request(`/api/owner/agents/${agentId}/activity`, {
    headers: { cookie },
  });
  expect(await safeActivity.text()).not.toContain("hello");
  const detailedActivity = await app.http.request(
    `/api/owner/agents/${agentId}/activity?detail=1`,
    {
      headers: { cookie },
    },
  );
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

  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "run.complete",
      requestId: randomUUID(),
      runId: run.runId,
      agentId,
      ok: true,
    }),
  );
  const lateReceipt = nodeReceipts.get(String(heldRequest!.operationId))!;
  const correctedStart = socket.sent.length;
  const unavailableNotification = vi
    .spyOn(app.chat.messages, "notifyAgentReceiptCorrection")
    .mockImplementation(() => {
      throw new Error("crash before notification commit");
    });
  await toolTestInput(
    app,
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
  await toolTestInput(
    app,
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
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "session.read",
      requestId: randomUUID(),
      runId: correctedRun.runId,
      agentId,
      cursor: 0,
      limit: 100,
    }),
  );
  const correctedContext = JSON.parse(socket.sent.at(-1)!) as { messages: ModelContextMessage[] };
  expect(
    correctedContext.messages.some(
      (entry) =>
        JSON.stringify(entry.message.content).includes("workspace.write") &&
        JSON.stringify(entry.message.content).includes("receipt-2"),
    ),
  ).toBe(true);
  const correctedActivity = db
    .prepare(
      "SELECT COUNT(*) AS count FROM owner_agent_activity WHERE reference_id=? AND kind='receipt.corrected'",
    )
    .get(heldRequest!.operationId) as { count: number };
  expect(correctedActivity.count).toBe(1);
  await toolTestInput(
    app,
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
  await toolTestInput(
    app,
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
  };
  const immediateFailureId = stableToolActionId(correctedRun.actionScopeId, immediateFailureInput);
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
