import { randomUUID } from "node:crypto";

import { afterEach, expect, it } from "vitest";

import {
  cleanupFixture,
  setup,
  waitForRun,
  callAgentTool,
} from "../support/agent/conversation-fixture.js";
afterEach(cleanupFixture);

it("lets one Agent discover and open an explicit peer DM that both Agents and the owner can read", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const firstAgentId = randomUUID(),
    secondAgentId = randomUUID(),
    unverifiedId = randomUUID(),
    failedAgentId = randomUUID();
  for (const [agentId, name] of [
    [firstAgentId, "First colleague"],
    [secondAgentId, "Second colleague"],
  ] as const) {
    app.agents.prepare({
      id: agentId,
      nodeId,
      name,
      role: "Collaborates through direct messages",
      description: "Synthetic peer DM fixture.",
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
    name: "Unverified colleague",
    role: "Not available for contact",
    description: "Unprovisioned test identity.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.prepare({
    id: failedAgentId,
    nodeId,
    name: "Failed colleague",
    role: "Unavailable for contact",
    description: "Synthetic failed provisioning state.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.fail(failedAgentId, "Synthetic provisioning failure.");
  const firstDirect = app.chat.conversations.getOrCreateAgentDirectChannel(firstAgentId)!;
  await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.messages.createMessage({ channelId: firstDirect.id, text: "Start peer DM run." });
  const firstRun = await waitForRun(socket, runStart);
  const discover = await callAgentTool(app, socket, firstRun, "agents-list", "tools.call", {
    name: "agents.list",
    input: {},
  });
  expect(discover.result).toMatchObject({
    agents: [expect.objectContaining({ id: secondAgentId, name: "Second colleague" })],
  });
  expect(JSON.stringify(discover.result)).not.toContain(unverifiedId);
  expect(JSON.stringify(discover.result)).not.toContain(failedAgentId);
  const selfDm = await callAgentTool(app, socket, firstRun, "self-dm", "tools.call", {
    name: "conversations.open_dm",
    input: { targetAgentId: firstAgentId },
  });
  expect(selfDm).toMatchObject({
    ok: false,
    error: "An Agent cannot open a direct message with itself",
  });
  const invalidDm = await callAgentTool(app, socket, firstRun, "unverified-dm", "tools.call", {
    name: "conversations.open_dm",
    input: { targetAgentId: unverifiedId },
  });
  expect(invalidDm).toMatchObject({ ok: false, error: "Direct-message target is not available" });
  const failedDm = await callAgentTool(app, socket, firstRun, "failed-dm", "tools.call", {
    name: "conversations.open_dm",
    input: { targetAgentId: failedAgentId },
  });
  expect(failedDm).toMatchObject({ ok: false, error: "Direct-message target is not available" });

  const openInput = { name: "conversations.open_dm", input: { targetAgentId: secondAgentId } },
    secondRunStart = socket.sent.length,
    opened = await callAgentTool(
      app,
      socket,
      firstRun,
      "same-open-dm-action",
      "tools.call",
      openInput,
    ),
    openedAgain = await callAgentTool(
      app,
      socket,
      firstRun,
      "same-open-dm-action",
      "tools.call",
      openInput,
    );
  expect(opened).toMatchObject({ ok: true });
  expect(openedAgain.result).toEqual(opened.result);
  const peerDm = opened.result as {
    id: string;
    name: string;
    visibility: string;
  };
  expect(peerDm.visibility).toBe("private");
  expect(peerDm.name).toContain("First colleague");
  expect(peerDm.name).toContain("Second colleague");
  expect(app.chat.channels.listChannels().map((channel) => channel.id)).toContain(peerDm.id);
  const ownerChannels = await app.http.request("/api/owner/channels", { headers: { cookie } });
  expect(ownerChannels.status).toBe(200);
  const listedOwnerChannels = (await ownerChannels.json()) as {
    channels: Array<{ id: string; name: string; description: string }>;
  };
  const listedPeerDm = listedOwnerChannels.channels.find((channel) => channel.id === peerDm.id);
  expect(listedPeerDm?.name).toBe(peerDm.name);
  expect(listedPeerDm?.description).toContain("First colleague");
  expect(listedPeerDm?.description).toContain("Second colleague");
  const members = db
    .prepare(
      "SELECT principal_kind,principal_id,active FROM owner_channel_memberships WHERE channel_id=? ORDER BY principal_kind,principal_id",
    )
    .all(peerDm.id);
  expect(members).toEqual(
    expect.arrayContaining([
      { principal_kind: "agent", principal_id: firstAgentId, active: 1 },
      { principal_kind: "agent", principal_id: secondAgentId, active: 1 },
      { principal_kind: "human", principal_id: "owner", active: 1 },
    ]),
  );
  expect(
    db.prepare("SELECT count(*) AS count FROM owner_agent_peer_direct_channels").get(),
  ).toEqual({ count: 1 });

  const sent = await callAgentTool(app, socket, firstRun, "peer-message", "tools.call", {
    name: "messages.send",
    input: { conversationId: peerDm.id, text: "来自第一位同伴的消息。" },
  });
  expect(sent.ok).toBe(true);
  const secondRun = await waitForRun(socket, secondRunStart);
  expect(secondRun.agentId).toBe(secondAgentId);
  const reverseOpen = await callAgentTool(app, socket, secondRun, "reverse-open-dm", "tools.call", {
    name: "conversations.open_dm",
    input: { targetAgentId: firstAgentId },
  });
  expect(reverseOpen).toMatchObject({
    ok: true,
    result: expect.objectContaining({ id: peerDm.id }),
  });
  const received = await callAgentTool(app, socket, secondRun, "peer-read", "tools.call", {
    name: "conversations.read",
    input: { conversationId: peerDm.id },
  });
  expect(received).toMatchObject({
    ok: true,
    result: {
      messages: [
        expect.objectContaining({
          text: "来自第一位同伴的消息。",
          author: { kind: "agent", id: firstAgentId },
        }),
      ],
    },
  });
  const ownerMessages = await app.http.request(`/api/owner/channels/${peerDm.id}/messages`, {
    headers: { cookie },
  });
  expect(ownerMessages.status).toBe(200);
  expect(await ownerMessages.json()).toMatchObject({
    messages: [expect.objectContaining({ text: "来自第一位同伴的消息。" })],
  });
});
