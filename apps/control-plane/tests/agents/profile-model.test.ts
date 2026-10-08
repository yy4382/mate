import { randomUUID } from "node:crypto";

import { afterEach, expect, it } from "vitest";

import { cleanupFixture, setup, login, pairNode } from "../support/agent/creation-fixture.js";
afterEach(cleanupFixture);

it("edits each profile field without changing an Agent's identity or session", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId } = await pairNode(app, cookie);
  const id = randomUUID();
  const input = {
    id,
    nodeId,
    name: "Original",
    role: "Researcher",
    description: "First description",
    model: { provider: "openai", id: "gpt-4.1" },
  };
  app.agents.prepare(input);
  app.agents.complete(
    id,
    {
      username: `mate_${id.replaceAll("-", "").slice(0, 27)}`,
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${id}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  const before = app.agents.get(id)!;
  for (const patch of [
    { name: "Renamed" },
    { role: "Writer" },
    { description: "New description" },
  ]) {
    const response = await app.http.request(`/api/owner/agents/${id}/profile`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    expect(response.status).toBe(200);
  }
  expect(app.agents.get(id)).toMatchObject({
    id,
    nodeId,
    name: "Renamed",
    role: "Writer",
    description: "New description",
    sessionId: before.sessionId,
    linuxIdentity: before.linuxIdentity,
  });
});

it("requires an existing provider key before changing the model and preserves the Agent session", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId } = await pairNode(app, cookie);
  const id = randomUUID();
  app.agents.prepare({
    id,
    nodeId,
    name: "Partner",
    role: "Writer",
    description: "",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    id,
    {
      username: `mate_${id.replaceAll("-", "").slice(0, 27)}`,
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${id}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  const sessionId = app.agents.get(id)!.sessionId;
  const change = (model: object) =>
    app.http.request(`/api/owner/agents/${id}/model`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(model),
    });
  expect((await change({ provider: "openai", id: "gpt-4.1-mini" })).status).toBe(409);
  expect(app.agents.get(id)!.model).toEqual({ provider: "openai", id: "gpt-4.1" });
  const key = await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-key" }),
  });
  expect(key.status).toBe(204);
  expect((await change({ provider: "openai", id: "gpt-4.1-mini" })).status).toBe(200);
  expect(app.agents.get(id)).toMatchObject({
    model: { provider: "openai", id: "gpt-4.1-mini" },
    sessionId,
  });
});
