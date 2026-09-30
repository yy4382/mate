import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/http.js";
import {
  setup,
  authorizeModel,
  addAgent,
  waitForRuns,
  type FakeNodeSocket,
} from "../helpers/agent-tool-fixture.js";
async function tool(
  app: ReturnType<typeof createControlPlaneApp>,
  _socket: FakeNodeSocket,
  run: { runId: string; agentId: string },
  toolCallId: string,
  name: string,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return app.tools.execute(
    { ...run, nodeId: app.agents.get(run.agentId)!.nodeId, toolCallId },
    "tools.call",
    { name, input },
  );
}

function taskIdOf(outcome: unknown): string {
  return (outcome as { task: { id: string } }).task.id;
}

it("creates and claims the one task for a readable top-level message and refuses to preempt its owner", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const first = addAgent(app, nodeId, "Peer 23001"),
    second = addAgent(app, nodeId, "Peer 23002");
  const room = app.chat.createChannel({
    name: "Shared work",
    description: "",
    visibility: "public",
  });
  expect(app.chat.inviteAgentToChannel(room.id, first)).toBe(true);
  expect(app.chat.inviteAgentToChannel(room.id, second)).toBe(true);
  await authorizeModel(app, cookie);
  const from = socket.sent.length;
  const anchor = app.chat.createMessage(room.id, "Review the deployment")!;
  const runs = await waitForRuns(socket, from, [first, second]);

  const claimed = await tool(app, socket, runs.get(first)!, "first-claim", "tasks.claim_message", {
    messageId: anchor.id,
  });
  expect(claimed).toMatchObject({
    ok: true,
    result: {
      outcome: "claimed",
      created: true,
      messageId: anchor.id,
      channelId: room.id,
      task: {
        messageId: anchor.id,
        channelId: room.id,
        title: "Review the deployment",
        ownerAgentId: first,
        ownerAgentName: "Peer 23001",
        status: "in_progress",
        version: 1,
      },
    },
  });
  const taskId = taskIdOf(claimed.result);

  const conflicted = await tool(
    app,
    socket,
    runs.get(second)!,
    "second-claim",
    "tasks.claim_message",
    {
      messageId: anchor.id,
    },
  );
  expect(conflicted).toMatchObject({
    ok: true,
    result: {
      outcome: "conflict",
      created: false,
      messageId: anchor.id,
      task: {
        id: taskId,
        ownerAgentId: first,
        ownerAgentName: "Peer 23001",
        status: "in_progress",
        version: 1,
      },
    },
  });

  // One canonical task and one owner, and the anchor stays unique in the schema itself.
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS tasks,COUNT(DISTINCT owner_agent_id) AS owners FROM owner_tasks WHERE message_id=?",
      )
      .get(anchor.id),
  ).toEqual({ tasks: 1, owners: 1 });
  expect(() =>
    db
      .prepare(
        "INSERT INTO owner_tasks(id,message_id,title,status,created_at,updated_at) VALUES(?,?,?,'open',1,1)",
      )
      .run(randomUUID(), anchor.id, "Duplicate"),
  ).toThrow(/UNIQUE/);

  // Repeating the call for a task you already own neither duplicates nor churns it.
  expect(
    await tool(app, socket, runs.get(first)!, "first-claim-again", "tasks.claim_message", {
      messageId: anchor.id,
    }),
  ).toMatchObject({
    ok: true,
    result: {
      outcome: "claimed",
      created: false,
      task: { id: taskId, ownerAgentId: first, version: 1 },
    },
  });
  expect(app.chat.readTask(taskId)).toMatchObject({
    ownerAgentId: first,
    status: "in_progress",
    version: 1,
  });

  // Neither a self-transfer nor a peer transfer can replace the owner of record.
  expect(
    await tool(app, socket, runs.get(first)!, "owner-self-transfer", "tasks.transfer", {
      taskId,
      expectedVersion: 1,
      agentId: first,
    }),
  ).toMatchObject({ ok: false, error: "Task is already yours" });
  expect(app.chat.readTask(taskId)).toMatchObject({ ownerAgentId: first, version: 1 });

  // Finishing stays with the existing task tools and has no review stage.
  expect(
    await tool(app, socket, runs.get(first)!, "owner-done", "tasks.update", {
      taskId,
      expectedVersion: 1,
      status: "done",
      note: "Deployed and verified",
    }),
  ).toMatchObject({ ok: true, result: { status: "done", ownerAgentId: first, version: 2 } });
  const board = await app.request("/api/owner/tasks", { headers: { cookie } });
  expect(((await board.json()) as { tasks: Array<Record<string, unknown>> }).tasks).toEqual([
    expect.objectContaining({ id: taskId, status: "done", ownerAgentId: first }),
  ]);

  // The Agent that lost the claim still reads, discusses and offers non-conflicting help.
  expect(
    await tool(app, socket, runs.get(second)!, "peer-read", "conversations.read", {
      conversationId: room.id,
      limit: 10,
    }),
  ).toMatchObject({ ok: true, result: { messages: [expect.objectContaining({ id: anchor.id })] } });
  expect(
    await tool(app, socket, runs.get(second)!, "peer-help", "messages.send", {
      conversationId: room.id,
      text: "I will check the logs meanwhile",
    }),
  ).toMatchObject({ ok: true });
  expect(
    await tool(app, socket, runs.get(second)!, "peer-retry-claim", "tasks.claim_message", {
      messageId: anchor.id,
    }),
  ).toMatchObject({
    ok: true,
    result: {
      outcome: "conflict",
      task: { id: taskId, ownerAgentId: first, status: "done", version: 2 },
    },
  });
  expect(app.chat.readTask(taskId)).toMatchObject({ ownerAgentId: first, status: "done" });
  expect(
    await tool(app, socket, runs.get(second)!, "peer-seize-transfer", "tasks.transfer", {
      taskId,
      expectedVersion: 2,
      agentId: second,
    }),
  ).toMatchObject({ ok: false, error: "Only the current owner can transfer this task" });
  expect(app.chat.readTask(taskId)).toMatchObject({
    ownerAgentId: first,
    status: "done",
    version: 2,
  });
  expect(app.chat.taskActivity(taskId).map((event) => (event as { kind: string }).kind)).toEqual([
    "created",
    "claim",
    "update",
  ]);
  expect(
    app.chat
      .taskActivity(taskId)
      .filter((event) => (event as { actorId: string }).actorId === second),
  ).toEqual([]);
});

