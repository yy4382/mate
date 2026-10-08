import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import {
  cleanupFixture,
  setup,
  prepareVerifiedAgent,
  finishRun,
  waitForRun,
  callAgentTool,
} from "../../support/agent/conversation-fixture.js";
afterEach(cleanupFixture);

it("does not backfill a just-joined channel as unread nor forget what was already read", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = await prepareVerifiedAgent(app, nodeId, "Late joiner");
  const ownDirect = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!,
    publicRoom = app.chat.channels.createChannel({
      name: "Open history",
      description: "History stays quiet when an Agent joins.",
      visibility: "public",
    }),
    oldRoot = app.chat.messages.createMessage({
      channelId: publicRoom.id,
      text: "History before joining.",
    })!;
  app.chat.messages.createMessage({
    channelId: publicRoom.id,
    text: "Another old note.",
    rootId: oldRoot.id,
  });
  await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.messages.createMessage({
    channelId: ownDirect.id,
    text: "Start a conversation tool run.",
  });
  const run = await waitForRun(socket, runStart);

  // Reading the public history before joining creates nothing to be unread later.
  const preRead = await callAgentTool(app, socket, run, "pre-join-read", "tools.call", {
    name: "conversations.read",
    input: { conversationId: publicRoom.id },
  });
  expect(preRead).toMatchObject({ ok: true });
  expect(
    db
      .prepare(
        `SELECT count(*) AS count FROM owner_agent_message_attention a
         JOIN owner_messages m ON m.id=a.message_id WHERE a.agent_id=? AND m.channel_id=?`,
      )
      .get(agentId, publicRoom.id),
  ).toEqual({ count: 0 });

  const joined = await callAgentTool(app, socket, run, "join-open-history", "tools.call", {
    name: "conversations.join",
    input: { conversationId: publicRoom.id },
  });
  expect(joined).toMatchObject({ ok: true, result: { member: true, alreadyMember: false } });

  const attention = await callAgentTool(app, socket, run, "attention-after-join", "tools.call", {
    name: "attention.list",
    input: { conversationId: publicRoom.id },
  });
  expect(attention).toMatchObject({ ok: true });
  expect((attention.result as { items: unknown[] }).items).toEqual([]);
  expect(
    db
      .prepare(
        "SELECT joined_at AS joinedAt FROM owner_channel_memberships WHERE channel_id=? AND principal_kind='agent' AND principal_id=?",
      )
      .get(publicRoom.id, agentId),
  ).toMatchObject({ joinedAt: expect.any(Number) });
  const joinedAtBefore = (
    db
      .prepare(
        "SELECT joined_at AS joinedAt FROM owner_channel_memberships WHERE channel_id=? AND principal_kind='agent' AND principal_id=?",
      )
      .get(publicRoom.id, agentId) as { joinedAt: number }
  ).joinedAt;

  // A later delivery becomes unread, is read, and stays read across a second join.
  await finishRun(app, socket, run);
  const beforeFresh = socket.sent.length;
  const fresh = app.chat.messages.createMessage({
    channelId: publicRoom.id,
    text: "Fresh activity after joining.",
  })!;
  const freshRun = await waitForRun(socket, beforeFresh);
  const freshRead = await callAgentTool(app, socket, freshRun, "read-fresh", "tools.call", {
    name: "conversations.read",
    input: { conversationId: publicRoom.id },
  });
  expect(freshRead).toMatchObject({ ok: true });
  await callAgentTool(app, socket, freshRun, "mark-read", "tools.call", {
    name: "attention.update",
    input: { conversationId: publicRoom.id, messageId: fresh.id, unread: false, seen: true },
  });
  const rejoin = await callAgentTool(app, socket, freshRun, "rejoin-open-history", "tools.call", {
    name: "conversations.join",
    input: { conversationId: publicRoom.id },
  });
  expect(rejoin).toMatchObject({ ok: true, result: { member: true, alreadyMember: true } });
  expect(
    db
      .prepare("SELECT unread FROM owner_agent_message_attention WHERE agent_id=? AND message_id=?")
      .get(agentId, fresh.id),
  ).toEqual({ unread: 0 });

  // Force the other path: an inactive membership row that only the upsert can revive.
  db.prepare(
    "UPDATE owner_channel_memberships SET active=0 WHERE channel_id=? AND principal_kind='agent' AND principal_id=?",
  ).run(publicRoom.id, agentId);
  const revived = await callAgentTool(app, socket, freshRun, "revive-open-history", "tools.call", {
    name: "conversations.join",
    input: { conversationId: publicRoom.id },
  });
  expect(revived).toMatchObject({ ok: true, result: { member: true, alreadyMember: false } });
  expect(
    db
      .prepare(
        "SELECT active,joined_at AS joinedAt FROM owner_channel_memberships WHERE channel_id=? AND principal_kind='agent' AND principal_id=?",
      )
      .get(publicRoom.id, agentId),
  ).toEqual({ active: 1, joinedAt: joinedAtBefore });
  expect(
    db
      .prepare("SELECT unread FROM owner_agent_message_attention WHERE agent_id=? AND message_id=?")
      .get(agentId, fresh.id),
  ).toEqual({ unread: 0 });
});
