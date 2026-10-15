import { toolTestInput } from "../support/agent/tool-run.js";

import { afterEach, expect, it } from "vitest";
import { z } from "zod";

import {
  cleanupAgentToolFixture,
  createAgentToolFixture,
  authorizeModel,
  addAgent,
  waitForRuns,
} from "../support/agent/agent-tool-fixture.js";

it("maps storage exceptions once and rolls back conversation effects", async () => {
  const { app, cookie, db, nodeId, socket } = await createAgentToolFixture();
  const agentId = addAgent(app, nodeId, "Storage failure");
  const direct = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
  await authorizeModel(app, cookie);
  app.chat.messages.createMessage({
    channelId: direct.id,
    text: "A storage failure must not half-send.",
  });
  const run = (await waitForRuns(socket, 0, [agentId])).get(agentId)!;
  const identity = { runId: run.runId, nodeId, agentId, toolCallId: "storage-failure" };
  const before = app.chat.timeline.listMessages(direct.id, undefined, 50);
  db.exec(
    "CREATE TRIGGER tool_storage_failure BEFORE INSERT ON owner_agent_tool_actions BEGIN SELECT RAISE(ABORT, 'synthetic persistence failure'); END",
  );
  expect(
    await app.tools.execute(identity, "tools.call", {
      name: "messages.send",
      input: { conversationId: direct.id, text: "Must roll back" },
    }),
  ).toEqual({ ok: false, error: "Agent tool request was refused" });
  expect(app.chat.timeline.listMessages(direct.id, undefined, 50)).toEqual(before);
  db.exec("DROP TRIGGER tool_storage_failure");
  expect(
    await app.tools.execute(identity, "tools.call", {
      name: "messages.send",
      input: { conversationId: direct.id, text: "Must roll back" },
    }),
  ).toMatchObject({ ok: true, result: { text: "Must roll back" } });
});

