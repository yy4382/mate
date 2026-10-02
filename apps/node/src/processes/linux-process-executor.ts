import { statSync } from "node:fs";
import { resolve } from "node:path";
import { OrdinaryCommandNotStartedError, OrdinaryCommandRunner } from "./ordinary-command.js";
import { readAgentWorkspaceIdentity } from "../provisioning/agent-workspace.js";
import { ordinaryCommandStopScope, type AgentProcessExecutor } from "./operation-ledger.js";

const defaultCommandTimeoutMs = 60_000;

/** The ordinary-command capabilities this executor uses; substitutable for failure-path tests. */
export type AgentCommandRunner = Pick<
  OrdinaryCommandRunner,
  "run" | "list" | "presence" | "stop" | "stopAll"
>;

export interface LinuxAgentProcessExecutorOptions {
  commandTimeoutMs?: number;
  runner?: AgentCommandRunner;
}

/**
 * Execute the Agent's ordinary operations on the host. A command is a shell child process of the
 * account the node already runs as, in the Agent's own default workspace: Mate adds no privilege,
 * no wrapper and no approval, and a `sudo` the Agent wrote reaches the host unchanged. Only what
 * this node started and can still signal is ever reported as a running process.
 */
export function createLinuxAgentProcessExecutor(
  agentHomeRoot: string,
  options: LinuxAgentProcessExecutorOptions = {},
): AgentProcessExecutor {
  const commandTimeoutMs = options.commandTimeoutMs ?? defaultCommandTimeoutMs;
  if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs < 1 || commandTimeoutMs > 300_000)
    throw new Error("Agent command timeout must be between 1 and 300000 milliseconds");
  const runner: AgentCommandRunner = options.runner ?? new OrdinaryCommandRunner();
  return async ({ agentId, operationId, operation }) => {
    switch (operation.kind) {
      case "exec": {
        let identity;
        try {
          identity = readAgentWorkspaceIdentity(agentId, agentHomeRoot);
        } catch {
          return { state: "failed", receipt: { reason: "agent_workspace_unavailable" } };
        }
        // `cwd` defaults to the Agent's own workspace. It is deliberately not confined to it:
        // ADR-0004 makes a workspace an organisational location, not a Unix boundary, and the same
        // account's commands are not gated on which directory they name.
        const cwd = resolve(identity.workspace, operation.cwd);
        if (!isDirectory(cwd))
          return { state: "failed", receipt: { reason: "command_cwd_unavailable" } };
        let receipt;
        try {
          receipt = await runner.run({
            operationId,
            agentId,
            command: operation.command,
            cwd,
            home: identity.workspace,
            username: identity.username,
            timeoutMs: commandTimeoutMs,
          });
        } catch (error) {
          if (error instanceof OrdinaryCommandNotStartedError)
            return { state: "failed", receipt: { reason: "command_not_started" } };
          throw error;
        }
        // A command Mate had to end, or one that died from a signal, never counts as success even
        // if its own exit status happened to be zero.
        const succeeded = receipt.code === 0 && !receipt.timedOut && receipt.signal === null;
        return { state: succeeded ? "succeeded" : "failed", receipt };
      }
      case "process.list":
        return {
          state: "succeeded",
          receipt: {
            processes: runner.list(agentId).map(({ operationId: id, pid, startedAt, exited }) => ({
              operationId: id,
              pid,
              startedAt,
              state: exited ? "descendants_running" : "running",
            })),
          },
        };
      case "process.inspect": {
        const presence = runner.presence(agentId, operation.targetOperationId);
        return {
          state: "succeeded",
          receipt: {
            operationId: operation.targetOperationId,
            state: presence.state,
            ...(presence.pid === undefined ? {} : { pid: presence.pid }),
          },
        };
      }
      case "process.stop": {
        const result = await runner.stop(agentId, operation.targetOperationId);
        return result.state === "unconfirmed"
          ? {
              state: "failed",
              receipt: {
                reason: "process_stop_unconfirmed",
                operationId: operation.targetOperationId,
                state: "unconfirmed",
                pid: result.pid,
              },
            }
          : {
              state: "succeeded",
              receipt: {
                operationId: operation.targetOperationId,
                state: result.state,
              },
            };
      }
      case "process.stop_all": {
        // The tracker only knows commands this node process started, so the receipt says exactly
        // that: "everything I was tracking is stopped" is not "nothing from an earlier node run
        // can still be running". The control plane reads the same scope and tells the owner which
        // of its durable command records the node could not confirm.
        const { stopped, unconfirmed } = await runner.stopAll(agentId);
        return unconfirmed.length === 0
          ? {
              state: "succeeded",
              receipt: { stopped: true, operationIds: stopped, scope: ordinaryCommandStopScope },
            }
          : {
              state: "failed",
              receipt: {
                reason: "process_stop_unconfirmed",
                stopped: false,
                operationIds: stopped,
                unconfirmedOperationIds: unconfirmed,
                scope: ordinaryCommandStopScope,
              },
            };
      }
    }
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
