import { toolTestApp } from "../support/agent/tool-run.js";

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import {
  password,
  fixtures,
  cleanupFixture,
  setup,
  waitForRun,
  callAgentTool,
} from "../support/agent/conversation-fixture.js";
afterEach(cleanupFixture);

it("persists separate attention and draft choices while gating stale sends", async () => {
  const { app, cookie, nodeId, socket, db, directory } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Attentive peer",
    role: "Synthetic",
    description: "Attention fixture",
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
  const dm = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-attention-key" }),
  });
  const from = socket.sent.length;
  const first = app.chat.createMessage(dm.id, "Initial context")!;
  const run = await waitForRun(socket, from);
  async function tool(id: string, name: string, input: Record<string, unknown>) {
    const result = await callAgentTool(app, socket, run, id, "tools.call", { name, input });
    expect(result.ok).toBe(true);
    return result.result as Record<string, unknown>;
  }
  const notice = await tool("attention-before", "attention.list", { conversationId: dm.id });
  expect(notice.items).toEqual([
    expect.objectContaining({ messageId: first.id, unread: 1, seen: 0, presented: 0 }),
  ]);
  await tool("attention-seen", "attention.update", {
    conversationId: dm.id,
    messageId: first.id,
    seen: true,
    deferred: true,
    muted: true,
  });
  const seen = await tool("attention-after", "attention.list", { conversationId: dm.id });
  expect(seen.items).toEqual([
    expect.objectContaining({
      messageId: first.id,
      unread: 1,
      seen: 1,
      deferred: 1,
      muted: 1,
      presented: 0,
    }),
  ]);
  await tool("read-body", "conversations.read", { conversationId: dm.id });
  const presented = await tool("attention-presented", "attention.list", { conversationId: dm.id });
  expect(presented.items).toEqual([
    expect.objectContaining({ messageId: first.id, unread: 1, presented: 1 }),
  ]);
  app.chat.createMessage(dm.id, "Before unprepared send");
  const unprepared = await tool("unprepared-send", "messages.send", {
    conversationId: dm.id,
    text: "Must review first",
  });
  expect(unprepared).toMatchObject({
    status: "needs_review",
    changes: [expect.objectContaining({ text: "Before unprepared send" })],
  });
  const unpreparedDraft = unprepared.draftId as string;
  await tool("unprepared-defer", "drafts.review", { draftId: unpreparedDraft, choice: "defer" });
  const saved = await tool("draft-save", "drafts.save", {
    conversationId: dm.id,
    text: "First attempt",
  });
  const draftId = saved.id as string;
  app.chat.createMessage(dm.id, "Concurrent change");
  const changes = await tool("draft-inspect", "drafts.review", { draftId, choice: "inspect" });
  expect(changes.changes).toEqual([expect.objectContaining({ text: "Concurrent change" })]);
  await tool("draft-keep", "drafts.review", { draftId, choice: "keep" });
  const refused = await callAgentTool(app, socket, run, "draft-premature-send", "tools.call", {
    name: "messages.send",
    input: { conversationId: dm.id, text: "First attempt", draftId },
  });
  expect(refused).toMatchObject({ ok: false, error: "Draft is not ready for this message" });
  await tool("draft-continue", "drafts.review", { draftId, choice: "continue" });
  app.chat.createMessage(dm.id, "Another concurrent change");
  const stale = await callAgentTool(app, socket, run, "draft-stale-send", "tools.call", {
    name: "messages.send",
    input: { conversationId: dm.id, text: "First attempt", draftId },
  });
  expect(stale).toMatchObject({ ok: false, error: "Conversation changed; review the draft again" });
  const uninformed = await callAgentTool(
    app,
    socket,
    run,
    "draft-uninformed-continue",
    "tools.call",
    { name: "drafts.review", input: { draftId, choice: "continue" } },
  );
  expect(uninformed).toMatchObject({
    ok: false,
    error: "Conversation changed; inspect the draft before continuing",
  });
  await tool("draft-inspect-again", "drafts.review", { draftId, choice: "inspect" });
  await tool("draft-continue-again", "drafts.review", { draftId, choice: "continue" });
  const sent = await tool("draft-send", "messages.send", {
    conversationId: dm.id,
    text: "First attempt",
    draftId,
  });
  expect(sent.text).toBe("First attempt");
  const threadReply = app.chat.createMessage(dm.id, "Full thread reply", { rootId: first.id })!;
  expect(
    app.chat
      .listPendingDeliveries("agent", agentId)
      .deliveries.find((delivery) => delivery.messageId === threadReply.id)?.message.rootId,
  ).toBe(first.id);
  const fullThread = await tool("full-thread", "conversations.read_thread", {
    conversationId: dm.id,
    rootId: first.id,
  });
  expect(fullThread).toMatchObject({
    root: { id: first.id },
    replies: [{ id: threadReply.id, rootId: first.id }],
  });
  const second = await tool("draft-second", "drafts.save", {
    conversationId: dm.id,
    text: "Abandon this",
  });
  await tool("draft-abandon", "drafts.review", { draftId: second.id, choice: "abandon" });
  expect(db.prepare("SELECT state FROM owner_agent_drafts WHERE id=?").get(second.id)).toEqual({
    state: "abandoned",
  });
  app.close();
  const restarted = toolTestApp({
    dataDir: join(directory, "control-plane"),
    passwordFile: join(directory, "owner-password"),
  });
  fixtures.push({
    app: restarted,
    directory,
    db: new Database(join(directory, "control-plane", "control-plane.sqlite")),
  });
  expect(restarted.chat.listAgentAttention(agentId, dm.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        messageId: first.id,
        unread: 1,
        seen: 1,
        deferred: 1,
        muted: 1,
        presented: 1,
      }),
    ]),
  );
  expect(restarted.chat.readPersistedAgentDraft(agentId, second.id as string)).toMatchObject({
    state: "abandoned",
    text: "Abandon this",
    channelId: dm.id,
  });
});

