import { type TestRun } from "../support/agent/tool-run.js";

import { randomUUID } from "node:crypto";

import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

import {
  cleanupFixture,
  setup,
  prepareVerifiedAgent,
  waitForRun,
  callAgentTool,
} from "../support/agent/conversation-fixture.js";
afterEach(cleanupFixture);

it("does not let a member transfer a task to a public-channel non-member", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const memberId = await prepareVerifiedAgent(app, nodeId, "Task owner"),
    outsiderId = await prepareVerifiedAgent(app, nodeId, "Interested onlooker");
  const room = app.chat.createChannel({
    name: "Shared work",
    description: "A public room with a task.",
    visibility: "public",
  });
  app.chat.inviteAgentToChannel(room.id, memberId);
  await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-transfer-key" }),
  });
  // Start the non-member's own run first, from its private DM.
  const outsiderDirect = app.chat.getOrCreateAgentDirectChannel(outsiderId)!,
    outsiderStart = socket.sent.length;
  app.chat.createMessage(outsiderDirect.id, "Start an onlooker run.");
  const outsiderRun = await waitForRun(socket, outsiderStart);

  const memberStart = socket.sent.length;
  const anchor = app.chat.createMessage(room.id, "Review deployment", { asTask: true })!;
  const task = app.chat.tasksForMessage(anchor.id)[0]!;
  const memberRun = await waitForRun(socket, memberStart);

  // The onlooker can read the room, but tasks stay member-only: it neither sees this one
  // nor can it be handed the task, because task visibility did not follow the read widening.
  const claimed = await callAgentTool(app, socket, memberRun, "member-claim", "tools.call", {
    name: "tasks.claim",
    input: { taskId: task.id, expectedVersion: 1 },
  });
  expect(claimed).toMatchObject({ ok: true, result: { ownerAgentId: memberId, version: 2 } });
  const onlookerTasks = await callAgentTool(
    app,
    socket,
    outsiderRun,
    "onlooker-list",
    "tools.call",
    {
      name: "tasks.list",
      input: {},
    },
  );
  expect(onlookerTasks).toMatchObject({ ok: true });
  expect((onlookerTasks.result as { tasks: Array<{ id: string }> }).tasks).toEqual([]);

  const transfer = await callAgentTool(
    app,
    socket,
    memberRun,
    "transfer-to-outsider",
    "tools.call",
    {
      name: "tasks.transfer",
      input: { taskId: task.id, expectedVersion: 2, agentId: outsiderId },
    },
  );
  expect(transfer).toMatchObject({
    ok: false,
    error: "Transfer target is not a conversation member",
  });
  const after = app.chat.readTask(task.id)!;
  expect(after.ownerAgentId).toBe(memberId);
  expect(after.version).toBe(2);
  // The non-member still cannot act on a task it can merely read.
  expect(
    await callAgentTool(app, socket, outsiderRun, "outsider-claim", "tools.call", {
      name: "tasks.claim",
      input: { taskId: task.id, expectedVersion: 2 },
    }),
  ).toMatchObject({ ok: false, error: "Conversation is not available" });
});

it("lets peers coordinate on one task without a tree and preserves a newer claim when the former owner yields", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const firstId = randomUUID(),
    secondId = randomUUID();
  // Both peers run under the node's single ordinary account; only their workspaces differ.
  for (const [id, name] of [
    [firstId, "Peer one"],
    [secondId, "Peer two"],
  ] as const) {
    app.agents.prepare({
      id,
      nodeId,
      name,
      role: "Collaborates directly",
      description: "Synthetic fixture",
      model: { provider: "openai", id: "gpt-4.1" },
    });
    app.agents.complete(
      id,
      {
        username: "mate-node-account",
        uid: 23001,
        gid: 23001,
        workspace: `/var/lib/mate/agents/${id}`,
        workspaceMarker: "a".repeat(64),
      },
      app.chat,
    );
  }
  const room = app.chat.createChannel({
    name: "Shared work",
    description: "",
    visibility: "public",
  });
  expect(app.chat.inviteAgentToChannel(room.id, firstId)).toBe(true);
  expect(app.chat.inviteAgentToChannel(room.id, secondId)).toBe(true);
  await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-peer-key" }),
  });
  const from = socket.sent.length;
  const anchor = app.chat.createMessage(room.id, "Review deployment", { asTask: true })!;
  const task = app.chat.tasksForMessage(anchor.id)[0]!;
  await waitForRun(socket, from);
  let runs: Array<TestRun> = [];
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    runs = socket.sent
      .slice(from)
      .map((text) => JSON.parse(text) as TestRun)
      .filter((value) => value.type === "test.run.started");
    if (runs.some((run) => run.agentId === firstId) && runs.some((run) => run.agentId === secondId))
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const first = runs.find((run) => run.agentId === firstId)!,
    second = runs.find((run) => run.agentId === secondId)!;
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  async function action(
    run: typeof first,
    id: string,
    name: string,
    input: Record<string, unknown>,
  ) {
    return callAgentTool(app, socket, run, id, "tools.call", { name, input });
  }
  expect(
    await action(first, "first-claim", "tasks.claim", { taskId: task.id, expectedVersion: 1 }),
  ).toMatchObject({ ok: true, result: { ownerAgentId: firstId, version: 2 } });
  expect(
    await action(first, "first-yield", "tasks.yield", { taskId: task.id, expectedVersion: 2 }),
  ).toMatchObject({ ok: true, result: { ownerAgentId: null, version: 3 } });
  expect(
    await action(second, "second-claim", "tasks.claim", { taskId: task.id, expectedVersion: 3 }),
  ).toMatchObject({ ok: true, result: { ownerAgentId: secondId, version: 4 } });
  expect(
    await action(first, "late-yield", "tasks.yield", { taskId: task.id, expectedVersion: 2 }),
  ).toMatchObject({ ok: true, result: { ownerAgentId: secondId, version: 5 } });
  expect(
    await action(second, "peer-transfer", "tasks.transfer", {
      taskId: task.id,
      expectedVersion: 5,
      agentId: firstId,
    }),
  ).toMatchObject({ ok: true, result: { ownerAgentId: firstId, version: 6 } });
  expect(app.chat.taskActivity(task.id)).toHaveLength(6);
  expect(app.chat.listMessages(room.id, undefined, 10)?.messages).toHaveLength(1);
});
