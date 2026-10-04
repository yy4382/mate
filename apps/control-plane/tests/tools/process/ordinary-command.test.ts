import { toolTestInput } from "../../support/agent/tool-run.js";

import { randomUUID } from "node:crypto";

import { afterEach, expect, it } from "vitest";

import {
  password,
  cleanupFixture,
  setup,
  waitForRun,
  sendTool,
} from "../../support/agent/process-tool-fixture.js";
afterEach(cleanupFixture);

it("dispatches ordinary commands from a durable intent without privileged approval", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Process operator",
    role: "Runs ordinary commands",
    description: "Synthetic process tool fixture.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: `mate_${agentId.replaceAll("-", "").slice(0, 27)}`,
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${agentId}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-process-tool-key" }),
  });
  const startAt = socket.sent.length;
  app.chat.createMessage(direct.id, "Use the ordinary process tools.");
  const run = await waitForRun(socket, startAt);

  await sendTool(app, socket, run, "list-process-tools", "tools.list", {});
  const listed = JSON.parse(socket.sent.at(-1)!) as {
    result?: { tools?: Array<{ name: string }> };
  };
  expect(listed.result?.tools?.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["process.exec", "process.list", "process.inspect", "process.stop"]),
  );
  await sendTool(app, socket, run, "describe-process-exec", "tools.describe", {
    name: "process.exec",
  });
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    ok: true,
    result: {
      name: "process.exec",
      inputSchema: { properties: { command: { type: "string" } } },
    },
  });

  const scope = run.actionScopeId,
    toolCallId = `mate:${scope}:${"a".repeat(64)}:1`;
  let intentWasCommittedBeforeDispatch = false;
  socket.onSend = (message) => {
    if (message.type !== "control.process.operation") return;
    intentWasCommittedBeforeDispatch = Boolean(
      db
        .prepare(
          `SELECT 1 FROM owner_agent_process_operations
           WHERE operation_id=? AND agent_id=? AND state='executing'`,
        )
        .get(message.operationId, agentId),
    );
  };
  const toolResultPromise = sendTool(app, socket, run, toolCallId, "tools.call", {
    name: "process.exec",
    input: { command: "printf command-ran" },
  });
  const deadline = Date.now() + 4000;
  let processRequest: Record<string, unknown> | undefined;
  while (Date.now() < deadline && !processRequest) {
    processRequest = socket.sent
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find((message) => message.type === "control.process.operation");
    if (!processRequest) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(processRequest).toMatchObject({
    type: "control.process.operation",
    agentId,
    operation: { kind: "exec", command: "printf command-ran", cwd: "." },
  });
  expect(intentWasCommittedBeforeDispatch).toBe(true);
  expect(
    db
      .prepare("SELECT state FROM owner_agent_process_operations WHERE operation_id=?")
      .get(processRequest!.operationId),
  ).toEqual({ state: "executing" });

  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "node.process.operation.result",
      requestId: processRequest!.requestId,
      operationId: processRequest!.operationId,
      agentId,
      state: "succeeded",
      receipt: { code: 0, stdout: "command-ran", stderr: "", truncated: false },
    }),
  );
  await toolResultPromise;
  const reply = JSON.parse(socket.sent.at(-1)!) as {
    type: string;
    ok: boolean;
    result?: { operationId: string; state: string; receipt: { stdout: string } };
  };
  expect(reply).toMatchObject({
    type: "tools.result",
    ok: true,
    result: {
      operationId: processRequest!.operationId,
      state: "succeeded",
      receipt: { stdout: "command-ran" },
    },
  });
  expect(
    db
      .prepare("SELECT state FROM owner_agent_process_operations WHERE operation_id=?")
      .get(processRequest!.operationId),
  ).toEqual({ state: "succeeded" });
  expect(socket.sent.some((text) => text.includes("approval"))).toBe(false);
});

