import { randomUUID } from "node:crypto";

import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import {
  OwnerMessageLike,
  cleanupFixture,
  setup,
  prepareVerifiedAgent,
  finishRun,
  waitForRun,
  callAgentTool,
} from "../../support/agent/conversation-fixture.js";
afterEach(cleanupFixture);

it("limits read and send to joined conversations while exposing only public metadata", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Conversation member",
    role: "Uses explicitly authorized conversations",
    description: "Synthetic ACL fixture.",
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
  const ownDirect = app.chat.getOrCreateAgentDirectChannel(agentId)!,
    publicRoom = app.chat.createChannel({
      name: "Visible name",
      description: "Visible description only.",
      visibility: "public",
    }),
    privateRoom = app.chat.createChannel({
      name: "Secret project",
      description: "Only members can know this exists.",
      visibility: "private",
    });
  app.chat.createMessage(publicRoom.id, "Public message body.");
  app.chat.createMessage(privateRoom.id, "Private message body.");
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.createMessage(ownDirect.id, "Start a conversation tool run.");
  const run = await waitForRun(socket, runStart);

  const list = await callAgentTool(app, socket, run, "acl-list", "tools.call", {
    name: "conversations.list",
    input: {},
  });
  expect(list).toMatchObject({ type: "tools.result", ok: true });
  const conversations = (list.result as { conversations: Array<Record<string, unknown>> })
    .conversations;
  expect(conversations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: publicRoom.id,
        name: "Visible name",
        description: "Visible description only.",
        member: false,
      }),
      expect.objectContaining({ id: ownDirect.id, kind: "dm", member: true }),
    ]),
  );
  expect(conversations).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: privateRoom.id })]),
  );
  expect(app.chat.listChannels().map((channel) => channel.id)).toContain(privateRoom.id);

  // Public metadata is readable, so a public channel's body is readable too; a private
  // conversation stays closed, and neither case lets a non-member speak.
  const publicRead = await callAgentTool(app, socket, run, "read-public-nonmember", "tools.call", {
    name: "conversations.read",
    input: { conversationId: publicRoom.id },
  });
  expect(publicRead).toMatchObject({ ok: true });
  expect(
    (publicRead.result as { messages: Array<{ text: string }> }).messages.map(
      (message) => message.text,
    ),
  ).toEqual(["Public message body."]);
  const privateReadDenied = await callAgentTool(
    app,
    socket,
    run,
    "read-private-nonmember",
    "tools.call",
    {
      name: "conversations.read",
      input: { conversationId: privateRoom.id },
    },
  );
  expect(privateReadDenied).toMatchObject({
    ok: false,
    error: "Conversation is not available",
  });
  const taskIdDoesNotGrantAccess = await callAgentTool(
    app,
    socket,
    run,
    "task-id-is-not-access",
    "tools.call",
    {
      name: "conversations.read",
      input: { taskId: privateRoom.id },
    },
  );
  expect(taskIdDoesNotGrantAccess).toMatchObject({ ok: false, error: "Invalid tool input" });
  const publicSendDenied = await callAgentTool(
    app,
    socket,
    run,
    "send-public-nonmember",
    "tools.call",
    {
      name: "messages.send",
      input: { conversationId: publicRoom.id, text: "Must not be sent." },
    },
  );
  expect(publicSendDenied.ok).toBe(false);

  const sendInput = {
    name: "messages.send",
    input: { conversationId: ownDirect.id, text: "One explicit private reply." },
  };
  const firstSend = await callAgentTool(
      app,
      socket,
      run,
      "same-send-action-id",
      "tools.call",
      sendInput,
    ),
    retrySend = await callAgentTool(
      app,
      socket,
      run,
      "same-send-action-id",
      "tools.call",
      sendInput,
    );
  expect(firstSend).toMatchObject({ ok: true });
  expect(retrySend.result).toEqual(firstSend.result);
  const directMessages = app.chat.listMessages(ownDirect.id, undefined, 100)!.messages;
  expect(
    directMessages.filter((message) => message.text === "One explicit private reply."),
  ).toHaveLength(1);
});

