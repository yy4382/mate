import { toolTestInput } from "../support/agent/tool-run.js";

import { randomUUID } from "node:crypto";

import { afterEach, expect, it } from "vitest";

import { AgentRequestConflict } from "../../src/agents/directory.js";

import {
  cleanupFixture,
  setup,
  databaseFor,
  login,
  pairNode,
} from "../support/agent/creation-fixture.js";
afterEach(cleanupFixture);

it("persists a stable Agent session, verifies provisioning, then queues its initial-channel messages", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId, socket } = await pairNode(app, cookie);
  const channelResponse = await app.request("/api/owner/channels", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Research", description: "Research work", visibility: "private" }),
  });
  expect(channelResponse.status).toBe(201);
  const { id: channelId } = (await channelResponse.json()) as { id: string };
  const input = {
    id: "ed1e60c8-bdda-4f46-a857-bbd542f82640",
    name: "Research partner",
    role: "Researches questions and reports evidence",
    description: "A private colleague for research work.",
    nodeId,
    model: { provider: "openai", id: "gpt-4.1" },
    initialChannelId: channelId,
  };

  const creation = app.request("/api/owner/agents", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const command = JSON.parse(socket.sent.at(-1)!) as {
    type: string;
    requestId: string;
    agentId: string;
  };
  expect(command).toEqual({
    type: "control.agent.provision",
    requestId: expect.any(String),
    agentId: input.id,
  });
  expect(app.chat.inviteAgentToChannel(channelId, input.id)).toBe(false);
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "node.agent.provision.progress",
      requestId: command.requestId,
      agentId: input.id,
      stage: "preparing_workspace",
    }),
  );
  const progressResponse = await app.request("/api/owner/agents", { headers: { cookie } });
  const progress = (await progressResponse.json()) as { agents: Array<{ stage: string }> };
  expect(progress.agents[0]?.stage).toBe("preparing_workspace");
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "node.agent.provision.result",
      requestId: command.requestId,
      agentId: input.id,
      ok: true,
      identity: {
        username: "mate_ed1e60c8bdda4f46a857bbd542f",
        uid: 23001,
        gid: 23001,
        workspace: `/var/lib/mate/agents/${input.id}`,
        workspaceMarker: "a".repeat(64),
      },
    }),
  );

  const response = await creation;
  expect(response.status).toBe(201);
  const { agent } = (await response.json()) as {
    agent: {
      id: string;
      sessionId: string;
      status: string;
      stage: string;
      model: { provider: string; id: string };
      linuxIdentity: { username: string; uid: number; gid: number; workspace: string };
    };
  };
  expect(agent).toMatchObject({
    id: input.id,
    status: "waiting_credentials",
    stage: "complete",
    model: input.model,
    linuxIdentity: {
      username: "mate_ed1e60c8bdda4f46a857bbd542f",
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${input.id}`,
    },
  });
  expect(app.chat.inviteAgentToChannel(channelId, input.id)).toBe(true);
  const sentCount = socket.sent.length;
  const repeat = await app.request("/api/owner/agents", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  expect(repeat.status).toBe(200);
  expect(((await repeat.json()) as { agent: { sessionId: string } }).agent.sessionId).toBe(
    agent.sessionId,
  );
  expect(socket.sent).toHaveLength(sentCount);

  app.chat.createMessage(channelId, "A queued first message");
  expect(app.chat.listPendingDeliveries("agent", input.id).deliveries).toHaveLength(1);
});

it("retains one failed request and retries it with the same Agent and provisioning IDs", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId, socket } = await pairNode(app, cookie);
  const input = {
    id: "a82eb7db-26f7-40f8-9bb8-8baf21dc5c0a",
    name: "Writing partner",
    role: "Writes and edits",
    description: "A writing colleague.",
    nodeId,
    model: { provider: "openai", id: "gpt-4.1" },
  };
  const failedCreation = app.request("/api/owner/agents", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const firstCommand = JSON.parse(socket.sent.at(-1)!) as { requestId: string };
  const concurrentDuplicate = app.request("/api/owner/agents", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "node.agent.provision.result",
      requestId: firstCommand.requestId,
      agentId: input.id,
      ok: false,
      code: "permission_denied",
      message: "节点无法创建 Agent 工作区根路径，请检查运行账号的写入权限。",
    }),
  );
  const [failed, concurrentFailed] = await Promise.all([failedCreation, concurrentDuplicate]);
  expect(failed.status).toBe(502);
  expect(concurrentFailed.status).toBe(502);
  const failedAgent = (await failed.json()) as { agent: { sessionId: string; status: string } };
  const concurrentFailedAgent = (await concurrentFailed.json()) as {
    agent: { sessionId: string; status: string };
  };
  expect(failedAgent.agent.status).toBe("failed");
  expect(concurrentFailedAgent.agent).toEqual(failedAgent.agent);

  const retry = app.request("/api/owner/agents", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const secondCommand = JSON.parse(socket.sent.at(-1)!) as {
    type: string;
    requestId: string;
    agentId: string;
  };
  expect(secondCommand).toEqual({
    ...firstCommand,
    type: "control.agent.provision",
    agentId: input.id,
  });
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "node.agent.provision.result",
      requestId: secondCommand.requestId,
      agentId: input.id,
      ok: true,
      identity: {
        username: "mate_a82eb7db26f740f89bb88baf21d",
        uid: 23002,
        gid: 23002,
        workspace: `/var/lib/mate/agents/${input.id}`,
        workspaceMarker: "a".repeat(64),
      },
    }),
  );
  const succeeded = await retry;
  expect(succeeded.status).toBe(200);
  const agent = (await succeeded.json()) as {
    agent: { id: string; sessionId: string; status: string };
  };
  expect(agent.agent).toMatchObject({
    id: input.id,
    sessionId: failedAgent.agent.sessionId,
    status: "waiting_credentials",
  });
});

it("refuses an Agent whose node reports a different account than the one it already runs", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId } = await pairNode(app, cookie);
  const request = (id: string, name: string) => ({
    id,
    name,
    role: "Runs under one account",
    description: "Synthetic single-account identity fixture.",
    nodeId,
    model: { provider: "openai", id: "gpt-4.1" },
  });
  const identity = (agentId: string, account: { username: string; uid: number; gid: number }) => ({
    ...account,
    workspace: `/var/lib/mate/agents/${agentId}`,
    workspaceMarker: "a".repeat(64),
  });
  const firstId = "a82eb7db-26f7-40f8-9bb8-8baf21dc5c0a";
  app.agents.prepare(request(firstId, "First partner"));
  expect(() =>
    app.agents.complete(
      firstId,
      identity(firstId, { username: "mate-node-account", uid: 23001, gid: 23001 }),
      app.chat,
    ),
  ).not.toThrow();

  // The second Agent on the same node must report the identical account; a different username,
  // UID or GID means the node is not the single ordinary account this release requires.
  for (const account of [
    { username: "mate-other-account", uid: 23001, gid: 23001 },
    { username: "mate-node-account", uid: 23002, gid: 23001 },
    { username: "mate-node-account", uid: 23001, gid: 23002 },
  ]) {
    const secondId = randomUUID();
    app.agents.prepare(request(secondId, "Second partner"));
    expect(() => app.agents.complete(secondId, identity(secondId, account), app.chat)).toThrow(
      AgentRequestConflict,
    );
    // A refused account leaves no partial completion behind: the node keeps the account it
    // already runs under, and the Agent keeps neither a workspace nor a finished stage.
    expect(app.agents.get(secondId)).toMatchObject({
      status: "provisioning",
      stage: "queued",
      linuxIdentity: null,
    });
    const inspect = databaseFor(app);
    try {
      expect(
        inspect.prepare("SELECT home,home_marker FROM owner_agents WHERE id=?").get(secondId),
      ).toEqual({ home: null, home_marker: null });
    } finally {
      inspect.close();
    }
  }
  const inspect = databaseFor(app);
  try {
    expect(
      inspect.prepare("SELECT linux_username,uid,gid FROM nodes WHERE id=?").get(nodeId),
    ).toEqual({ linux_username: "mate-node-account", uid: 23001, gid: 23001 });
  } finally {
    inspect.close();
  }

  const thirdId = randomUUID();
  app.agents.prepare(request(thirdId, "Third partner"));
  const completed = app.agents.complete(
    thirdId,
    identity(thirdId, { username: "mate-node-account", uid: 23001, gid: 23001 }),
    app.chat,
  );
  expect(completed.linuxIdentity).toEqual({
    username: "mate-node-account",
    uid: 23001,
    gid: 23001,
    workspace: `/var/lib/mate/agents/${thirdId}`,
  });
});

it("refuses to complete an Agent whose node reports it is running as root", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId } = await pairNode(app, cookie);
  const identity = (agentId: string, account: { uid: number; gid: number }) => ({
    username: "root",
    ...account,
    workspace: `/home/mate/agents/${agentId}`,
    workspaceMarker: "a".repeat(64),
  });

  // A first Agent must not be accepted either: this release never runs the node as root, so a
  // root-account report is a deployment fact the owner has to fix, not a usable Agent identity.
  for (const account of [
    { uid: 0, gid: 0 },
    { uid: 0, gid: 1000 },
    { uid: 1000, gid: 0 },
  ]) {
    const agentId = randomUUID();
    app.agents.prepare({
      id: agentId,
      nodeId,
      name: "Root partner",
      role: "Runs under one account",
      description: "Synthetic root-account rejection fixture.",
      model: { provider: "openai", id: "gpt-4.1" },
    });
    expect(() => app.agents.complete(agentId, identity(agentId, account), app.chat)).toThrow(
      AgentRequestConflict,
    );
    expect(app.agents.get(agentId)?.status).toBe("provisioning");
    expect(app.agents.get(agentId)?.linuxIdentity).toBeNull();
  }
});