it("refuses every registered operation and meta tool for ended, absent and another Agent's runs before any effect", async () => {
  const { app, cookie, db, nodeId, socket } = await createAgentToolFixture();
  const agentId = addAgent(app, nodeId, "Current-run caller");
  const otherAgentId = addAgent(app, nodeId, "Other Agent");
  const direct = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
  const message = app.chat.messages.createMessage({
    channelId: direct.id,
    text: "Exercise the complete registry.",
  })!;
  await authorizeModel(app, cookie);
  const run = (await waitForRuns(socket, 0, [agentId])).get(agentId)!;
  const identity = {
    runId: run.runId,
    nodeId,
    agentId,
    toolCallId: `mate:${run.actionScopeId}:${"b".repeat(64)}:1`,
  };
  const listed = await app.tools.execute(identity, "tools.list", {});
  expect(listed.ok).toBe(true);
  if (!listed.ok) throw new Error(listed.error);
  const names = (listed.result as { tools: Array<{ name: string }> }).tools.map(
    (tool) => tool.name,
  );
  const id = message.id;
  const conversationId = direct.id;
  const task = { taskId: id, expectedVersion: 1 };
  const reminder = { reminderId: id, expectedVersion: 1 };
  const inputs: Record<string, Record<string, unknown>> = {
    spawn_agent: { task_name: "refused", message: "Must not start" },
    list_agents: {},
    send_message: { target: "helper", message: "Must not send" },
    followup_task: { target: "helper", message: "Must not start" },
    interrupt_agent: { target: "helper" },
    wait_agent: { timeout_ms: 1 },
    "agents.list": {},
    "conversations.list": {},
    "conversations.read": { conversationId },
    "conversations.read_thread": { conversationId, rootId: id },
    "conversations.open_dm": { targetAgentId: otherAgentId },
    "conversations.join": { conversationId },
    "conversations.invite": { conversationId, agentId: otherAgentId },
    "attention.list": { conversationId },
    "attention.update": { conversationId, messageId: id, seen: true },
    "drafts.save": { conversationId, text: "Draft" },
    "drafts.review": { draftId: id, choice: "inspect" },
    "messages.send": { conversationId, text: "Must not be sent" },
    "tasks.create": { messageId: id, title: "明确任务" },
    "tasks.claim": task,
    "tasks.yield": task,
    "tasks.transfer": { ...task, agentId: otherAgentId },
    "tasks.update": { ...task, status: "done" },
    "tasks.review": { draftId: id, choice: "inspect" },
    "tasks.list": {},
    "reminders.create": { conversationId, text: "Reminder", dueAt: Date.now() + 60_000 },
    "reminders.reschedule": { ...reminder, dueAt: Date.now() + 60_000 },
    "reminders.cancel": reminder,
    "reminders.list": {},
    "workspace.list": { path: "." },
    "workspace.stat": { path: "." },
    "workspace.read": { path: "notes.txt" },
    "workspace.read_chunk": { path: "notes.txt", offset: 0 },
    "workspace.write": { path: "notes.txt", content: "No write" },
    "workspace.write_bytes": { path: "notes.txt", base64: "aGk=" },
    "workspace.edit": {
      path: "notes.txt",
      expectedHash: "a".repeat(64),
      oldText: "hi",
      newText: "bye",
    },
    "workspace.mkdir": { path: "dir" },
    "workspace.move": { path: "notes.txt", destination: "other.txt" },
    "workspace.remove": { path: "notes.txt" },
    "attachments.list": { conversationId },
    "attachments.read_chunk": { conversationId, attachmentId: id, offset: 0 },
    "attachments.publish": { conversationId, path: "notes.txt" },
    "process.exec": { command: "printf no" },
    "process.list": {},
    "process.inspect": { targetOperationId: id },
    "process.stop": { targetOperationId: id },
    "history.search": { query: "past observation" },
    "history.read": { id },
  };
  expect(Object.keys(inputs).sort()).toEqual([...names].sort());
  for (const name of names) {
    const described = await app.tools.execute(identity, "tools.describe", { name });
    if (!described.ok) throw new Error(described.error);
    const { inputSchema } = described.result as { inputSchema: z.core.JSONSchema.JSONSchema };
    expect(z.fromJSONSchema(inputSchema).safeParse(inputs[name]).success, name).toBe(true);
  }
  // A successful synchronous action also supplies a cached result which old runs must not receive.
  const cached = await app.tools.execute(identity, "tools.call", {
    name: "messages.send",
    input: inputs["messages.send"],
  });
  expect(cached).toMatchObject({ ok: true });
  for (const candidate of [
    { ...identity, agentId: otherAgentId },
    { ...identity, runId: "0f3a72f0-7b96-4110-b9bb-6892a477aee8" },
    identity,
  ]) {
    if (candidate === identity) {
      await toolTestInput(
        app,
        socket,
        JSON.stringify({
          type: "run.complete",
          requestId: crypto.randomUUID(),
          runId: run.runId,
          agentId,
          ok: true,
        }),
      );
    }
    const before = db.serialize();
    const sent = socket.sent.length;
    for (const name of names) {
      expect(
        await app.tools.execute(candidate, "tools.call", { name, input: inputs[name] }),
        name,
      ).toEqual({ ok: false, error: "Agent run is no longer active" });
      expect(await app.tools.execute(candidate, "tools.describe", { name }), name).toEqual({
        ok: false,
        error: "Agent run is no longer active",
      });
    }
    expect(await app.tools.execute(candidate, "tools.list", {})).toEqual({
      ok: false,
      error: "Agent run is no longer active",
    });
    expect(socket.sent).toHaveLength(sent);
    expect(db.serialize()).toEqual(before);
  }
});

it("admits only prepared Agents and lifecycle requests cannot change their node or regress their preparation", async () => {
  const { app, cookie, nodeId, socket } = await createAgentToolFixture();
  const agentId = crypto.randomUUID();
  const request = {
    id: agentId,
    nodeId,
    name: "Preparation lifecycle",
    role: "Waits for workspace",
    description: "Synthetic fixture",
    model: { provider: "openai" as const, id: "gpt-4.1" },
  };
  app.agents.prepare(request);
  await authorizeModel(app, cookie);
  app.runs?.wake();
  expect(app.chat.conversations.getOrCreateAgentDirectChannel(agentId)).toBeUndefined();
  expect(
    socket.sent
      .map((text) => JSON.parse(text))
      .filter((message) => message.type === "test.run.started"),
  ).toEqual([]);
  expect(
    await app.tools.execute(
      { agentId, nodeId, runId: crypto.randomUUID(), toolCallId: "not-prepared" },
      "tools.list",
      {},
    ),
  ).toEqual({ ok: false, error: "Agent run is no longer active" });
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
  app.chat.messages.createMessage({ channelId: direct.id, text: "Now the workspace is ready." });
  const run = (await waitForRuns(socket, 0, [agentId])).get(agentId)!;
  app.agents.updateStage(agentId, "preparing_workspace");
  app.agents.fail(agentId, "Late preparation failure");
  expect(() => app.agents.prepare({ ...request, nodeId: crypto.randomUUID() })).toThrow();
  expect(app.agents.get(agentId)).toMatchObject({ stage: "complete", nodeId });
  expect(
    await app.tools.execute(
      { agentId, nodeId, runId: run.runId, toolCallId: "ready" },
      "tools.list",
      {},
    ),
  ).toMatchObject({ ok: true });
});

afterEach(cleanupAgentToolFixture);
