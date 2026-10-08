import { toolTestInput } from "../support/agent/tool-run.js";

import { randomUUID } from "node:crypto";

import { afterEach, expect, it } from "vitest";

import {
  cleanupFixture,
  setup,
  pairAnotherNode,
  waitForRun,
  callAgentTool,
} from "../support/agent/conversation-fixture.js";
afterEach(cleanupFixture);

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
      username: "mate-node-account",
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${agentId}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  const direct = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
  await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.messages.createMessage({ channelId: direct.id, text: "Start retryable tool action." });
  const firstRun = await waitForRun(socket, runStart);
  const actionId = "retry-after-lost-tool-result";
  const input = {
    name: "messages.send",
    input: { conversationId: direct.id, text: "提交一次，即使回执丢失也不重复。" },
  };
  socket.dropToolCallId = actionId;
  const sentBeforeToolCall = socket.sent.length;
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "tools.execute",
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
    app.chat.timeline
      .listMessages(direct.id, undefined, 100)!
      .messages.filter((message) => message.text === input.input.text),
  ).toHaveLength(1);

  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "run.complete",
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
    app.chat.timeline
      .listMessages(direct.id, undefined, 100)!
      .messages.filter((message) => message.text === input.input.text),
  ).toHaveLength(1);
  expect(
    db
      .prepare("SELECT count(*) AS count FROM owner_agent_tool_actions WHERE session_id=?")
      .get(firstRun.sessionId),
  ).toEqual({ count: 1 });
});

it("keeps a running Agent's tool catalogue and refuses stale or forged tool runs", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Tool caller",
    role: "Calls shared conversation tools",
    description: "Synthetic tool fixture.",
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
  const direct = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
  await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.messages.createMessage({ channelId: direct.id, text: "Start a tool-call run." });
  const run = await waitForRun(socket, runStart);

  const listed = await callAgentTool(app, socket, run, "normal-tools-list", "tools.list", {});
  expect(listed).toMatchObject({
    ok: true,
    result: {
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "conversations.list" }),
        expect.objectContaining({ name: "process.exec" }),
      ]),
    },
  });
  const directCall = await callAgentTool(app, socket, run, "normal-direct-call", "tools.call", {
    name: "conversations.list",
    input: {},
  });
  expect(directCall).toMatchObject({ ok: true });
  expect(
    (directCall.result as { conversations: Array<{ id: string }> }).conversations.some(
      (conversation) => conversation.id === direct.id,
    ),
  ).toBe(true);

  const otherNode = await pairAnotherNode(app, cookie);
  const forgedNode = await callAgentTool(
    app,
    otherNode.socket,
    run,
    "forged-node-call",
    "tools.call",
    {
      name: "messages.send",
      input: { conversationId: direct.id, text: "Forged node must not send." },
    },
  );
  expect(forgedNode).toMatchObject({ type: "tools.result", ok: false });
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
  expect(forgedAgent).toMatchObject({
    type: "tools.result",
    ok: false,
    error: "Agent run is no longer active",
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
  const stale = await callAgentTool(app, socket, run, "stale-call", "tools.call", {
    name: "conversations.list",
    input: {},
  });
  expect(stale).toMatchObject({ ok: false, error: "Agent run is no longer active" });
  expect(
    app.chat.timeline
      .listMessages(direct.id, undefined, 100)!
      .messages.map((message) => message.text),
  ).not.toContain("Forged node must not send.");
});