it("anchors a claim made from a thread reply on the original top-level message", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const first = addAgent(app, nodeId, "Peer 23001"),
    second = addAgent(app, nodeId, "Peer 23002");
  const room = app.chat.createChannel({
    name: "Threaded work",
    description: "",
    visibility: "public",
  });
  expect(app.chat.inviteAgentToChannel(room.id, first)).toBe(true);
  expect(app.chat.inviteAgentToChannel(room.id, second)).toBe(true);
  await authorizeModel(app, cookie);
  const from = socket.sent.length;
  const top = app.chat.createMessage(room.id, "Deploy v2")!;
  const runs = await waitForRuns(socket, from, [first, second]);
  const reply = app.chat.createMessage(room.id, "Include the restart case", { rootId: top.id })!;

  expect(
    await tool(app, socket, runs.get(first)!, "thread-read", "conversations.read_thread", {
      conversationId: room.id,
      rootId: top.id,
    }),
  ).toMatchObject({ ok: true });
  const claimed = await tool(app, socket, runs.get(first)!, "reply-claim", "tasks.claim_message", {
    messageId: reply.id,
  });
  expect(claimed).toMatchObject({
    ok: true,
    result: {
      outcome: "claimed",
      created: true,
      messageId: top.id,
      task: { messageId: top.id, title: "Deploy v2", ownerAgentId: first },
    },
  });
  expect(app.chat.taskForMessage(reply.id)).toBeUndefined();
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS tasks FROM owner_tasks t JOIN owner_messages m ON m.id=t.message_id WHERE m.channel_id=?",
      )
      .get(room.id),
  ).toEqual({ tasks: 1 });

  expect(
    await tool(app, socket, runs.get(second)!, "top-read", "conversations.read_thread", {
      conversationId: room.id,
      rootId: top.id,
    }),
  ).toMatchObject({ ok: true });
  expect(
    await tool(app, socket, runs.get(second)!, "top-claim", "tasks.claim_message", {
      messageId: top.id,
    }),
  ).toMatchObject({
    ok: true,
    result: { outcome: "conflict", messageId: top.id, task: { ownerAgentId: first } },
  });
});

