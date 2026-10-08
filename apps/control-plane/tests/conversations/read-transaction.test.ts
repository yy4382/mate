import { toolTestInput } from "../support/agent/tool-run.js";

import { afterEach, expect, it } from "vitest";

import {
  cleanupAgentToolFixture,
  setup,
  authorizeModel,
  addAgent,
  waitForRuns,
} from "../support/agent/agent-tool-fixture.js";

it("rolls back all body-presentation changes when a synchronous read fails, and refuses reads after the run ends", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = addAgent(app, nodeId, "Atomic reader");
  const direct = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
  await authorizeModel(app, cookie);
  app.chat.messages.createMessage({ channelId: direct.id, text: "Start reading." });
  const run = (await waitForRuns(socket, 0, [agentId])).get(agentId)!;
  const first = app.chat.messages.createMessage({
    channelId: direct.id,
    text: "First unread body",
  })!;
  const second = app.chat.messages.createMessage({
    channelId: direct.id,
    text: "Second unread body",
  })!;
  const identity = { runId: run.runId, nodeId, agentId, toolCallId: "atomic-read" };
  const attention = () =>
    app.tools.execute(identity, "tools.call", {
      name: "attention.list",
      input: { conversationId: direct.id },
    });
  const before = await attention();
  expect(before).toMatchObject({
    ok: true,
    result: {
      items: expect.arrayContaining([
        expect.objectContaining({ messageId: first.id, unread: 1, seen: 0, presented: 0 }),
        expect.objectContaining({ messageId: second.id, unread: 1, seen: 0, presented: 0 }),
      ]),
    },
  });
  db.exec(`CREATE TRIGGER fail_read AFTER UPDATE ON owner_agent_message_attention
    WHEN NEW.message_id='${second.id}' AND NEW.presented=1
    BEGIN SELECT RAISE(ABORT, 'synthetic read failure'); END;`);
  const read = () =>
    app.tools.execute(identity, "tools.call", {
      name: "conversations.read",
      input: { conversationId: direct.id },
    });
  expect(await read()).toEqual({ ok: false, error: "Agent tool request was refused" });
  expect(await attention()).toEqual(before);
  db.exec("DROP TRIGGER fail_read");
  expect(await read()).toMatchObject({ ok: true });
  expect(await attention()).toMatchObject({
    ok: true,
    result: {
      items: expect.arrayContaining([
        expect.objectContaining({ messageId: first.id, unread: 1, seen: 0, presented: 1 }),
        expect.objectContaining({ messageId: second.id, unread: 1, seen: 0, presented: 1 }),
      ]),
    },
  });
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "run.complete",
      requestId: crypto.randomUUID(),
      runId: run.runId,
      agentId,
      ok: true,
    }),
  );
  app.runs?.close();
  await Promise.resolve();
  const after = db.serialize();
  expect(await read()).toEqual({ ok: false, error: "Agent run is no longer active" });
  expect(db.serialize()).toEqual(after);
});

afterEach(cleanupAgentToolFixture);
