import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { NodeControlMessageSchema } from "@mate/protocol";
import { workspaceReceiptRequestHash } from "@mate/protocol/node";
import {
  cleanupAgentToolFixture,
  addAgent,
  createAgentToolFixture,
} from "../support/agent/agent-tool-fixture.js";
import { eventually } from "../support/environment/run-services.js";

async function recordedOperations() {
  const context = await createAgentToolFixture();
  const agentId = addAgent(context.app, context.nodeId, "收据同事");
  const agent = context.app.agents.get(agentId)!;
  const channel = context.app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
  const sessionId = agent.sessionId;
  const runId = randomUUID();
  const operation = { kind: "write", path: "history.txt", content: "synthetic\n" } as const;
  const nodeRequestHash = workspaceReceiptRequestHash(agentId, operation);
  const insert = context.db.prepare(`INSERT INTO owner_agent_tool_actions
      (session_id,action_id,agent_id,operation,request_hash,result_json,created_at)
      VALUES(?,?,?,'workspace.write',?,?,?)`);
  return {
    ...context,
    agentId,
    operation,
    nodeRequestHash,
    record(operationId: string, state: "executing" | "unknown") {
      insert.run(
        sessionId,
        `synthetic:${operationId}`,
        agentId,
        createHash("sha256").update(JSON.stringify(operation)).digest("hex"),
        JSON.stringify({
          state,
          operationId,
          nodeRequestHash,
          runId,
          channelId: channel.id,
          operation: "workspace.write",
        }),
        Date.now(),
      );
    },
    state(operationId: string) {
      return z.object({ state: z.string() }).parse(
        context.db
          .prepare(
            `SELECT json_extract(result_json,'$.state') AS state
          FROM owner_agent_tool_actions WHERE action_id=?`,
          )
          .get(`synthetic:${operationId}`),
      ).state;
    },
    controls() {
      return context.socket.sent.flatMap((text) => {
        const parsed = NodeControlMessageSchema.safeParse(JSON.parse(text));
        return parsed.success ? [parsed.data] : [];
      });
    },
    async ping() {
      await context.app.nodes.receive(
        context.socket,
        JSON.stringify({ type: "node.ping", requestId: randomUUID(), sentAt: Date.now() }),
      );
    },
  };
}

it("continues past a whole page of in-flight writes and reconciles every historical operation across later pages and heartbeats", async () => {
  const context = await recordedOperations();
  const waiting = Array.from(
    { length: 100 },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
  const history = Array.from(
    { length: 101 },
    (_, index) => `ffffffff-ffff-4fff-8fff-${String(index).padStart(12, "0")}`,
  );
  const pending = waiting.map((operationId) => {
    context.record(operationId, "executing");
    return context.app.nodes.operations.workspaceOperation(context.nodeId, {
      type: "control.workspace.operation",
      requestId: randomUUID(),
      operationId,
      agentId: context.agentId,
      mode: "agent_action",
      operation: context.operation,
    });
  });
  const settled = Promise.allSettled(pending);
  for (const operationId of history) context.record(operationId, "unknown");
  const queried: string[] = [],
    errors: unknown[] = [];
  context.socket.onSend = (message) => {
    if (message.type !== "control.workspace.reconcile") return;
    queried.push(...message.operations.map(({ operationId }) => operationId));
    expect(
      message.operations.every(({ requestHash }) => requestHash === context.nodeRequestHash),
    ).toBe(true);
    void context.app.nodes
      .receive(
        context.socket,
        JSON.stringify({
          type: "node.workspace.reconcile.result",
          requestId: message.requestId,
          receipts: message.operations.map(({ operationId, agentId }) => ({
            operationId,
            agentId,
            result: {
              code: 0,
              stdout: '{"written":true}',
              stderr: "",
              truncated: false,
              revision: 2,
            },
          })),
        }),
      )
      .catch((error: unknown) => errors.push(error));
  };
  try {
    await context.ping();
    await eventually(
      () => (queried.length === history.length ? true : undefined),
      "all historical receipt pages",
      1500,
    );
    await eventually(
      () => (history.every((id) => context.state(id) === "succeeded") ? true : undefined),
      "confirmed historical receipts",
    );
    expect(queried).toEqual(history);
    expect(waiting.every((id) => context.state(id) === "executing")).toBe(true);
    expect(
      context
        .controls()
        .filter((message) => message.type === "control.workspace.reconcile")
        .map((message) => message.operations.length),
    ).toEqual([100, 1]);
    await context.ping();
    expect(queried).toEqual(history);
    expect(
      context.controls().filter((message) => message.type === "control.workspace.operation"),
    ).toHaveLength(100);
    expect(errors).toEqual([]);
  } finally {
    context.app.nodes.close(context.socket);
    await settled;
  }
});

it("keeps missing and conflicting historical receipts unknown and accepts a valid late receipt without replay", async () => {
  const context = await recordedOperations(),
    operationId = randomUUID(),
    result = { code: 0, stdout: '{"written":true}', stderr: "", truncated: false, revision: 2 },
    valid = { operationId, agentId: context.agentId, result };
  context.record(operationId, "unknown");
  for (const { receipts, state } of [
    { receipts: [], state: "unknown" },
    { receipts: [{ ...valid, agentId: randomUUID() }], state: "unknown" },
    { receipts: [valid, valid], state: "unknown" },
    { receipts: [{ ...valid, operationId: randomUUID() }], state: "unknown" },
    { receipts: [valid], state: "succeeded" },
  ]) {
    await context.ping();
    const query = context
      .controls()
      .filter((message) => message.type === "control.workspace.reconcile")
      .at(-1);
    expect(query?.operations).toEqual([
      { operationId, agentId: context.agentId, requestHash: context.nodeRequestHash },
    ]);
    await context.app.nodes.receive(
      context.socket,
      JSON.stringify({
        type: "node.workspace.reconcile.result",
        requestId: query?.requestId,
        receipts,
      }),
    );
    expect(context.state(operationId)).toBe(state);
  }
  expect(
    context.controls().filter((message) => message.type === "control.workspace.operation"),
  ).toHaveLength(0);
  expect(
    context.db
      .prepare(
        "SELECT COUNT(*) AS count FROM owner_agent_activity WHERE kind='receipt.corrected' AND reference_id=?",
      )
      .get(operationId),
  ).toEqual({ count: 1 });
});

afterEach(cleanupAgentToolFixture);
