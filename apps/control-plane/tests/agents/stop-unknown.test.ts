import { toolTestInput } from "../support/agent/tool-run.js";

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import {
  fixtures,
  cleanupFixture,
  setup,
  login,
  pairNode,
} from "../support/agent/creation-fixture.js";
afterEach(cleanupFixture);

it("reports an earlier command whose termination the node cannot confirm as unknown, not stopped", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId, socket } = await pairNode(app, cookie);
  const id = randomUUID();
  app.agents.prepare({
    id,
    nodeId,
    name: "Interrupted command",
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
  // A command really started, and the node then restarted: the node's own restart mute says its
  // shutdown left the command's fate unproven. Only the node's durable receipt can say that.
  const directory = fixtures.at(-1)!.directory,
    db = new Database(join(directory, "control-plane", "control-plane.sqlite")),
    earlierOperationId = randomUUID(),
    runId = randomUUID(),
    at = Date.now();
  try {
    const channel = app.chat.getOrCreateAgentDirectChannel(id)!;
    app.chat.createMessage(channel.id, "先跑一条普通命令。");
    const delivery = db
      .prepare(
        `SELECT id FROM owner_message_deliveries
         WHERE recipient_kind='agent' AND recipient_id=? ORDER BY seq DESC LIMIT 1`,
      )
      .get(id) as { id: string };
    db.prepare(
      `INSERT INTO owner_agent_runs(
         id,agent_id,node_id,delivery_id,state,started_at,input_end_seq,context_history_end_seq
       ) VALUES(?,?,?,?, 'failed',?,1,1)`,
    ).run(runId, id, nodeId, delivery.id, at);
    db.prepare(
      `INSERT INTO owner_agent_process_operations(
        operation_id,run_id,agent_id,node_id,
        request_hash,request_json,state,receipt_json,node_receipt_confirmed,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,'unknown',?,1,?,?)`,
    ).run(
      earlierOperationId,
      runId,
      id,
      nodeId,
      "d".repeat(64),
      JSON.stringify({
        actionScopeId: delivery.id,
        stableActionId: `mate:${delivery.id}:${"d".repeat(64)}:1`,
        nodeId,
        agentId: id,
        operation: { kind: "exec", command: "sleep 300" },
      }),
      JSON.stringify({ reason: "node_restarted_during_operation" }),
      at,
      at,
    );
    expect(
      (await app.request(`/api/owner/agents/${id}/pause`, { method: "POST", headers: { cookie } }))
        .status,
    ).toBe(200);
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
        state: "succeeded",
        receipt: { stopped: true, operationIds: [], scope: "this_node_run" },
      }),
    );
    for (let attempt = 0; attempt < 30 && app.runs?.stopStatus(id).state !== "succeeded"; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const stop = app.runs!.stopStatus(id);
    // This node run started nothing, so its stop is a real success — but the earlier command is
    // exactly the gap it cannot speak for, and the owner must see that as unknown.
    expect(stop).toMatchObject({ state: "succeeded", scope: "this_node_run" });
    expect(stop.unconfirmedOperationIds).toEqual([earlierOperationId]);
  } finally {
    db.close();
  }
});