it("claims the task already anchored on the named reply instead of a second task", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = addAgent(app, nodeId, "Thread partner");
  const room = app.chat.createChannel({
    name: "Threaded work",
    description: "",
    visibility: "public",
  });
  expect(app.chat.inviteAgentToChannel(room.id, agentId)).toBe(true);
  await authorizeModel(app, cookie);
  const from = socket.sent.length;
  app.chat.createMessage(room.id, "Kickoff");
  const run = (await waitForRuns(socket, from, [agentId])).get(agentId)!;
  const top = app.chat.createMessage(room.id, "Deploy v3")!;
  const reply = app.chat.createMessage(room.id, "Include the restart case", {
    rootId: top.id,
    asTask: true,
  })!;
  const replyTask = app.chat.taskForMessage(reply.id)!;
  expect(
    await tool(app, socket, run, "reply-read", "conversations.read_thread", {
      conversationId: room.id,
      rootId: top.id,
    }),
  ).toMatchObject({ ok: true });

  expect(
    await tool(app, socket, run, "reply-claim", "tasks.claim_message", { messageId: reply.id }),
  ).toMatchObject({
    ok: true,
    result: {
      outcome: "claimed",
      created: false,
      messageId: reply.id,
      task: { id: replyTask.id, ownerAgentId: agentId, status: "in_progress", version: 2 },
    },
  });
  expect(app.chat.taskForMessage(top.id)).toBeUndefined();
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS tasks FROM owner_tasks t JOIN owner_messages m ON m.id=t.message_id WHERE m.channel_id=?",
      )
      .get(room.id),
  ).toEqual({ tasks: 1 });
});

it("refuses to take a claim that a peer committed while the Agent was reviewing", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = addAgent(app, nodeId, "Reviewing peer"),
    peerId = addAgent(app, nodeId, "Fast peer");
  const room = app.chat.createChannel({
    name: "Shared work",
    description: "",
    visibility: "public",
  });
  expect(app.chat.inviteAgentToChannel(room.id, agentId)).toBe(true);
  expect(app.chat.inviteAgentToChannel(room.id, peerId)).toBe(true);
  await authorizeModel(app, cookie);
  const from = socket.sent.length;
  const anchor = app.chat.createMessage(room.id, "Investigate the alert", { asTask: true })!;
  const task = app.chat.taskForMessage(anchor.id)!;
  const run = (await waitForRuns(socket, from, [agentId])).get(agentId)!;

  app.chat.createMessage(room.id, "Please include the restart case");
  const held = await tool(app, socket, run, "claim-held", "tasks.claim_message", {
    messageId: anchor.id,
  });
  const draftId = (held.result as { draftId: string }).draftId;
  await tool(app, socket, run, "claim-keep", "tasks.review", { draftId, choice: "keep" });
  await tool(app, socket, run, "claim-continue", "tasks.review", { draftId, choice: "continue" });

  // The peer's claim commits between this Agent's review and its apply.
  db.prepare(
    "UPDATE owner_tasks SET owner_agent_id=?,status='in_progress',version=version+1,updated_at=? WHERE id=?",
  ).run(peerId, 1, task.id);
  expect(
    await tool(app, socket, run, "claim-after-race", "tasks.claim_message", {
      messageId: anchor.id,
      draftId,
    }),
  ).toMatchObject({
    ok: true,
    result: {
      outcome: "conflict",
      created: false,
      task: { id: task.id, ownerAgentId: peerId, status: "in_progress", version: 2 },
    },
  });
  expect(app.chat.readTask(task.id)).toMatchObject({ ownerAgentId: peerId, version: 2 });
  expect(
    db.prepare("SELECT COUNT(*) AS tasks FROM owner_tasks WHERE message_id=?").get(anchor.id),
  ).toEqual({ tasks: 1 });
});