it("offers no privileged request or approval-status tool and no owner approval route", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Ordinary operator",
    role: "Runs ordinary commands",
    description: "Synthetic tool surface fixture.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: `mate_${agentId.replaceAll("-", "").slice(0, 27)}`,
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${agentId}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tool-surface-key" }),
  });
  const startAt = socket.sent.length;
  app.chat.createMessage(direct.id, "What can you run?");
  const run = await waitForRun(socket, startAt);

  await sendTool(app, socket, run, "list-all-tools", "tools.list", {});
  const names = (
    JSON.parse(socket.sent.at(-1)!) as { result?: { tools?: Array<{ name: string }> } }
  ).result?.tools?.map((tool) => tool.name);
  expect(names).toContain("process.exec");
  expect(names).not.toContain("system.exec");
  expect(names).not.toContain("system.status");

  for (const name of ["system.exec", "system.status"])
    await sendTool(app, socket, run, `describe-${name}`, "tools.describe", { name });
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ ok: false, error: "Unknown operation" });

  await sendTool(app, socket, run, "request-root", "tools.call", {
    name: "system.exec",
    input: { program: "/usr/bin/id", args: ["-u"], cwd: "/tmp" },
  });
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ ok: false, error: "Unknown operation" });
  expect(socket.sent.some((text) => text.includes("control.privileged"))).toBe(false);

  const requestId = randomUUID();
  expect(
    (await app.request(`/api/owner/channels/${direct.id}/approvals`, { headers: { cookie } }))
      .status,
  ).toBe(404);
  expect(
    (await app.request(`/api/owner/approvals/${requestId}`, { headers: { cookie } })).status,
  ).toBe(404);
  expect(
    (
      await app.request(`/api/owner/approvals/${requestId}/decision`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ decision: "approve" }),
      })
    ).status,
  ).toBe(404);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%privileged%'").all()).toEqual(
    [],
  );
});

it("runs an explicit sudo the Agent wrote as one ordinary command with its own result", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Sudo operator",
    role: "Runs ordinary commands",
    description: "Synthetic sudo fixture.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: `mate_${agentId.replaceAll("-", "").slice(0, 27)}`,
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${agentId}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-sudo-key" }),
  });
  const startAt = socket.sent.length;
  app.chat.createMessage(direct.id, "Run a command that asks for root.");
  const run = await waitForRun(socket, startAt);

  const command = "sudo -n systemctl restart nginx";
  const toolResult = sendTool(
    app,
    socket,
    run,
    `mate:${run.actionScopeId}:${"b".repeat(64)}:1`,
    "tools.call",
    {
      name: "process.exec",
      input: { command },
    },
  );
  const deadline = Date.now() + 4000;
  let processRequest: Record<string, unknown> | undefined;
  while (Date.now() < deadline && !processRequest) {
    processRequest = socket.sent
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find((message) => message.type === "control.process.operation");
    if (!processRequest) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The command reaches the node exactly as written: no elevation, wrapping or approval step.
  expect(processRequest).toMatchObject({
    type: "control.process.operation",
    operation: { kind: "exec", command },
  });

  // The host decided the command failed; the Agent gets that ordinary receipt and nothing else.
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "node.process.operation.result",
      requestId: processRequest!.requestId,
      operationId: processRequest!.operationId,
      agentId,
      state: "failed",
      receipt: { code: 1, stdout: "", stderr: "sudo: a password is required\n" },
    }),
  );
  await toolResult;
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    ok: true,
    result: {
      state: "failed",
      receipt: { code: 1, stderr: "sudo: a password is required\n" },
    },
  });
  expect(
    db
      .prepare(
        `SELECT state FROM owner_agent_process_operations WHERE operation_id=? AND agent_id=?`,
      )
      .get(processRequest!.operationId, agentId),
  ).toEqual({ state: "failed" });
  expect(socket.sent.some((text) => text.includes("privileged"))).toBe(false);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%privileged%'").all()).toEqual(
    [],
  );
});
