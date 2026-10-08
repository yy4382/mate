import { randomUUID } from "node:crypto";

import { afterEach, expect, it } from "vitest";

import {
  cleanupFixture,
  createConversationFixture,
  waitForRun,
  callAgentTool,
} from "../support/agent/conversation-fixture.js";
afterEach(cleanupFixture);

it("commits an eligible peer invitation once and rejects invalid invitation targets", async () => {
  const { app, cookie, db, nodeId, socket } = await createConversationFixture();
  const inviterId = randomUUID(),
    inviteeId = randomUUID(),
    unverifiedId = randomUUID();
  for (const [agentId, name] of [
    [inviterId, "Inviter"],
    [inviteeId, "Invitee"],
  ] as const) {
    app.agents.prepare({
      id: agentId,
      nodeId,
      name,
      role: "Conversation colleague",
      description: "Synthetic invitation fixture.",
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
  }
  app.agents.prepare({
    id: unverifiedId,
    nodeId,
    name: "Unverified target",
    role: "Unprovisioned",
    description: "Must not be invited.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  const room = app.chat.channels.createChannel({
    name: "Team room",
    description: "A shared room.",
    visibility: "private",
  });
  expect(app.chat.channels.inviteAgentToChannel(room.id, inviterId)).toBe(true);
  await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.messages.createMessage({ channelId: room.id, text: "Start invitation run." });
  const run = await waitForRun(socket, runStart);
  const inviteInput = {
    name: "conversations.invite",
    input: { conversationId: room.id, agentId: inviteeId },
  };
  const invite = await callAgentTool(
    app,
    socket,
    run,
    "same-invite-action-id",
    "tools.call",
    inviteInput,
  );
  const replay = await callAgentTool(
    app,
    socket,
    run,
    "same-invite-action-id",
    "tools.call",
    inviteInput,
  );
  expect(invite).toMatchObject({ ok: true });
  expect(replay.result).toEqual(invite.result);
  expect(
    db
      .prepare(
        "SELECT active FROM owner_channel_memberships WHERE channel_id=? AND principal_kind='agent' AND principal_id=?",
      )
      .get(room.id, inviteeId),
  ).toEqual({ active: 1 });
  expect(
    db
      .prepare("SELECT count(*) AS count FROM owner_agent_tool_actions WHERE session_id=?")
      .get(run.sessionId),
  ).toEqual({ count: 1 });

  for (const [actionId, targetId, conversationId] of [
    ["invite-self", inviterId, room.id],
    ["invite-unverified", unverifiedId, room.id],
    [
      "invite-to-dm",
      inviteeId,
      app.chat.conversations.getOrCreateAgentDirectChannel(inviterId)!.id,
    ],
  ]) {
    const denied = await callAgentTool(app, socket, run, actionId!, "tools.call", {
      name: "conversations.invite",
      input: { conversationId, agentId: targetId },
    });
    expect(denied.ok).toBe(false);
  }
});

it("lets the owner invite an existing Agent to a channel through the authenticated web API", async () => {
  const { app, cookie, db, nodeId, socket } = await createConversationFixture();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Owner-invited colleague",
    role: "Reads a channel after owner invitation",
    description: "Synthetic owner invitation fixture.",
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
  const unverifiedAgentId = randomUUID();
  app.agents.prepare({
    id: unverifiedAgentId,
    nodeId,
    name: "Unverified owner-invitation target",
    role: "Has no verified identity yet",
    description: "Must not be admitted by the owner route.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  const channel = app.chat.channels.createChannel({
    name: "Owner-managed channel",
    description: "Existing Agents can be invited by the owner.",
    visibility: "private",
  });
  app.chat.messages.createMessage({
    channelId: channel.id,
    text: "邀请之前的历史也应对新成员可读。",
  });
  const route = `/api/owner/channels/${channel.id}/invitations`;
  const ownerDm = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
  const invitableChannels = await app.http.request("/api/owner/invitable-channels", {
    headers: { cookie },
  });
  const invitableBody = (await invitableChannels.json()) as { channels: Array<{ id: string }> };
  expect(invitableChannels.status).toBe(200);
  expect(invitableBody.channels.map((item) => item.id)).toContain(channel.id);
  expect(invitableBody.channels.map((item) => item.id)).not.toContain(ownerDm.id);

  const unverifiedInvite = await app.http.request(route, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ agentId: unverifiedAgentId }),
  });
  expect(unverifiedInvite.status).toBe(409);
  expect(
    db
      .prepare(
        "SELECT active FROM owner_channel_memberships WHERE channel_id=? AND principal_kind='agent' AND principal_id=?",
      )
      .get(channel.id, unverifiedAgentId),
  ).toBeUndefined();
  const unauthenticated = await app.http.request(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId }),
  });
  expect(unauthenticated.status).toBe(401);

  const invite = await app.http.request(route, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ agentId }),
  });
  expect(invite.status).toBe(201);
  expect(await invite.json()).toMatchObject({
    channelId: channel.id,
    agentId,
    status: "joined",
  });
  expect(
    db
      .prepare(
        "SELECT active FROM owner_channel_memberships WHERE channel_id=? AND principal_kind='agent' AND principal_id=?",
      )
      .get(channel.id, agentId),
  ).toEqual({ active: 1 });
  expect(app.chat.deliveries.listPendingDeliveries("agent", agentId).deliveries).toHaveLength(0);
  const privateDmInvite = await app.http.request(`/api/owner/channels/${ownerDm.id}/invitations`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ agentId }),
  });
  expect(privateDmInvite.status).toBe(409);

  await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.messages.createMessage({
    channelId: channel.id,
    text: "邀请提交后，新成员立即获得读取权限。",
  });
  const run = await waitForRun(socket, runStart);
  const read = await callAgentTool(app, socket, run, "owner-invite-read", "tools.call", {
    name: "conversations.read",
    input: { conversationId: channel.id },
  });
  expect(read).toMatchObject({ ok: true });
  expect(
    (read.result as { messages: Array<{ text: string }> }).messages.map((message) => message.text),
  ).toEqual(["邀请之前的历史也应对新成员可读。", "邀请提交后，新成员立即获得读取权限。"]);
});
