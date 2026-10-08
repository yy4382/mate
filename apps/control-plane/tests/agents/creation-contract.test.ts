import { toolTestInput } from "../support/agent/tool-run.js";

import { randomUUID } from "node:crypto";

import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { newAgentRequestSchema } from "../../src/agents/contracts.js";

import { cleanupFixture, setup, login, pairNode } from "../support/agent/creation-fixture.js";
afterEach(cleanupFixture);

it("keeps an offline-node Agent form unsubmitted", async () => {
  const app = setup();
  const cookie = await login(app);
  const input = {
    id: "ed1e60c8-bdda-4f46-a857-bbd542f82640",
    name: "Research partner",
    role: "Researches questions and reports evidence",
    description: "A private colleague for research work.",
    nodeId: "c5342142-9cf5-4b22-86f3-bdc46bb471f2",
    model: { provider: "openai", id: "gpt-4.1" },
  };

  const response = await app.http.request("/api/owner/agents", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "所选节点当前离线，Agent 资料尚未提交。" });
  const list = await app.http.request("/api/owner/agents", { headers: { cookie } });
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual({ agents: [] });
});

it("rejects a model outside the provider registry before persisting an Agent", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId, socket } = await pairNode(app, cookie);
  const input = {
    id: randomUUID(),
    name: "Invalid model partner",
    role: "Uses an available model",
    description: "A model registry validation fixture.",
    nodeId,
    model: { provider: "openai", id: "gpt-4.1-typo" },
  };
  const creation = app.http.request("/api/owner/agents", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const provision = socket.sent
    .map((text) => JSON.parse(text) as Record<string, unknown>)
    .find((message) => message.type === "control.agent.provision");
  if (provision) {
    await toolTestInput(
      app,
      socket,
      JSON.stringify({
        type: "node.agent.provision.result",
        requestId: provision.requestId,
        agentId: input.id,
        ok: false,
        code: "unsupported_host",
        message: "Synthetic provisioning failure.",
      }),
    );
  }
  const response = await creation;
  expect(response.status).toBe(400);
  expect(app.agents.list()).toHaveLength(0);
  expect(provision).toBeUndefined();
});

it("rejects credential fields outside the Agent creation contract", () => {
  const parsed = newAgentRequestSchema.safeParse({
    id: "ed1e60c8-bdda-4f46-a857-bbd542f82640",
    name: "Research partner",
    role: "Researches questions and reports evidence",
    description: "A private colleague for research work.",
    nodeId: "c5342142-9cf5-4b22-86f3-bdc46bb471f2",
    model: { provider: "openai", id: "gpt-4.1" },
    apiKeyEnv: "OPENAI_API_KEY",
  });
  expect(parsed.success).toBe(false);
});

it("sends only the bounded Agent provisioning operation to the selected online node", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId, socket } = await pairNode(app, cookie);
  const agentId = "ed1e60c8-bdda-4f46-a857-bbd542f82640";
  const requestId = randomUUID();
  const stages: string[] = [];
  const completed = app.nodes.provisionAgent(nodeId, requestId, agentId, (stage) =>
    stages.push(stage),
  );
  const command = JSON.parse(socket.sent.at(-1)!) as Record<string, unknown>;

  expect(command).toEqual({
    type: "control.agent.provision",
    requestId,
    agentId,
  });

  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "node.agent.provision.progress",
      requestId,
      agentId,
      stage: "preparing_workspace",
    }),
  );
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "node.agent.provision.result",
      requestId,
      agentId,
      ok: true,
      identity: {
        username: "mate_123456789012345678901234567",
        uid: 23001,
        gid: 23001,
        workspace: "/var/lib/mate/agents/ed1e60c8-bdda-4f46-a857-bbd542f82640",
        workspaceMarker: "a".repeat(64),
      },
    }),
  );

  await expect(completed).resolves.toMatchObject({
    ok: true,
    identity: { uid: 23001, gid: 23001 },
  });
  expect(stages).toEqual(["preparing_workspace"]);
  expect(socket.sent.join("\n")).not.toContain("useradd");
});
