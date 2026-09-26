import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  AgentProcessOperationBroker,
  deriveAgentProcessOperationId,
} from "../../src/control-plane/agent-process-operations.js";
import { agentProcessOperationsSchemaV13 } from "../../src/control-plane/process-operations-schema.js";

function setup() {
  const database = new Database(":memory:");
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE nodes(id TEXT PRIMARY KEY);
    CREATE TABLE owner_agents(id TEXT PRIMARY KEY,node_id TEXT NOT NULL,status TEXT NOT NULL);
    CREATE TABLE owner_agent_runs(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,node_id TEXT NOT NULL,state TEXT NOT NULL,delivery_id TEXT NOT NULL);
    CREATE TABLE owner_agent_sessions(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL);
    CREATE TABLE owner_message_deliveries(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL);
    CREATE TABLE owner_agent_session_journal(session_id TEXT,agent_id TEXT,channel_id TEXT,run_id TEXT,tool_action_id TEXT,process_operation_id TEXT,role TEXT,text TEXT,created_at INTEGER);
    CREATE TABLE owner_agent_activity(seq INTEGER PRIMARY KEY,agent_id TEXT,node_id TEXT,kind TEXT,reference_id TEXT,summary TEXT,detail_json TEXT,created_at INTEGER);
  `);
  database.exec(agentProcessOperationsSchemaV13);
  const nodeId = randomUUID(),
    agentId = randomUUID(),
    runId = randomUUID(),
    actionScopeId = randomUUID(),
    stableActionId = `mate:${actionScopeId}:${"a".repeat(64)}:1`,
    operationId = deriveAgentProcessOperationId(agentId, stableActionId);
  database.prepare("INSERT INTO nodes VALUES(?)").run(nodeId);
  database
    .prepare("INSERT INTO owner_agents VALUES(?,?,'waiting_credentials')")
    .run(agentId, nodeId);
  database
    .prepare("INSERT INTO owner_agent_runs VALUES(?,?,?,'running',?)")
    .run(runId, agentId, nodeId, actionScopeId);
  database.prepare("INSERT INTO owner_agent_sessions VALUES(?,?)").run(randomUUID(), agentId);
  database
    .prepare("INSERT INTO owner_message_deliveries VALUES(?,?)")
    .run(actionScopeId, randomUUID());
  return { database, nodeId, agentId, runId, actionScopeId, stableActionId, operationId };
}

it("commits the control-plane intent before dispatch and reuses its terminal receipt", async () => {
  const context = setup(),
    operation = { kind: "exec" as const, command: "printf cp", cwd: "." },
    dispatch = vi.fn(async (_nodeId: string, request: { operationId: string }) => {
      expect(
        context.database
          .prepare("SELECT state FROM owner_agent_process_operations WHERE operation_id=?")
          .get(request.operationId),
      ).toEqual({ state: "executing" });
      return {
        operationId: request.operationId,
        agentId: context.agentId,
        state: "succeeded" as const,
        receipt: { code: 0, stdout: "cp" },
      };
    }),
    broker = new AgentProcessOperationBroker(context.database, {
      executeAgentProcessOperation: dispatch,
    });
  try {
    const request = { ...context, operation },
      result = await broker.execute(request),
      replay = await broker.execute(request);
    expect(result).toMatchObject({ state: "succeeded", receipt: { stdout: "cp" } });
    expect(replay).toEqual(result);
    expect(broker.status(context.agentId, context.operationId)).toEqual(result);
    expect(broker.status(randomUUID(), context.operationId)).toBeUndefined();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(
      context.database
        .prepare(
          "SELECT state,receipt_json FROM owner_agent_process_operations WHERE operation_id=?",
        )
        .get(context.operationId),
    ).toMatchObject({
      state: "succeeded",
      receipt_json: JSON.stringify({ code: 0, stdout: "cp" }),
    });
    expect(
      context.database
        .prepare(
          "SELECT action_scope_id,stable_action_id FROM owner_agent_process_operations WHERE operation_id=?",
        )
        .get(context.operationId),
    ).toEqual({ action_scope_id: context.actionScopeId, stable_action_id: context.stableActionId });
  } finally {
    context.database.close();
  }
});

it("keeps an unknown intent and reconciles it with the same node operation ID", async () => {
  const context = setup(),
    operation = { kind: "exec" as const, command: "touch once", cwd: "." },
    dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("node disconnected"))
      .mockResolvedValueOnce({
        operationId: context.operationId,
        agentId: context.agentId,
        state: "succeeded" as const,
        receipt: { code: 0, stdout: "" },
      }),
    broker = new AgentProcessOperationBroker(context.database, {
      executeAgentProcessOperation: dispatch,
    });
  try {
    expect(await broker.execute({ ...context, operation })).toMatchObject({ state: "unknown" });
    expect(await broker.execute({ ...context, operation })).toMatchObject({ state: "succeeded" });
    expect(dispatch.mock.calls.map((call) => call[1].operationId)).toEqual([
      context.operationId,
      context.operationId,
    ]);
    expect(
      context.database
        .prepare("SELECT state FROM owner_agent_process_operations WHERE operation_id=?")
        .get(context.operationId),
    ).toEqual({ state: "succeeded" });
  } finally {
    context.database.close();
  }
});

it("commits a corrected process receipt and Agent notification in one transaction", async () => {
  const context = setup();
  const broker = new AgentProcessOperationBroker(context.database, {
    executeAgentProcessOperation: async () => {
      throw new Error("node disconnected");
    },
  });
  try {
    expect(await broker.execute({ ...context, operation: { kind: "process.list" } })).toMatchObject(
      { state: "unknown" },
    );
    const result = {
      operationId: context.operationId,
      agentId: context.agentId,
      state: "succeeded" as const,
      receipt: { code: 0 },
    };
    context.database.exec("CREATE TABLE notification(operation_id TEXT PRIMARY KEY)");
    expect(() =>
      broker.reconcile(context.nodeId, result, () => {
        throw new Error("crash before notification commit");
      }),
    ).toThrow("crash before notification commit");
    expect(broker.status(context.agentId, context.operationId)?.state).toBe("unknown");
    expect(
      context.database
        .prepare(
          "SELECT COUNT(*) AS count FROM owner_agent_activity WHERE kind='receipt.corrected'",
        )
        .get(),
    ).toEqual({ count: 0 });
    broker.reconcile(context.nodeId, result, (_, operationId) => {
      context.database.prepare("INSERT INTO notification(operation_id) VALUES(?)").run(operationId);
    });
    expect(broker.status(context.agentId, context.operationId)?.state).toBe("succeeded");
    expect(context.database.prepare("SELECT operation_id FROM notification").get()).toEqual({
      operation_id: context.operationId,
    });
  } finally {
    context.database.close();
  }
});

it("rejects stale runs and operation IDs reused for changed requests", async () => {
  const context = setup(),
    dispatch = vi.fn(async () => ({
      operationId: context.operationId,
      agentId: context.agentId,
      state: "succeeded" as const,
      receipt: null,
    })),
    broker = new AgentProcessOperationBroker(context.database, {
      executeAgentProcessOperation: dispatch,
    });
  try {
    await expect(
      broker.execute({
        ...context,
        operation: { kind: "process.list" },
      }),
    ).resolves.toMatchObject({ state: "succeeded" });
    await expect(
      broker.execute({
        ...context,
        operation: { kind: "process.stop", targetOperationId: randomUUID() },
      }),
    ).rejects.toThrow("identity conflict");
    await expect(
      broker.execute({ ...context, runId: randomUUID(), operation: { kind: "process.list" } }),
    ).rejects.toThrow("no longer active");
    await expect(
      broker.execute({
        ...context,
        actionScopeId: randomUUID(),
        operation: { kind: "process.list" },
      }),
    ).rejects.toThrow("action scope");
    expect(dispatch).toHaveBeenCalledOnce();
  } finally {
    context.database.close();
  }
});

it("derives safe scope IDs only from delivery-scoped normalized tool identities", () => {
  const agentId = randomUUID(),
    stableActionId = `mate:${randomUUID()}:${"b".repeat(64)}:2`;
  expect(deriveAgentProcessOperationId(agentId, stableActionId)).toBe(
    deriveAgentProcessOperationId(agentId, stableActionId),
  );
  expect(deriveAgentProcessOperationId(agentId, stableActionId)).not.toBe(
    deriveAgentProcessOperationId(randomUUID(), stableActionId),
  );
  expect(() => deriveAgentProcessOperationId(agentId, "model chose this id")).toThrow();
});