it("scopes a claim made from a reply like the top-level task it claims", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = addAgent(app, nodeId, "Thread partner");
  const room = app.chat.createChannel({
    name: "Threaded work",
    description: "",
    visibility: "public",
  });
  expect(app.chat.inviteAgentToChannel(room.id, agentId)).toBe(true);
  await authorizeModel(app, cookie);
  const from = socket.sent.length;
  const anchor = app.chat.createMessage(room.id, "Investigate the alert", { asTask: true })!;
  const task = app.chat.taskForMessage(anchor.id)!;
  const run = (await waitForRuns(socket, from, [agentId])).get(agentId)!;
  const reply = app.chat.createMessage(room.id, "Thread detail", { rootId: anchor.id })!;
  const channelChange = app.chat.createMessage(room.id, "A separate top-level decision")!;

  expect(
    await tool(app, socket, run, "thread-read", "conversations.read_thread", {
      conversationId: room.id,
      rootId: anchor.id,
    }),
  ).toMatchObject({ ok: true });
  // The task is anchored on the top-level message, so a claim from its reply answers to the same
  // discussion: the unseen top-level change is surfaced instead of being applied silently.
  expect(
    await tool(app, socket, run, "reply-claim", "tasks.claim_message", { messageId: reply.id }),
  ).toMatchObject({
    ok: true,
    result: {
      status: "needs_review",
      changes: [expect.objectContaining({ id: channelChange.id })],
    },
  });
  expect(app.chat.readTask(task.id)).toMatchObject({ ownerAgentId: null, version: 1 });

  const draftId = (
    (await tool(app, socket, run, "reply-claim", "tasks.claim_message", {
      messageId: reply.id,
    })) as { result: { draftId: string } }
  ).result.draftId;
  await tool(app, socket, run, "reply-keep", "tasks.review", { draftId, choice: "keep" });
  await tool(app, socket, run, "reply-continue", "tasks.review", { draftId, choice: "continue" });
  const later = app.chat.createMessage(room.id, "Another top-level decision")!;
  // The apply is re-checked at the same position, so a change that lands after the review is
  // surfaced instead of being passed over by the narrower thread position.
  expect(
    await tool(app, socket, run, "reply-apply-stale", "tasks.claim_message", {
      messageId: reply.id,
      draftId,
    }),
  ).toMatchObject({ ok: false, error: "Conversation changed; review the task draft again" });
  expect(app.chat.readTask(task.id)).toMatchObject({ ownerAgentId: null, version: 1 });
  await tool(app, socket, run, "reply-inspect-late", "tasks.review", {
    draftId,
    choice: "inspect",
  });
  await tool(app, socket, run, "reply-continue-late", "tasks.review", {
    draftId,
    choice: "continue",
  });
  expect(
    await tool(app, socket, run, "reply-apply", "tasks.claim_message", {
      messageId: reply.id,
      draftId,
    }),
  ).toMatchObject({
    ok: true,
    result: { outcome: "claimed", created: false, task: { id: task.id, ownerAgentId: agentId } },
  });
  expect(app.chat.readTask(task.id)).toMatchObject({
    ownerAgentId: agentId,
    status: "in_progress",
  });
  expect(app.chat.taskForMessage(later.id)).toBeUndefined();
});

