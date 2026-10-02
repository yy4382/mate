import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readNodeConfiguration } from "./management/configuration.js";
import {
  defaultAgentWorkspaceRoot,
  runLinuxNode,
  type LinuxNodeOptions,
} from "./connection/node-client.js";

export function nodeOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): LinuxNodeOptions {
  if (environment.MATE_NODE_CONFIG_FILE)
    return readNodeConfiguration(environment.MATE_NODE_CONFIG_FILE);
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
  };
}

export function startLinuxNode(configurationFile?: string): void {
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  void runLinuxNode(
    nodeOptionsFromEnvironment(
      configurationFile
        ? { ...process.env, MATE_NODE_CONFIG_FILE: configurationFile }
        : process.env,
    ),
    controller.signal,
  )
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

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--config-file" || !args[1]))
    throw new Error("Usage: node main.js [--config-file <absolute-path>]");
  startLinuxNode(args[1]);
}
