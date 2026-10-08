import { randomUUID } from "node:crypto";

import { afterEach, expect, it } from "vitest";

import { cleanupFixture, setup, login, pairNode } from "../support/agent/creation-fixture.js";
afterEach(cleanupFixture);

it("finds an online Agent beyond more than one page of offline deliveries", async () => {
  const app = setup();
  const cookie = await login(app);
  const offlineNode = await pairNode(app, cookie),
    onlineNode = await pairNode(app, cookie);
  app.nodes.close(offlineNode.socket);

  for (let index = 0; index < 105; index++) {
    const id = randomUUID();
    app.agents.prepare({
      id,
      nodeId: offlineNode.id,
      name: `Offline ${index}`,
      role: "Waits for a model run",
      description: "Synthetic scheduler fairness fixture.",
      model: { provider: "openai", id: "gpt-4.1" },
    });
    app.agents.complete(
      id,
      {
        // One ordinary account carries every Agent on a node; only the workspace differs.
        username: "mate-offline-node",
        uid: 24000,
        gid: 24000,
        workspace: `/var/lib/mate/agents/${id}`,
        workspaceMarker: "a".repeat(64),
      },
      app.chat,
    );
    const direct = app.chat.conversations.getOrCreateAgentDirectChannel(id)!;
    app.chat.messages.createMessage({
      channelId: direct.id,
      text: `离线 Agent ${index} 的排队输入。`,
    });
  }

  const onlineAgentId = randomUUID();
  app.agents.prepare({
    id: onlineAgentId,
    nodeId: onlineNode.id,
    name: "Online partner",
    role: "Runs when ready",
    description: "Must not be starved by offline entries.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    onlineAgentId,
    {
      username: "mate-online-node",
      uid: 25001,
      gid: 25001,
      workspace: `/var/lib/mate/agents/${onlineAgentId}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  const onlineDirect = app.chat.conversations.getOrCreateAgentDirectChannel(onlineAgentId)!;
  app.chat.messages.createMessage({ channelId: onlineDirect.id, text: "在线 Agent 的排队输入。" });

  const credential = await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-scheduler-key" }),
  });
  expect(credential.status).toBe(204);
  const deadline = Date.now() + 3000;
  let run: Record<string, unknown> | undefined;
  while (Date.now() < deadline && !run) {
    run = onlineNode.socket.sent
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find((message) => message.type === "test.run.started" && message.agentId === onlineAgentId);
    if (!run) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(run).toMatchObject({
    type: "test.run.started",
    agentId: onlineAgentId,
    channelId: onlineDirect.id,
  });
  expect(app.chat.deliveries.listPendingDeliveries("agent", onlineAgentId).deliveries).toHaveLength(
    1,
  );
});