it("holds a direct claim for fresh discussion and keeps the existing draft choices", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = addAgent(app, nodeId, "Task partner");
  const room = app.chat.createChannel({ name: "Work", description: "", visibility: "public" });
  expect(app.chat.inviteAgentToChannel(room.id, agentId)).toBe(true);
  await authorizeModel(app, cookie);
  const from = socket.sent.length;
  const anchor = app.chat.createMessage(room.id, "Investigate the alert", { asTask: true })!;
  const task = app.chat.taskForMessage(anchor.id)!;
  const run = (await waitForRuns(socket, from, [agentId])).get(agentId)!;

  // The older message-to-task entry point points the Agent at the claim call instead of a dead end.
  expect(
    await tool(app, socket, run, "create-existing", "tasks.create", { messageId: anchor.id }),
  ).toMatchObject({
    ok: false,
    error: "Message already has a task; use tasks.claim_message to claim it",
  });

  const changed = app.chat.createMessage(room.id, "Please include the restart case")!;
  const held = await tool(app, socket, run, "claim-held", "tasks.claim_message", {
    messageId: anchor.id,
  });
  expect(held).toMatchObject({
    ok: true,
    result: { status: "needs_review", changes: [expect.objectContaining({ id: changed.id })] },
  });
  const draftId = (held.result as { draftId: string }).draftId;
  expect(app.chat.readTask(task.id)).toMatchObject({ ownerAgentId: null, version: 1 });
  expect(app.chat.listAgentAttention(agentId, room.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ messageId: changed.id, unread: 1, seen: 0, presented: 1 }),
    ]),
  );

  expect(
    await tool(app, socket, run, "claim-keep", "tasks.review", { draftId, choice: "keep" }),
  ).toMatchObject({ ok: true });
  expect(
    await tool(app, socket, run, "claim-continue", "tasks.review", { draftId, choice: "continue" }),
  ).toMatchObject({ ok: true });
  const late = app.chat.createMessage(room.id, "A newer decision arrived")!;
  expect(
    await tool(app, socket, run, "claim-stale", "tasks.claim_message", {
      messageId: anchor.id,
      draftId,
    }),
  ).toMatchObject({ ok: false, error: "Conversation changed; review the task draft again" });
  expect(app.chat.readTask(task.id)).toMatchObject({ ownerAgentId: null, version: 1 });

  expect(
    await tool(app, socket, run, "claim-inspect-late", "tasks.review", {
      draftId,
      choice: "inspect",
    }),
  ).toMatchObject({ ok: true });
  expect(app.chat.listAgentAttention(agentId, room.id)).toEqual(
    expect.arrayContaining([expect.objectContaining({ messageId: late.id, presented: 1 })]),
  );
  expect(
    await tool(app, socket, run, "claim-continue-late", "tasks.review", {
      draftId,
      choice: "continue",
    }),
  ).toMatchObject({ ok: true });
  expect(
    await tool(app, socket, run, "claim-applied", "tasks.claim_message", {
      messageId: anchor.id,
      draftId,
    }),
  ).toMatchObject({
    ok: true,
    result: {
      outcome: "claimed",
      created: false,
      task: { id: task.id, ownerAgentId: agentId, status: "in_progress", version: 2 },
    },
  });

  // A deferred draft is honoured instead of being applied silently.
  app.chat.createMessage(room.id, "One more consideration");
  const heldAgain = await tool(app, socket, run, "claim-held-again", "tasks.claim_message", {
    messageId: anchor.id,
  });
  expect(heldAgain).toMatchObject({ ok: true, result: { status: "needs_review" } });
  const deferredDraftId = (heldAgain.result as { draftId: string }).draftId;
  expect(
    await tool(app, socket, run, "claim-defer", "tasks.review", {
      draftId: deferredDraftId,
      choice: "defer",
    }),
  ).toMatchObject({ ok: true, result: { state: "deferred" } });
  expect(
    await tool(app, socket, run, "claim-deferred", "tasks.claim_message", {
      messageId: anchor.id,
      draftId: deferredDraftId,
    }),
  ).toMatchObject({ ok: false, error: "Task draft is not ready" });
  expect(app.chat.readTask(task.id)).toMatchObject({ ownerAgentId: agentId, version: 2 });
});

