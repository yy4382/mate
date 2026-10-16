#!/usr/bin/env node
import { startNode } from "./index.js";

const controlPlaneUrl = process.env["MATE_CONTROL_PLANE_URL"];
const dataDirectory = process.env["MATE_NODE_DATA_DIR"];
const workspacesRoot = process.env["MATE_NODE_WORKSPACES_ROOT"] ?? `${dataDirectory}/agents`;
const pairingToken = process.env["MATE_NODE_PAIRING_TOKEN"];

if (!controlPlaneUrl) {
  process.stderr.write("MATE_CONTROL_PLANE_URL is required\n");
  process.exit(1);
}
if (!dataDirectory) {
  process.stderr.write("MATE_NODE_DATA_DIR is required\n");
  process.exit(1);
}

const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

startNode(
  {
    controlPlaneUrl,
    dataDirectory,
    workspacesRoot,
    pairingToken,
  },
  controller.signal,
).catch((error) => {
  process.stderr.write(
    `Node exiting with error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
