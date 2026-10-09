import { afterEach, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import {
  cleanupAgentToolFixture,
  createAgentToolFixture,
  authorizeModel,
  addAgent,
  waitForRuns,
} from "../support/agent/agent-tool-fixture.js";

it("discovers and invokes conversation tools through the shared Agent tools interface", async () => {
  const { app, cookie, nodeId, socket } = await createAgentToolFixture();
  const agentId = addAgent(app, nodeId, "Tool caller");
  const direct = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
  await authorizeModel(app, cookie);
  app.chat.messages.createMessage({ channelId: direct.id, text: "Discover the available tools." });
  const run = (await waitForRuns(socket, 0, [agentId])).get(agentId)!;
  const identity = { runId: run.runId, nodeId, agentId, toolCallId: "shared-interface" };
  const listed = await app.tools.execute(identity, "tools.list", {});
  expect(listed).toMatchObject({
    ok: true,
    result: {
      tools: expect.arrayContaining([
        { name: "agents.list", description: expect.any(String) },
        { name: "workspace.read", description: expect.any(String) },
        { name: "attachments.publish", description: expect.any(String) },
        { name: "process.exec", description: expect.any(String) },
      ]),
    },
  });
  expect(
    await app.tools.execute(identity, "tools.describe", { name: "conversations.list" }),
  ).toMatchObject({
    ok: true,
    result: { name: "conversations.list", inputSchema: { type: "object" } },
  });
  expect(
    await app.tools.execute(identity, "tools.call", { name: "conversations.list", input: {} }),
  ).toMatchObject({
    ok: true,
    result: {
      conversations: expect.arrayContaining([
        {
          id: direct.id,
          name: direct.name,
          description: direct.description,
          visibility: "private",
          kind: "dm",
          member: true,
        },
      ]),
    },
  });
});

it("preserves the complete model-visible catalog and rejects invalid input before any effect", async () => {
  const { app, cookie, nodeId, socket } = await createAgentToolFixture();
  const agentId = addAgent(app, nodeId, "Catalog reader");
  const direct = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
  await authorizeModel(app, cookie);
  app.chat.messages.createMessage({ channelId: direct.id, text: "Inspect tools." });
  const run = (await waitForRuns(socket, 0, [agentId])).get(agentId)!;
  const identity = { runId: run.runId, nodeId, agentId, toolCallId: "catalog" };
  const surface = JSON.parse(
    readFileSync(new URL("../fixtures/agent-tool-surface.json", import.meta.url), "utf8"),
  ) as Array<{ name: string; description: string; inputSchema: unknown }>;
  expect(await app.tools.execute(identity, "tools.list", {})).toEqual({
    ok: true,
    result: { tools: surface.map(({ name, description }) => ({ name, description })) },
  });
  const messagesBefore = app.chat.timeline.listMessages(direct.id, undefined, 50);
  const sentBefore = socket.sent.length;
  for (const operation of surface) {
    expect(await app.tools.execute(identity, "tools.describe", { name: operation.name })).toEqual({
      ok: true,
      result: operation,
    });
    expect(
      await app.tools.execute(identity, "tools.call", {
        name: operation.name,
        input: { unexpected: true },
      }),
      operation.name,
    ).toEqual({ ok: false, error: "Invalid tool input" });
  }
  expect(await app.tools.execute(identity, "tools.call", { name: "toString", input: {} })).toEqual({
    ok: false,
    error: "Unknown operation",
  });
  expect(await app.tools.execute(identity, "tools.describe", { name: "__proto__" })).toEqual({
    ok: false,
    error: "Unknown operation",
  });
  expect(await app.tools.execute(identity, "tools.list", { extra: true })).toEqual({
    ok: false,
    error: "Invalid tool input",
  });
  expect(await app.tools.execute(identity, "tools.describe", {})).toEqual({
    ok: false,
    error: "Invalid tool input",
  });
  expect(
    await app.tools.execute(identity, "tools.call", { name: "agents.list", input: null }),
  ).toEqual({ ok: false, error: "Invalid tool input" });
  expect(socket.sent).toHaveLength(sentBefore);
  expect(app.chat.timeline.listMessages(direct.id, undefined, 50)).toEqual(messagesBefore);
});

afterEach(cleanupAgentToolFixture);
