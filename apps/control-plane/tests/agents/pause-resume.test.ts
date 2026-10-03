import { toolTestInput } from "../support/agent/tool-run.js";

import { randomUUID } from "node:crypto";

import { afterEach, expect, it } from "vitest";

import { cleanupFixture, setup, login, pairNode } from "../support/agent/creation-fixture.js";
afterEach(cleanupFixture);

it("keeps manual pause until explicit resume, requires the original workspace, and allows unknown command results", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId, socket } = await pairNode(app, cookie);
  const id = randomUUID();
  app.agents.prepare({
    id,
    nodeId,
    name: "Partner",
    role: "Writer",
    description: "",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  const identity = {
    username: `mate_${id.replaceAll("-", "").slice(0, 27)}`,
    uid: 23001,
    gid: 23001,
    workspace: `/var/lib/mate/agents/${id}`,
    workspaceMarker: "a".repeat(64),
  };
  app.agents.complete(id, identity, app.chat);
  const sessionId = app.agents.get(id)!.sessionId;
  const pause = await app.request(`/api/owner/agents/${id}/pause`, {
    method: "POST",
    headers: { cookie },
  });
  expect(pause.status).toBe(200);
  expect(await pause.json()).toMatchObject({
    pausedReason: "manual",
    stop: { state: "executing" },
  });
  expect(app.runs?.pauseReason(id)).toBe("manual");
  expect(app.agents.get(id)).toMatchObject({
    sessionId,
    linuxIdentity: {
      username: identity.username,
      uid: identity.uid,
      gid: identity.gid,
      workspace: identity.workspace,
    },
  });
  const stopRequest = socket.sent
    .map((text) => JSON.parse(text) as Record<string, unknown>)
    .find(
      (message) =>
        message.type === "control.process.operation" &&
        (message.operation as { kind?: string })?.kind === "process.stop_all",
    )!;
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "node.process.operation.result",
      requestId: stopRequest.requestId,
      operationId: stopRequest.operationId,
      agentId: id,
      state: "unknown",
      receipt: { reason: "old_command_may_still_run" },
    }),
  );
  for (let attempt = 0; attempt < 30 && app.runs?.stopStatus(id).state !== "unknown"; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const resuming = app.request(`/api/owner/agents/${id}/resume`, {
    method: "POST",
    headers: { cookie },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const verify = socket.sent
    .map((text) => JSON.parse(text) as Record<string, unknown>)
    .find((message) => message.type === "control.agent.provision" && message.verifyOnly)!;
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "node.agent.provision.result",
      requestId: verify.requestId,
      agentId: id,
      ok: true,
      identity: { ...identity, workspaceMarker: "b".repeat(64) },
    }),
  );
  expect((await resuming).status).toBe(409);
  expect(app.runs?.pauseReason(id)).toBe("manual");
  const repaired = app.request(`/api/owner/agents/${id}/resume`, {
    method: "POST",
    headers: { cookie },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const retry = socket.sent
    .map((text) => JSON.parse(text))
    .filter((message) => message.type === "control.agent.provision")
    .at(-1)!;
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "node.agent.provision.result",
      requestId: retry.requestId,
      agentId: id,
      ok: true,
      identity,
    }),
  );
  expect((await repaired).status).toBe(200);
  expect(app.runs?.pauseReason(id)).toBeNull();
  expect(app.runs?.stopStatus(id).state).toBe("unknown");
  expect(app.agents.get(id)!.sessionId).toBe(sessionId);
});
