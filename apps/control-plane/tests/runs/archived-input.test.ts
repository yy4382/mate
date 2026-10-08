import { toolTestInput } from "../support/agent/tool-run.js";

import { assistantEntry } from "../support/agent/session.js";

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

import { cleanupFixture, setup, waitForRun } from "../support/agent/conversation-fixture.js";
afterEach(cleanupFixture);

it("keeps an archived run input pending and retries it after the owner unarchives the channel", async () => {
  const { app, cookie, directory, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Recoverable archive partner",
    role: "Replies after its channel is restored",
    description: "Synthetic archived-run fixture.",
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
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  app.chat.createMessage(direct.id, "归档期间不可写入回复的私信。");
  const runStart = socket.sent.length;
  const credential = await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-archive-race-key" }),
  });
  expect(credential.status).toBe(204);
  const run = await waitForRun(socket, runStart);

  const archive = await app.http.request(`/api/owner/channels/${direct.id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });
  expect(archive.status).toBe(200);
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "session.append",
      requestId: randomUUID(),
      runId: run.runId,
      agentId,
      entry: assistantEntry("归档期间仍然只写进自己会话记录的正文。"),
    }),
  );
  // The private record is accepted, but it still publishes nothing.
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    type: "session.commit",
    accepted: true,
  });
  expect(app.chat.listMessages(direct.id, undefined, 20)?.messages).toMatchObject([
    { author: { kind: "human" }, text: "归档期间不可写入回复的私信。" },
  ]);

  // A successful turn still cannot consume an input from an archived conversation.
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "run.complete",
      requestId: run.runId,
      runId: run.runId,
      agentId,
      ok: true,
    }),
  );
  const db = new Database(join(directory, "control-plane", "control-plane.sqlite"), {
    readonly: true,
  });
  try {
    expect(
      db
        .prepare("SELECT state,error_code,retry_at FROM owner_agent_runs WHERE id=?")
        .get(run.runId),
    ).toEqual({ state: "failed", error_code: "channel_archived", retry_at: null });
  } finally {
    db.close();
  }
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toMatchObject([
    { message: { text: "归档期间不可写入回复的私信。" } },
  ]);

  const archivedRunCount = socket.sent.filter(
    (text) => JSON.parse(text).type === "test.run.started",
  ).length;
  await new Promise((resolve) => setTimeout(resolve, 1700));
  expect(socket.sent.filter((text) => JSON.parse(text).type === "test.run.started")).toHaveLength(
    archivedRunCount,
  );

  const retryStart = socket.sent.length;
  const unarchive = await app.http.request(`/api/owner/channels/${direct.id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ archived: false }),
  });
  expect(unarchive.status).toBe(200);
  const retry = await waitForRun(socket, retryStart);
  expect(retry.runId).not.toBe(run.runId);
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "session.append",
      requestId: randomUUID(),
      runId: retry.runId,
      agentId,
      entry: assistantEntry("频道恢复后记录的私有正文。"),
    }),
  );
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    type: "session.commit",
    accepted: true,
  });
  expect(app.chat.listMessages(direct.id, undefined, 20)?.messages).toMatchObject([
    { author: { kind: "human" }, text: "归档期间不可写入回复的私信。" },
  ]);
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "run.complete",
      requestId: retry.runId,
      runId: retry.runId,
      agentId,
      ok: true,
    }),
  );
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toHaveLength(0);
});
