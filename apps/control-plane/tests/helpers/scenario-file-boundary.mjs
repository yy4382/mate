import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LinuxWorkspaceExecutor } from "@mate/node/workspace-execution";
import { workspaceReceiptRequestHash } from "@mate/protocol/node";
import { SameAccountFileBackend } from "@mate/node/same-account-files";

/** Test launcher only: pause the first real mutation at an existing execution/receipt seam. */
export function createFileBoundaryExecutor(workspaceRoot, dataDirectory, boundary, signal) {
  const marker = join(dataDirectory, "file-boundary-reached.json");
  const release = join(dataDirectory, "file-boundary-release");
  let target;
  let invoking;
  async function pause() {
    if (!target || existsSync(marker)) return;
    const fact = {
      boundary,
      ...target,
      requestHash: workspaceReceiptRequestHash(target.agentId, target.operation),
    };
    writeFileSync(marker, JSON.stringify(fact), { flag: "wx", mode: 0o600 });
    console.log(`MATE_SCENARIO_FILE_BOUNDARY ${JSON.stringify(fact)}`);
    const waiting = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    while (!existsSync(release)) await delay(25, undefined, { signal: waiting });
    waiting.throwIfAborted();
  }
  const executor = new LinuxWorkspaceExecutor(workspaceRoot, dataDirectory, {
    createBackend(identity) {
      // The real executor creates its backend synchronously inside execute(request).
      const operation = invoking;
      if (!operation) throw new Error("File backend has no actual workspace request");
      const backend = new SameAccountFileBackend(identity);
      return {
        async execute(request, executionSignal) {
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
      if (boundary === "before_receipt") await pause();
    },
  });
  return {
    async execute(request, executionSignal) {
      if (!target && !existsSync(marker) && request.mode === "agent_action") target = request;
      if (request.mode === "agent_action")
        console.log(`MATE_SCENARIO_FILE_REQUEST ${JSON.stringify(request)}`);
      invoking = request;
      let execution;
      try {
        execution = executor.execute(request, executionSignal);
      } finally {
        invoking = undefined;
      }
      const result = await execution;
      // The real executor returns only after its terminal receipt has been fsynced.
      if (boundary === "after_receipt" && request.operationId === target?.operationId)
        await pause();
      return result;
    },
    status: (...arguments_) => executor.status(...arguments_),
    receiptRevision: (...arguments_) => executor.receiptRevision(...arguments_),
  };
}
