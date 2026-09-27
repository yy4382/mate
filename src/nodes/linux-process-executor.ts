import { LinuxProcessManager, ProcessStopRejectedError } from "../execution/linux-processes.js";
import { LinuxUserBackend } from "../execution/linux-user.js";
import { readAgentWorkspaceIdentity, type AgentWorkspaceIdentity } from "./agent-provisioner.js";
import type { AgentProcessExecutor } from "./process-operations.js";

const defaultCommandTimeoutMs = 60_000;

export interface LinuxAgentProcessExecutorOptions {
  commandTimeoutMs?: number;
}

/** Execute one ordinary operation only after rechecking the Agent's provisioned Linux identity. */
export function createLinuxAgentProcessExecutor(
  agentHomeRoot: string,
  options: LinuxAgentProcessExecutorOptions = {},
): AgentProcessExecutor {
  const commandTimeoutMs = options.commandTimeoutMs ?? defaultCommandTimeoutMs;
  if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs < 1 || commandTimeoutMs > 300_000)
    throw new Error("Agent command timeout must be between 1 and 300000 milliseconds");
  return async ({ agentId, operationId, operation }) => {
    const identity = readAgentWorkspaceIdentity(agentId, agentHomeRoot);
    switch (operation.kind) {
      case "exec": {
        const processes = processManager(agentId, identity);
        await processes.verifyQuota(agentId);
        const backend = new LinuxUserBackend({
          [agentId]: {
            username: identity.username,
            uid: identity.uid,
            gid: identity.gid,
            home: identity.workspace,
          },
        });
        // The operation has crossed the node's durable start record. WebSocket loss must not cancel
        // this command; its UID-scoped systemd unit continues and can be reconciled.
        const result = await backend.execute({
          agentId,
          root: identity.workspace,
          timeoutMs: commandTimeoutMs,
          operation,
          operationId,
        });
        return {
          state: result.code === 0 ? "succeeded" : "failed",
          receipt: result,
        };
      }
      case "process.list": {
        const processes = await processManager(agentId, identity).list(agentId);
        return {
          state: "succeeded",
          receipt: {
            processes: processes.map((process) => ({
              operationId: processOperationId(identity.uid, process.unit),
              unit: process.unit,
              pids: process.pids,
            })),
          },
        };
      }
      case "process.inspect": {
        const processes = await processManager(agentId, identity).list(agentId),
          unit = agentProcessUnit(identity.uid, operation.targetOperationId),
          process = processes.find((entry) => entry.unit === unit);
        return {
          state: "succeeded",
          receipt: {
            operationId: operation.targetOperationId,
            state: process ? "running" : "not_running",
            ...(process ? { pids: process.pids } : {}),
          },
        };
      }
      case "process.stop": {
        try {
          const unit = agentProcessUnit(identity.uid, operation.targetOperationId),
            result = await processManager(agentId, identity).stop(agentId, unit);
          return { state: "succeeded", receipt: result };
        } catch (error) {
          if (error instanceof ProcessStopRejectedError)
            return { state: "failed", receipt: { reason: "process_stop_rejected" } };
          throw error;
        }
      }
      case "process.stop_all": {
        const receipt = await processManager(agentId, identity).stopAll(agentId);
        return { state: "succeeded", receipt };
      }
    }
  };
}

export function agentProcessUnit(uid: number, operationId: string): string {
  if (
    !Number.isSafeInteger(uid) ||
    uid < 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)
  )
    throw new Error("Invalid Agent process identity");
  return `mate-agent-${uid}-${operationId.toLowerCase()}.scope`;
}

function processOperationId(uid: number, unit: string): string | null {
  const prefix = `mate-agent-${uid}-`,
    suffix = ".scope";
  if (!unit.startsWith(prefix) || !unit.endsWith(suffix)) return null;
  const operationId = unit.slice(prefix.length, -suffix.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId)
    ? operationId
    : null;
}

function processManager(agentId: string, identity: AgentWorkspaceIdentity): LinuxProcessManager {
  return new LinuxProcessManager({ [agentId]: identity.uid });
}