it("does not turn task ownership into conversation access or make talk require a claim", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = addAgent(app, nodeId, "Outsider");
  const room = app.chat.createChannel({ name: "Open work", description: "", visibility: "public" }),
    secretRoom = app.chat.createChannel({
      name: "Private",
      description: "",
      visibility: "private",
    });
  expect(app.chat.inviteAgentToChannel(room.id, agentId)).toBe(true);
  await authorizeModel(app, cookie);
  const from = socket.sent.length;
  app.chat.createMessage(room.id, "Start here");
  const secret = app.chat.createMessage(secretRoom.id, "Secret task", { asTask: true })!;
  const secretTask = app.chat.taskForMessage(secret.id)!;
  const run = (await waitForRuns(socket, from, [agentId])).get(agentId)!;

  // Claiming is not a way into a private conversation the Agent cannot read.
  expect(
    await tool(app, socket, run, "private-claim", "tasks.claim_message", { messageId: secret.id }),
  ).toMatchObject({ ok: false, error: "Conversation is not available" });
  expect(app.chat.readTask(secretTask.id)).toMatchObject({ ownerAgentId: null, version: 1 });

  // Even holding the task grants no read, no send, no task change and no attention in private.
  db.prepare("UPDATE owner_tasks SET owner_agent_id=?,status='in_progress' WHERE id=?").run(
    agentId,
    secretTask.id,
  );
  for (const [toolCallId, name, input] of [
    ["private-read", "conversations.read", { conversationId: secretRoom.id }],
    [
      "private-thread",
      "conversations.read_thread",
      { conversationId: secretRoom.id, rootId: secret.id },
    ],
    ["private-send", "messages.send", { conversationId: secretRoom.id, text: "I own this task" }],
    [
      "private-update",
      "tasks.update",
      { taskId: secretTask.id, expectedVersion: 1, status: "done" },
    ],
    ["private-claim-again", "tasks.claim_message", { messageId: secret.id }],
  ] as const)
    expect(await tool(app, socket, run, toolCallId, name, input)).toMatchObject({
      ok: false,
      error: "Conversation is not available",
    });
  expect(
    (
      (await tool(app, socket, run, "private-list", "tasks.list", {})).result as {
        tasks: Array<{ id: string }>;
      }
    ).tasks.map((task) => task.id),
  ).not.toContain(secretTask.id);
  expect(app.chat.listAgentAttention(agentId, secretRoom.id)).toEqual([]);

  // Ordinary answering and discussion need no claim and create no task.
  expect(
    await tool(app, socket, run, "open-send", "messages.send", {
      conversationId: room.id,
      text: "Sharing context without claiming anything",
    }),
  ).toMatchObject({ ok: true });
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS tasks FROM owner_tasks t JOIN owner_messages m ON m.id=t.message_id WHERE m.channel_id=?",
      )
      .get(room.id),
  ).toEqual({ tasks: 0 });
});

it("leaves no partial task behind when a direct claim cannot commit", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = addAgent(app, nodeId, "Unlucky peer");
  const room = app.chat.createChannel({ name: "Work", description: "", visibility: "public" });
  expect(app.chat.inviteAgentToChannel(room.id, agentId)).toBe(true);
  await authorizeModel(app, cookie);
  const from = socket.sent.length;
  const anchor = app.chat.createMessage(room.id, "This claim must roll back")!;
  const run = (await waitForRuns(socket, from, [agentId])).get(agentId)!;
  db.exec(`CREATE TRIGGER refuse_claim BEFORE INSERT ON owner_tasks
    BEGIN SELECT RAISE(ABORT,'synthetic claim failure'); END;`);

  expect(
    await tool(app, socket, run, "refused-claim", "tasks.claim_message", { messageId: anchor.id }),
  ).toMatchObject({ ok: false, error: "Agent tool request was refused" });
  expect(db.prepare("SELECT COUNT(*) AS tasks FROM owner_tasks").get()).toEqual({ tasks: 0 });
  expect(db.prepare("SELECT COUNT(*) AS events FROM owner_task_events").get()).toEqual({
    events: 0,
  });
  expect(app.chat.taskForMessage(anchor.id)).toBeUndefined();
});
