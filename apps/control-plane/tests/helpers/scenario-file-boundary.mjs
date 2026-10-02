import { existsSync, writeFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LinuxWorkspaceExecutor } from "@mate/node/workspace-execution";
import { workspaceReceiptRequestHash } from "@mate/protocol/node";
import { SameAccountFileBackend } from "@mate/node/same-account-files";

/** Test launcher only: pause the first real mutation at an existing execution/receipt seam. */
export function createFileBoundaryExecutor(
  workspaceRoot,
  dataDirectory,
  boundary,
  signal,
  holdFirstExecution = false,
) {
  const marker = join(dataDirectory, "file-boundary-reached.json");
  const release = join(dataDirectory, "file-boundary-release");
  let target;
  const execution = new AsyncLocalStorage();
  async function awaitRelease(path) {
    const waiting = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    while (!existsSync(path)) await delay(25, undefined, { signal: waiting });
    waiting.throwIfAborted();
  }
  async function pause() {
    if (!target || existsSync(marker)) return;
    const fact = {
      boundary,
      ...target,
      requestHash: workspaceReceiptRequestHash(target.agentId, target.operation),
    };
    writeFileSync(marker, JSON.stringify(fact), { flag: "wx", mode: 0o600 });
    console.log(`MATE_SCENARIO_FILE_BOUNDARY ${JSON.stringify(fact)}`);
    await awaitRelease(release);
  }
  const executor = new LinuxWorkspaceExecutor(workspaceRoot, dataDirectory, {
    createBackend(identity) {
      // Each real request retains its identity even when other Agents finish first.
      const operation = execution.getStore();
      if (!operation) throw new Error("File backend has no actual workspace request");
      const backend = new SameAccountFileBackend(identity);
      return {
        async execute(request, executionSignal) {
          if (holdFirstExecution && operation.operationId === target?.operationId) {
            console.log(`MATE_SCENARIO_FILE_EXECUTION_HELD ${JSON.stringify(operation)}`);
            await awaitRelease(join(dataDirectory, "file-execution-release"));
          }
          // LinuxWorkspaceExecutor has already durably recorded executing before this call.
          if (boundary === "before_execute" && operation.operationId === target?.operationId)
            await pause();
          if (operation.mode === "agent_action")
            console.log(`MATE_SCENARIO_FILE_EXECUTION ${JSON.stringify(operation)}`);
          return backend.execute(request, executionSignal);
        },
      };
    },
    beforeReceipt: async () => {
      if (
        boundary === "before_receipt" &&
        execution.getStore()?.operationId === target?.operationId
      )
        await pause();
    },
  });
  return {
    async execute(request, executionSignal) {
      if (!target && !existsSync(marker) && request.mode === "agent_action") target = request;
      if (request.mode === "agent_action")
        console.log(`MATE_SCENARIO_FILE_REQUEST ${JSON.stringify(request)}`);
      return execution.run(request, async () => {
        const result = await executor.execute(request, executionSignal);
        // The real executor returns only after its terminal receipt has been fsynced.
        if (boundary === "after_receipt" && request.operationId === target?.operationId)
          await pause();
        return result;
      });
    },
    status: (...arguments_) => executor.status(...arguments_),
    receiptRevision: (...arguments_) => executor.receiptRevision(...arguments_),
  };
}