it("does not let a saved draft or a later paginated read hide unseen conversation changes", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Freshness peer",
    role: "Synthetic",
    description: "Freshness fixture",
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
  const dm = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-freshness-key" }),
  });
  const from = socket.sent.length;
  app.chat.createMessage(dm.id, "Run input");
  const run = await waitForRun(socket, from);
  async function tool(id: string, name: string, input: Record<string, unknown>) {
    return callAgentTool(app, socket, run, id, "tools.call", { name, input });
  }
  const firstChange = app.chat.createMessage(dm.id, "Earlier unseen change")!;
  const secondChange = app.chat.createMessage(dm.id, "Later visible change")!;
  const read = await tool("read-latest-only", "conversations.read", {
    conversationId: dm.id,
    limit: 1,
  });
  expect(read).toMatchObject({ ok: true, result: { messages: [{ id: secondChange.id }] } });
  const forged = await tool("forge-presented", "attention.update", {
    conversationId: dm.id,
    messageId: firstChange.id,
    presented: true,
  });
  expect(forged).toMatchObject({ ok: false, error: "Invalid tool input" });
  const saved = await tool("save-after-changes", "drafts.save", {
    conversationId: dm.id,
    text: "Draft text",
  });
  expect(saved).toMatchObject({
    ok: true,
    result: {
      changes: [expect.objectContaining({ id: firstChange.id, text: "Earlier unseen change" })],
    },
  });
  const draftId = (saved.result as { id: string }).id;
  const continued = await tool("continue-after-save", "drafts.review", {
    draftId,
    choice: "continue",
  });
  expect(continued.ok).toBe(true);
  const sent = await tool("send-after-review", "messages.send", {
    conversationId: dm.id,
    text: "Draft text",
    draftId,
  });
  expect(sent).toMatchObject({ ok: true, result: { text: "Draft text" } });
});
