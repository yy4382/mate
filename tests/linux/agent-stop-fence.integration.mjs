import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { AgentProcessOperations } from "../../dist/src/nodes/process-operations.js";

if (process.platform !== "linux" || !existsSync("/.dockerenv"))
  throw new Error("Run this focused node receipt test in a disposable Linux container.");

let finishExec;
const execPending = new Promise((resolve) => {
  finishExec = resolve;
});
const calls = [];
const agentId = randomUUID();
const database = new Database(":memory:");
const operations = new AgentProcessOperations(database, async ({ operation }) => {
  calls.push(operation.kind);
  if (operation.kind === "exec") return execPending;
  return { state: "succeeded", receipt: { stopped: true, units: [] } };
});

try {
  const ordinary = operations.execute(agentId, randomUUID(), {
    kind: "exec",
    cwd: ".",
    command: "true",
  });
  await Promise.resolve();
  assert.deepEqual(calls, ["exec"]);

  const stop = operations.execute(agentId, randomUUID(), { kind: "process.stop_all" });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ["exec", "process.stop_all"]);
  const fenced = await operations.execute(agentId, randomUUID(), {
    kind: "exec",
    cwd: ".",
    command: "true",
  });
  assert.equal(fenced.state, "failed");
  assert.deepEqual(fenced.receipt, { reason: "agent_stopping" });

  finishExec({ state: "succeeded", receipt: { code: 0 } });
  assert.equal((await ordinary).state, "succeeded");
  assert.equal((await stop).state, "succeeded");
  assert.deepEqual(calls, ["exec", "process.stop_all", "process.stop_all"]);
  process.stdout.write(
    `${JSON.stringify({ mode: "linux-node-receipt-fixture", stopFence: true, finalStopPass: true })}\n`,
  );
} finally {
  database.close();
}
