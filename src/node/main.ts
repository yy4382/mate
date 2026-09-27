import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defaultAgentWorkspaceRoot, runLinuxNode, type LinuxNodeOptions } from "../nodes/client.js";

export function nodeOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): LinuxNodeOptions {
  const controlPlaneUrl = environment.MATE_CONTROL_PLANE_URL;
  if (!controlPlaneUrl) throw new Error("MATE_CONTROL_PLANE_URL is required");
  const dataDirectory = environment.MATE_NODE_DATA_DIR ?? resolve(process.cwd(), "data", "node");
  const agentWorkspaceRoot =
    environment.MATE_NODE_AGENT_WORKSPACE_ROOT ?? defaultAgentWorkspaceRoot(dataDirectory);
  if (!agentWorkspaceRoot.startsWith("/"))
    throw new Error("MATE_NODE_AGENT_WORKSPACE_ROOT must be an absolute path");
  return {
    controlPlaneUrl,
    dataDirectory,
    agentWorkspaceRoot,
    ...(environment.MATE_NODE_PAIRING_TOKEN
      ? { pairingToken: environment.MATE_NODE_PAIRING_TOKEN }
      : {}),
    ...(environment.MATE_NODE_MODEL_WORKER_ENTRY
      ? { modelWorkerEntry: environment.MATE_NODE_MODEL_WORKER_ENTRY }
      : {}),
  };
}

export function startLinuxNode(): void {
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  void runLinuxNode(nodeOptionsFromEnvironment(), controller.signal)
    .catch((error: unknown) => {
      process.stderr.write(
        `Linux node stopped: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
      process.exitCode = 1;
    })
    .finally(() => {
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
    });
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url))
  startLinuxNode();
