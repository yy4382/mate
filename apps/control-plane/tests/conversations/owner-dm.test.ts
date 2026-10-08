import { toolTestInput } from "../support/agent/tool-run.js";

import { randomUUID } from "node:crypto";

import { afterEach, expect, it } from "vitest";

import { cleanupFixture, setup, waitForRun } from "../support/agent/conversation-fixture.js";
afterEach(cleanupFixture);

it("creates one private owner DM and keeps its input queued while the Agent awaits credentials", async () => {
  const { app, cookie, nodeId } = await setup();
  const agentId = randomUUID();
  const prepared = app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Research partner",
    role: "Answers private messages",
    description: "A private colleague.",
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
  expect(prepared.agent.sessionId).toBe(app.agents.get(agentId)?.sessionId);

  const direct = await app.http.request(`/api/owner/agents/${agentId}/direct-channel`, {
    method: "POST",
    headers: { cookie },
  });
  expect(direct.status).toBe(200);
  const { channel } = (await direct.json()) as { channel: { id: string; visibility: string } };
  expect(channel.visibility).toBe("private");
  const repeated = await app.http.request(`/api/owner/agents/${agentId}/direct-channel`, {
    method: "POST",
    headers: { cookie },
  });
  expect(((await repeated.json()) as { channel: { id: string } }).channel.id).toBe(channel.id);

  const post = await app.http.request(`/api/owner/channels/${channel.id}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "请给我一个简短研究计划。" }),
  });
  expect(post.status).toBe(201);
  expect(app.chat.deliveries.listPendingDeliveries("agent", agentId).deliveries).toHaveLength(1);
});

it("routes Agent conversation discovery through its current control-plane run", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Directory partner",
    role: "Discovers visible conversations",
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
  const ownChannel = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
  const publicRoom = app.chat.channels.createChannel({
    name: "Discoverable room",
    description: "Public metadata is visible to every Agent.",
    visibility: "public",
  });
  const otherPrivateRoom = app.chat.channels.createChannel({
    name: "Hidden room",
    description: "Private metadata is member-only.",
    visibility: "private",
  });
  app.chat.messages.createMessage({ channelId: ownChannel.id, text: "列出可见对话。" });
  const runStart = socket.sent.length;
  const credential = await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  expect(credential.status).toBe(204);
  const run = await waitForRun(socket, runStart);

  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "tools.execute",
      requestId: randomUUID(),
      runId: run.runId,
      agentId,
      toolCallId: "discover-1",
      operation: "tools.call",
      input: { name: "conversations.list", input: {} },
    }),
  );
  const result = JSON.parse(socket.sent.at(-1)!) as {
    type: string;
    toolCallId?: string;
    ok?: boolean;
    result?: { conversations: Array<{ id: string; name: string }> };
  };
  expect(result.type).toBe("tools.result");
  expect(result).toMatchObject({ toolCallId: "discover-1", ok: true });
  expect(result.result?.conversations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: publicRoom.id, name: "Discoverable room" }),
      expect.objectContaining({ id: ownChannel.id }),
    ]),
  );
  expect(result.result?.conversations).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: otherPrivateRoom.id })]),
  );
});
