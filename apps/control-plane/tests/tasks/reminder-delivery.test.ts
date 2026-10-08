import { toolTestApp, toolTestInput } from "../support/agent/tool-run.js";

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

import {
  password,
  fixtures,
  cleanupFixture,
  createConversationFixture,
  reconnectNode,
  waitForRun,
  callAgentTool,
  startReminderFixture,
} from "../support/agent/conversation-fixture.js";
afterEach(cleanupFixture);

it("holds Agent task changes for fresh discussion and queues an offline reminder without marking it handled", async () => {
  const { app, cookie, nodeId, socket, db } = await createConversationFixture();
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
      username: "mate-node-account",
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${agentId}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  const dm = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
  await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-task-key" }),
  });
  const from = socket.sent.length;
  const anchor = app.chat.messages.createMessage({
    channelId: dm.id,
    text: "Investigate the alert",
    asTask: true,
  })!;
  const task = app.chat.tasks.tasksForMessage(anchor.id)[0]!;
  const run = await waitForRun(socket, from);
  const changedMessage = app.chat.messages.createMessage({
    channelId: dm.id,
    text: "Please include the restart case",
  })!;
  async function tool(id: string, name: string, input: Record<string, unknown>) {
    return callAgentTool(app, socket, run, id, "tools.call", { name, input });
  }
  const held = await tool("claim-held", "tasks.claim", { taskId: task.id, expectedVersion: 1 });
  expect(held).toMatchObject({ ok: true, result: { status: "needs_review" } });
  expect(app.chat.attention.listAgentAttention(agentId, dm.id)).toEqual(
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
  expect(app.chat.tasks.readTask(task.id)).toMatchObject({ ownerAgentId: null, version: 1 });
  expect(app.chat.tasks.taskActivity(task.id)).toHaveLength(1);
  const draftId = (held.result as { draftId: string }).draftId;
  expect((await tool("claim-keep", "tasks.review", { draftId, choice: "keep" })).ok).toBe(true);
  expect((await tool("claim-continue", "tasks.review", { draftId, choice: "continue" })).ok).toBe(
    true,
  );
  const lateChange = app.chat.messages.createMessage({
    channelId: dm.id,
    text: "A newer decision arrived",
  })!;
  expect(
    await tool("claim-stale", "tasks.claim", { taskId: task.id, expectedVersion: 1, draftId }),
  ).toMatchObject({ ok: false, error: "Conversation changed; review the task draft again" });
  expect(app.chat.tasks.readTask(task.id)).toMatchObject({ ownerAgentId: null, version: 1 });
  await tool("claim-inspect-late", "tasks.review", { draftId, choice: "inspect" });
  expect(app.chat.attention.listAgentAttention(agentId, dm.id)).toEqual(
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
  expect(app.chat.tasks.taskActivity(task.id)).toHaveLength(2);
  expect(app.chat.timeline.listMessages(dm.id, undefined, 100)?.messages).toHaveLength(3);
  const updated = await tool("update-direct", "tasks.update", {
    taskId: task.id,
    expectedVersion: 2,
    status: "done",
    note: "Verified after restart",
  });
  expect(updated).toMatchObject({ ok: true, result: { status: "done", version: 3 } });
  const taskSource = app.chat.messages.createMessage({
    channelId: dm.id,
    text: "A separate new task",
  })!;
  const createHeld = await tool("create-held", "tasks.create", {
    messageId: taskSource.id,
    title: taskSource.text,
  });
  expect(createHeld.error).toBeUndefined();
  expect(createHeld).toMatchObject({ ok: true, result: { status: "needs_review" } });
  const createDraft = (createHeld.result as { draftId: string }).draftId;
  await tool("create-keep", "tasks.review", { draftId: createDraft, choice: "keep" });
  await tool("create-continue", "tasks.review", { draftId: createDraft, choice: "continue" });
  expect(
    await tool("create-applied", "tasks.create", {
      messageId: taskSource.id,
      title: taskSource.text,
      draftId: createDraft,
    }),
  ).toMatchObject({
    ok: true,
    result: { status: "created", task: { messageId: taskSource.id, title: taskSource.text } },
  });
  expect(
    await tool("create-applied", "tasks.create", {
      messageId: taskSource.id,
      title: "不同请求",
      draftId: createDraft,
    }),
  ).toMatchObject({ ok: false, error: "Action ID was already used for a different request" });
  const inaccessible = app.chat.channels.createChannel({
    name: "Private",
    description: "",
    visibility: "private",
  });
  const secret = app.chat.messages.createMessage({
    channelId: inaccessible.id,
    text: "Secret task",
    asTask: true,
  })!;
  expect(
    await tool("secret-claim", "tasks.claim", {
      taskId: app.chat.tasks.tasksForMessage(secret.id)[0]!.id,
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
  app.chat.reminders.fireDueReminders();
  const reminders = app.chat.reminders.listAgentReminders(agentId);
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
  expect(app.chat.deliveries.acknowledgeDelivery(delivery.id, "agent", agentId)).toBe(false);
  expect(delivery.state).toBe("pending");
  expect(app.chat.timeline.listMessages(dm.id, undefined, 100)?.messages).toHaveLength(4);
  app.close();
  const restarted = toolTestApp({
    dataDir: join(fixtures.at(-1)!.directory, "control-plane"),
    passwordFile: join(fixtures.at(-1)!.directory, "owner-password"),
  });
  fixtures.push({
    app: restarted,
    directory: fixtures.at(-1)!.directory,
    db: new Database(join(fixtures.at(-1)!.directory, "control-plane", "control-plane.sqlite")),
  });
  expect(restarted.chat.reminders.listAgentReminders(agentId)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: reminderId,
        state: "fired",
        firing: { firedAt: expect.any(Number), handledAt: null },
      }),
    ]),
  );
});

it("marks a reminder handled when a preceding DM delivery starts the completed batch", async () => {
  const fixture = await createConversationFixture();
  const { app, nodeId, socket, nodePrivateKey, db } = fixture;
  const { agentId, dm, reminderId } = await startReminderFixture(fixture);
  app.nodes.close(socket);
  const ordinary = app.chat.messages.createMessage({
    channelId: dm.id,
    text: "An earlier offline message",
  })!;
  await new Promise((resolve) => setTimeout(resolve, 280));
  app.chat.reminders.fireDueReminders();
  const pending = app.chat.deliveries.listPendingDeliveries("agent", agentId).deliveries;
  expect(pending).toHaveLength(2);
  expect(pending[0]?.messageId).toBe(ordinary.id);
  const reconnected = await reconnectNode(app, nodeId, nodePrivateKey);
  const run = await waitForRun(reconnected, 0);
  const seed = db.prepare("SELECT delivery_id FROM owner_agent_runs WHERE id=?").get(run.runId) as {
    delivery_id: string;
  };
  expect(seed.delivery_id).toBe(pending[0]?.id);
  await toolTestInput(
    app,
    reconnected,
    JSON.stringify({
      type: "run.complete",
      requestId: run.runId,
      runId: run.runId,
      agentId,
      ok: true,
    }),
  );
  expect(app.chat.deliveries.listPendingDeliveries("agent", agentId).deliveries).toHaveLength(0);
  app.chat.reminders.syncHandledReminders();
  expect(app.chat.reminders.listAgentReminders(agentId)[0]).toMatchObject({
    id: reminderId,
    firing: { handledAt: expect.any(Number) },
  });
});