it("lets a non-member Agent read a public channel's timeline and thread but not speak", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = await prepareVerifiedAgent(app, nodeId, "Curious colleague");
  const ownDirect = app.chat.getOrCreateAgentDirectChannel(agentId)!,
    publicRoom = app.chat.createChannel({
      name: "Open research",
      description: "Anyone configured may read this.",
      visibility: "public",
    }),
    root = app.chat.createMessage(publicRoom.id, "Public planning message.")!;
  app.chat.createMessage(publicRoom.id, "First public reply.", { rootId: root.id });
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.createMessage(ownDirect.id, "Start a conversation tool run.");
  const run = await waitForRun(socket, runStart);

  const read = await callAgentTool(app, socket, run, "read-public-nonmember", "tools.call", {
    name: "conversations.read",
    input: { conversationId: publicRoom.id },
  });
  expect(read).toMatchObject({ ok: true });
  const page = read.result as { conversation: { id: string }; messages: OwnerMessageLike[] };
  expect(page.conversation.id).toBe(publicRoom.id);
  expect(page.messages.map((message) => message.text)).toEqual(["Public planning message."]);

  const thread = await callAgentTool(
    app,
    socket,
    run,
    "read-public-thread-nonmember",
    "tools.call",
    {
      name: "conversations.read_thread",
      input: { conversationId: publicRoom.id, rootId: root.id },
    },
  );
  expect(thread).toMatchObject({ ok: true });
  const threadResult = thread.result as { root: OwnerMessageLike; replies: OwnerMessageLike[] };
  expect(threadResult.root.text).toBe("Public planning message.");
  expect(threadResult.replies.map((message) => message.text)).toEqual(["First public reply."]);

  const sendDenied = await callAgentTool(app, socket, run, "send-public-nonmember", "tools.call", {
    name: "messages.send",
    input: { conversationId: publicRoom.id, text: "Must not be sent before joining." },
  });
  expect(sendDenied).toMatchObject({ ok: false, error: "Conversation is not available" });
  expect(
    app.chat
      .listMessages(publicRoom.id, undefined, 100)!
      .messages.some((message) => message.text === "Must not be sent before joining."),
  ).toBe(false);
});

it("keeps a non-member Agent out of a private channel that holds a task", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = await prepareVerifiedAgent(app, nodeId, "Private outsider");
  const ownDirect = app.chat.getOrCreateAgentDirectChannel(agentId)!,
    privateRoom = app.chat.createChannel({
      name: "Secret project",
      description: "Only members may read this.",
      visibility: "private",
    }),
    secret = app.chat.createMessage(privateRoom.id, "Private planning message.")!;
  app.chat.createTaskForMessage(secret.id, "human", "owner", secret.text);
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.createMessage(ownDirect.id, "Start a conversation tool run.");
  const run = await waitForRun(socket, runStart);

  const read = await callAgentTool(app, socket, run, "read-private-nonmember", "tools.call", {
    name: "conversations.read",
    input: { conversationId: privateRoom.id },
  });
  expect(read).toMatchObject({ ok: false, error: "Conversation is not available" });
  const thread = await callAgentTool(app, socket, run, "thread-private-nonmember", "tools.call", {
    name: "conversations.read_thread",
    input: { conversationId: privateRoom.id, rootId: secret.id },
  });
  expect(thread).toMatchObject({ ok: false, error: "Conversation is not available" });
  const join = await callAgentTool(app, socket, run, "join-private-nonmember", "tools.call", {
    name: "conversations.join",
    input: { conversationId: privateRoom.id },
  });
  expect(join.ok).toBe(false);
  expect(
    app.chat
      .listMessages(privateRoom.id, undefined, 100)!
      .messages.some((message) => message.text === "Private planning message."),
  ).toBe(true);

  // Holding a task in the private channel grants no read access to it, and task
  // visibility stays member-only rather than following the widened conversation read.
  const listed = await callAgentTool(app, socket, run, "tasks-list-private", "tools.call", {
    name: "tasks.list",
    input: {},
  });
  expect(listed).toMatchObject({ ok: true });
  expect((listed.result as { tasks: Array<{ id: string }> }).tasks).toEqual([]);
});

it("lets a non-member Agent join a public channel, then speak and receive later activity", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = await prepareVerifiedAgent(app, nodeId, "Joining colleague");
  const ownDirect = app.chat.getOrCreateAgentDirectChannel(agentId)!,
    publicRoom = app.chat.createChannel({
      name: "Open standup",
      description: "Agents may join on their own.",
      visibility: "public",
    });
  app.chat.createMessage(publicRoom.id, "Old standup note.");
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.createMessage(ownDirect.id, "Start a conversation tool run.");
  const run = await waitForRun(socket, runStart);

  const joined = await callAgentTool(app, socket, run, "join-public", "tools.call", {
    name: "conversations.join",
    input: { conversationId: publicRoom.id },
  });
  expect(joined).toMatchObject({
    ok: true,
    result: { conversationId: publicRoom.id, member: true, alreadyMember: false },
  });

  const sendInput = {
    name: "messages.send",
    input: { conversationId: publicRoom.id, text: "I have joined and can speak." },
  };
  const sent = await callAgentTool(app, socket, run, "send-after-join", "tools.call", sendInput);
  expect(sent).toMatchObject({ ok: true });
  const held = sent.result as { status?: string; draftId?: string };
  expect(held.status).toBe("needs_review");
  expect(held.draftId).toBeTruthy();
  const reviewed = await callAgentTool(app, socket, run, "review-after-join", "tools.call", {
    name: "drafts.review",
    input: { draftId: held.draftId, choice: "continue" },
  });
  expect(reviewed).toMatchObject({ ok: true });
  const resent = await callAgentTool(app, socket, run, "send-after-join-2", "tools.call", {
    name: "messages.send",
    input: { ...sendInput.input, draftId: held.draftId },
  });
  expect(resent).toMatchObject({ ok: true });
  expect(
    app.chat
      .listMessages(publicRoom.id, undefined, 100)!
      .messages.some((message) => message.text === "I have joined and can speak."),
  ).toBe(true);

  // Later ordinary owner activity now reaches the new member as a fresh run.
  await finishRun(app, socket, run);
  const beforeActivity = socket.sent.length;
  app.chat.createMessage(publicRoom.id, "Welcome to the standup.");
  const laterRun = await waitForRun(socket, beforeActivity);
  expect(laterRun.agentId).toBe(agentId);
});

