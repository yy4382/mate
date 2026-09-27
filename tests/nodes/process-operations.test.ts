import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AgentProcessOperations } from "../../src/nodes/process-operations.js";
import { createLinuxAgentProcessExecutor } from "../../src/nodes/linux-process-executor.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("refuses an Agent command timeout outside its supported range", () => {
  expect(() =>
    createLinuxAgentProcessExecutor("/var/lib/mate/agents", { commandTimeoutMs: 0 }),
  ).toThrow("Agent command timeout");
  expect(() =>
    createLinuxAgentProcessExecutor("/var/lib/mate/agents", { commandTimeoutMs: 300_001 }),
  ).toThrow("Agent command timeout");
});

it("stops every Agent's running commands when the node is shutting down", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-process-operations-")),
    database = new Database(join(directory, "operations.sqlite")),
    firstAgent = randomUUID(),
    secondAgent = randomUUID(),
    first = deferred<{ state: "succeeded"; receipt: unknown }>(),
    second = deferred<{ state: "succeeded"; receipt: unknown }>(),
    stoppedFor: string[] = [];
  const execute = vi.fn(async ({ agentId, operation }: { agentId: string; operation: unknown }) => {
    const kind = (operation as { kind: string }).kind;
    if (kind === "process.stop_all") {
      stoppedFor.push(agentId);
      return {
        state: "succeeded" as const,
        receipt: { stopped: true, operationIds: [], scope: "this_node_run" },
      };
    }
    return agentId === firstAgent ? first.promise : second.promise;
  });
  const operations = new AgentProcessOperations(database, execute);
  try {
    // Two Agents each have one command in flight when the node is asked to stop.
    void operations.execute(firstAgent, randomUUID(), {
      kind: "exec",
      command: "sleep 5",
      cwd: ".",
    });
    void operations.execute(secondAgent, randomUUID(), {
      kind: "exec",
      command: "sleep 5",
      cwd: ".",
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    const shutdown = operations.stopAllAgents();
    // The first stop pass cannot finish while a command it must wait for is still in flight.
    await vi.waitFor(() => expect(stoppedFor.length).toBeGreaterThanOrEqual(1));
    first.resolve({ state: "succeeded", receipt: { code: 0 } });
    second.resolve({ state: "succeeded", receipt: { code: 0 } });
    await expect(shutdown).resolves.toEqual({ stopped: [], unconfirmed: [] });
    // Both Agents' commands were stopped, not just the first one's.
    expect(new Set(stoppedFor)).toEqual(new Set([firstAgent, secondAgent]));
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("records start before host work and replays a durable terminal receipt without rerunning", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-process-operations-")),
    path = join(directory, "operations.sqlite"),
    agentId = randomUUID(),
    operationId = randomUUID(),
    started = deferred<void>(),
    finish = deferred<{ state: "succeeded"; receipt: unknown }>(),
    database = new Database(path);
  let operations!: AgentProcessOperations;
  const execute = vi.fn(async () => {
    expect(operations.status(agentId, operationId)).toMatchObject({ state: "started" });
    started.resolve();
    return finish.promise;
  });
  operations = new AgentProcessOperations(database, execute);

  try {
    const request = {
        kind: "exec" as const,
        cwd: ".",
        command: "printf durable",
      },
      first = operations.execute(agentId, operationId, request);
    await started.promise;
    const duplicate = operations.execute(agentId, operationId, request);
    expect(execute).toHaveBeenCalledOnce();
    finish.resolve({ state: "succeeded", receipt: { code: 0, stdout: "durable" } });

    const [firstReceipt, duplicateReceipt] = await Promise.all([first, duplicate]);
    expect(firstReceipt).toEqual({
      operationId,
      agentId,
      state: "succeeded",
      receipt: { code: 0, stdout: "durable" },
      revision: 2,
    });
    expect(duplicateReceipt).toEqual(firstReceipt);

    database.close();
    const recoveredDatabase = new Database(path),
      recoveryExecutor = vi.fn(async () => ({ state: "failed" as const, receipt: null })),
      recovered = new AgentProcessOperations(recoveredDatabase, recoveryExecutor);
    try {
      expect(await recovered.execute(agentId, operationId, request)).toEqual(firstReceipt);
      expect(recoveryExecutor).not.toHaveBeenCalled();
    } finally {
      recoveredDatabase.close();
    }
  } finally {
    if (database.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("rejects reuse of one operation ID for a different Agent request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-process-operations-")),
    database = new Database(join(directory, "operations.sqlite")),
    execute = vi.fn(async () => ({ state: "succeeded" as const, receipt: { code: 0 } })),
    operations = new AgentProcessOperations(database, execute),
    operationId = randomUUID();
  try {
    await operations.execute(randomUUID(), operationId, {
      kind: "exec",
      cwd: ".",
      command: "true",
    });
    await expect(
      operations.execute(randomUUID(), operationId, {
        kind: "exec",
        cwd: ".",
        command: "false",
      }),
    ).rejects.toThrow("identity conflict");
    expect(execute).toHaveBeenCalledOnce();
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("marks an interrupted node operation unknown and never replays it after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-process-operations-")),
    path = join(directory, "operations.sqlite"),
    agentId = randomUUID(),
    operationId = randomUUID(),
    request = { kind: "exec" as const, cwd: ".", command: "touch once" },
    canonical = JSON.stringify({
      agentId,
      operation: { kind: "exec", command: "touch once", cwd: "." },
    }),
    database = new Database(path),
    noWork = vi.fn(async () => ({ state: "succeeded" as const, receipt: { code: 0 } })),
    original = new AgentProcessOperations(database, noWork);
  try {
    database
      .prepare(
        `INSERT INTO agent_process_operations(
          operation_id,agent_id,request_hash,request,state,created_at,updated_at
        ) VALUES(?,?,?,?, 'started',1,1)`,
      )
      .run(operationId, agentId, createHash("sha256").update(canonical).digest("hex"), canonical);
    expect(original.status(agentId, operationId)?.state).toBe("started");
    database.close();

    const recoveredDatabase = new Database(path),
      recoveryExecutor = vi.fn(async () => ({ state: "succeeded" as const, receipt: null })),
      recovered = new AgentProcessOperations(recoveredDatabase, recoveryExecutor);
    try {
      expect(recovered.status(agentId, operationId)).toMatchObject({
        state: "unknown",
        receipt: { reason: "node_restarted_during_operation" },
      });
      expect(await recovered.execute(agentId, operationId, request)).toMatchObject({
        state: "unknown",
      });
      expect(recoveryExecutor).not.toHaveBeenCalled();
    } finally {
      recoveredDatabase.close();
    }
  } finally {
    if (database.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("fences new commands and repeats Agent stopping after an admitted command settles", async () => {
  const database = new Database(":memory:");
  const agentId = randomUUID(),
    otherAgent = randomUUID();
  const commandStarted = deferred<void>();
  const finishCommand = deferred<{ state: "succeeded"; receipt: unknown }>();
  let stops = 0;
  const host = vi.fn(async ({ operation }: { operation: { kind: string } }) => {
    if (operation.kind === "exec") {
      commandStarted.resolve();
      return finishCommand.promise;
    }
    stops++;
    return { state: "succeeded" as const, receipt: { stopped: true, operationIds: [] } };
  });
  const operations = new AgentProcessOperations(database, host);
  try {
    const command = operations.execute(agentId, randomUUID(), {
      kind: "exec",
      cwd: ".",
      command: "late-command",
    });
    await commandStarted.promise;
    const stopping = operations.execute(agentId, randomUUID(), { kind: "process.stop_all" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stops).toBe(1);
    const late = await operations.execute(agentId, randomUUID(), {
      kind: "exec",
      cwd: ".",
      command: "must-not-start",
    });
    expect(late).toMatchObject({ state: "failed", receipt: { reason: "agent_stopping" } });
    expect(host).toHaveBeenCalledTimes(2);
    expect(
      await operations.execute(otherAgent, randomUUID(), { kind: "process.stop_all" }),
    ).toMatchObject({ state: "succeeded" });
    finishCommand.resolve({ state: "succeeded", receipt: { code: 0 } });
    await command;
    expect(await stopping).toMatchObject({ state: "succeeded" });
    expect(stops).toBe(3);
    operations.allowAgent(agentId);
    expect(
      await operations.execute(agentId, randomUUID(), {
        kind: "exec",
        cwd: ".",
        command: "after-verified-resume",
      }),
    ).toMatchObject({ state: "succeeded" });
  } finally {
    database.close();
  }
});