it("counts every command whose termination nothing proved, however the node answered", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId, socket } = await pairNode(app, cookie);
  const id = randomUUID();
  app.agents.prepare({
    id,
    nodeId,
    name: "Surviving group",
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
  const directory = fixtures.at(-1)!.directory,
    db = new Database(join(directory, "control-plane", "control-plane.sqlite")),
    at = Date.now();
  // Four durable records: a command the node itself could not end, one Mate had to end that still
  // left a descendant alive, one that exited zero but left a background descendant in its group, and
  // one that provably never launched a shell.
  const survivedStop = randomUUID(),
    survivorsLeft = randomUUID(),
    descendantLeft = randomUUID(),
    neverStarted = randomUUID(),
    rejectedByNode = randomUUID();
  try {
    const channel = app.chat.getOrCreateAgentDirectChannel(id)!;
    app.chat.createMessage(channel.id, "先跑几条普通命令。");
    const delivery = db
      .prepare(
        `SELECT id FROM owner_message_deliveries
         WHERE recipient_kind='agent' AND recipient_id=? ORDER BY seq DESC LIMIT 1`,
      )
      .get(id) as { id: string };
    const runId = randomUUID();
    db.prepare(
      `INSERT INTO owner_agent_runs(
         id,agent_id,node_id,delivery_id,state,started_at,input_end_seq,context_history_end_seq
       ) VALUES(?,?,?,?, 'failed',?,1,1)`,
    ).run(runId, id, nodeId, delivery.id, at);
    const insert = (operationId: string, command: string, state: string, receipt: unknown) =>
      db
        .prepare(
          `INSERT INTO owner_agent_process_operations(
             operation_id,run_id,agent_id,node_id,
             request_hash,request_json,state,receipt_json,node_receipt_confirmed,created_at,updated_at
           ) VALUES(?,?,?,?,?,?,?,?,1,?,?)`,
        )
        .run(
          operationId,
          runId,
          id,
          nodeId,
          "e".repeat(64),
          JSON.stringify({
            actionScopeId: delivery.id,
            stableActionId: `mate:${delivery.id}:${"e".repeat(64)}:1`,
            nodeId,
            agentId: id,
            operation: { kind: "exec", command },
          }),
          state,
          JSON.stringify(receipt),
          at,
          at,
        );
    insert(neverStarted, "true", "failed", { reason: "command_not_started" });
    insert(survivorsLeft, "sleep 300", "failed", {
      code: null,
      signal: "SIGKILL",
      timedOut: true,
      processGroupRunning: true,
    });
    insert(survivedStop, "sleep 300", "failed", { reason: "process_stop_unconfirmed" });
    // A successful shell that left a background descendant: the command exited 0 and its process
    // group is still there, which is exactly what the node reports as "descendants_running".
    insert(descendantLeft, "sleep 300 &", "succeeded", {
      code: 0,
      signal: null,
      timedOut: false,
      processGroupRunning: true,
    });
    await app.request(`/api/owner/agents/${id}/pause`, { method: "POST", headers: { cookie } });
    const stopRequest = socket.sent
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find(
        (message) =>
          message.type === "control.process.operation" &&
          (message.operation as { kind?: string })?.kind === "process.stop_all",
      )!;
    // The restarted node's stop ran, and it says which group it could not end.
    await toolTestInput(
      app,
      socket,
      JSON.stringify({
        type: "node.process.operation.result",
        requestId: stopRequest.requestId,
        operationId: stopRequest.operationId,
        agentId: id,
        state: "failed",
        receipt: {
          reason: "process_stop_unconfirmed",
          stopped: false,
          operationIds: [],
          unconfirmedOperationIds: [survivedStop],
          scope: "this_node_run",
        },
      }),
    );
    for (let attempt = 0; attempt < 30 && app.runs?.stopStatus(id).state === "executing"; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const stop = app.runs!.stopStatus(id);
    expect(stop).toMatchObject({ state: "failed", scope: "this_node_run" });
    expect(stop.unconfirmedOperationIds?.slice().sort()).toEqual(
      [descendantLeft, survivedStop, survivorsLeft].sort(),
    );
    // A command whose shell never started is a proven result, not an unproven one.
    expect(stop.unconfirmedOperationIds).not.toContain(neverStarted);
    expect(stop.unconfirmedOperationIds).not.toContain(rejectedByNode);
    const activity = (await (
      await app.request(`/api/owner/agents/${id}/activity?detail=1`, { headers: { cookie } })
    ).json()) as {
      events: Array<{ kind: string; summary: string; referenceId: string | null }>;
    };
    const finished = activity.events.find(
      (event) =>
        event.kind === "operation.finished" && event.referenceId === stopRequest.operationId,
    );
    expect(finished?.summary).toContain("3 条命令的终止无法确认");
  } finally {
    db.close();
  }
});

it("uses a fresh stop operation ID after an unknown node receipt", async () => {
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
  const pause = () =>
    app.request(`/api/owner/agents/${id}/pause`, { method: "POST", headers: { cookie } });
  expect((await pause()).status).toBe(200);
  const stopRequests = () =>
    socket.sent
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .filter(
        (message) =>
          message.type === "control.process.operation" &&
          (message.operation as { kind?: string })?.kind === "process.stop_all",
      );
  const first = stopRequests()[0]!;
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "node.process.operation.result",
      requestId: first.requestId,
      operationId: first.operationId,
      agentId: id,
      state: "unknown",
      receipt: { reason: "synthetic_systemctl_timeout" },
    }),
  );
  for (let attempt = 0; attempt < 30 && app.runs?.stopStatus(id).state === "executing"; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(app.runs?.stopStatus(id).state).toBe("unknown");
  expect((await pause()).status).toBe(200);
  const second = stopRequests()[1]!;
  expect(second.operationId).not.toBe(first.operationId);
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "node.process.operation.result",
      requestId: first.requestId,
      operationId: first.operationId,
      agentId: id,
      state: "succeeded",
      receipt: { stopped: true, units: [] },
    }),
  );
  expect(app.runs?.stopStatus(id).state).toBe("executing");
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "node.process.operation.result",
      requestId: second.requestId,
      operationId: second.operationId,
      agentId: id,
      state: "succeeded",
      receipt: { stopped: true, units: [] },
    }),
  );
  for (let attempt = 0; attempt < 30 && app.runs?.stopStatus(id).state !== "succeeded"; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(app.runs?.stopStatus(id).state).toBe("succeeded");
});
