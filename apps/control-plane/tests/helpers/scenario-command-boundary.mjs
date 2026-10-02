// This fixed test launcher reuses the real command ledger and executor. No production fault switch.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentProcessOperations } from "@mate/node/process-operations";
import { openNodeProcessDatabase } from "@mate/node/database";
import { createLinuxAgentProcessExecutor } from "@mate/node/linux-process-executor";

export async function openCommandBoundaryStore({
  dataDirectory,
  workspaceRoot,
  commandTimeoutMs,
  boundary,
  signal,
}) {
  if (!["before_execute", "before_receipt"].includes(boundary))
    throw new Error("Unknown command test boundary");
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const databasePath = join(dataDirectory, "agent-process-operations.sqlite");
  const database = openNodeProcessDatabase(databasePath);
  chmodSync(databasePath, 0o600);
  const execute = createLinuxAgentProcessExecutor(workspaceRoot, { commandTimeoutMs });
  const marker = join(dataDirectory, "command-boundary-reached.json");
  const release = join(dataDirectory, "command-boundary-release");
  async function pause(request) {
    if (request.operation.kind === "exec" && !existsSync(marker)) {
      // The ledger commits 'started' before invoking this real executor adapter. The one-shot
      // marker is durable too, so restarting the node does not pause an unrelated new command.
      writeFileSync(marker, JSON.stringify({ boundary, ...request }), { mode: 0o600, flag: "wx" });
      process.stdout.write(
        `MATE_SCENARIO_COMMAND_BOUNDARY ${JSON.stringify({ boundary, ...request })}\n`,
      );
      const waiting = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
      while (!existsSync(release)) await delay(10, undefined, { signal: waiting });
    }
  }
  const operations = new AgentProcessOperations(database, async (request) => {
    if (boundary === "before_execute") await pause(request);
    const result = await execute(request);
    // Returning from the real executor proves its command settled. Until this adapter returns,
    // the ledger has no result to commit; the command's independent effect file is still real.
    if (boundary === "before_receipt") await pause(request);
    return result;
  });
  return { operations, close: () => database.close() };
}