it("does not let an outsider read or join a peer direct message through the public read path", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const firstAgentId = await prepareVerifiedAgent(app, nodeId, "Chatty colleague"),
    secondAgentId = await prepareVerifiedAgent(app, nodeId, "Quiet colleague"),
    outsiderId = await prepareVerifiedAgent(app, nodeId, "Outsider colleague");
  // Seed the peer DM through its own tables: the factory path requires the tool transaction.
  const outsiderDirect = app.chat.getOrCreateAgentDirectChannel(outsiderId)!;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.createMessage(outsiderDirect.id, "Start a conversation tool run.");
  const run = await waitForRun(socket, runStart);

  const peerDm = app.chat.createChannel({
      name: "Peer DM",
      description: "A private exchange between two colleagues.",
      visibility: "private",
    }),
    ordered = [firstAgentId, secondAgentId].sort(),
    seed = db.transaction(() => {
      db.prepare(
        "INSERT INTO owner_agent_peer_direct_channels(channel_id,first_agent_id,second_agent_id,created_at) VALUES(?,?,?,?)",
      ).run(peerDm.id, ordered[0], ordered[1], Date.now());
      db.prepare(
        "INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at) VALUES(?,?,?,1,?)",
      ).run(peerDm.id, "agent", firstAgentId, Date.now());
      db.prepare(
        "INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at) VALUES(?,?,?,1,?)",
      ).run(peerDm.id, "agent", secondAgentId, Date.now());
    });
  seed.immediate();
  const secret = app.chat.createMessage(peerDm.id, "A private peer exchange.")!;

  const read = await callAgentTool(app, socket, run, "read-peer-dm", "tools.call", {
    name: "conversations.read",
    input: { conversationId: peerDm.id },
  });
  expect(read).toMatchObject({ ok: false, error: "Conversation is not available" });
  const thread = await callAgentTool(app, socket, run, "thread-peer-dm", "tools.call", {
    name: "conversations.read_thread",
    input: { conversationId: peerDm.id, rootId: secret.id },
  });
  expect(thread).toMatchObject({ ok: false, error: "Conversation is not available" });
  const join = await callAgentTool(app, socket, run, "join-peer-dm", "tools.call", {
    name: "conversations.join",
    input: { conversationId: peerDm.id },
  });
  expect(join.ok).toBe(false);
  const listed = await callAgentTool(app, socket, run, "list-after-dm-probe", "tools.call", {
    name: "conversations.list",
    input: {},
  });
  expect(listed).toMatchObject({ ok: true });
  expect(
    (listed.result as { conversations: Array<{ id: string }> }).conversations.some(
      (conversation) => conversation.id === peerDm.id,
    ),
  ).toBe(false);

  // Even if a direct message's visibility were ever flipped, direct conversations stay
  // member-only: the public branch must exclude them on its own.
  db.prepare("UPDATE owner_channels SET visibility='public' WHERE id=?").run(peerDm.id);
  expect(
    await callAgentTool(app, socket, run, "read-published-peer-dm", "tools.call", {
      name: "conversations.read",
      input: { conversationId: peerDm.id },
    }),
  ).toMatchObject({ ok: false, error: "Conversation is not available" });
  expect(
    await callAgentTool(app, socket, run, "join-published-peer-dm", "tools.call", {
      name: "conversations.join",
      input: { conversationId: peerDm.id },
    }),
  ).toMatchObject({ ok: false, error: "Conversation is not available" });
  // Listing must not reveal it either, and the owner API refuses to publish any DM.
  const afterPublish = await callAgentTool(
    app,
    socket,
    run,
    "list-published-peer-dm",
    "tools.call",
    {
      name: "conversations.list",
      input: {},
    },
  );
  expect(afterPublish).toMatchObject({ ok: true });
  expect(
    (afterPublish.result as { conversations: Array<{ id: string }> }).conversations.some(
      (conversation) => conversation.id === peerDm.id,
    ),
  ).toBe(false);
  expect(() => app.chat.updateChannel(peerDm.id, { visibility: "public" })).toThrow(
    "A direct message cannot be made public",
  );
});
