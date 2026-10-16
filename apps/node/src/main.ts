#!/usr/bin/env node
import { startNode } from "./index.ts";

const controlPlaneUrl = process.env["MATE_CONTROL_PLANE_URL"];
const dataDirectory = process.env["MATE_NODE_DATA_DIR"];
if (!controlPlaneUrl || !dataDirectory) {
  process.stderr.write("MATE_CONTROL_PLANE_URL and MATE_NODE_DATA_DIR are required\n");
  process.exit(2);
}

const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());

try {
  await startNode(
    {
      controlPlaneUrl,
      dataDirectory,
      workspacesRoot: process.env["MATE_NODE_WORKSPACES_ROOT"] ?? `${dataDirectory}/agents`,
      pairingToken: process.env["MATE_NODE_PAIRING_TOKEN"],
    },
    controller.signal,
  );
  process.exit(0);
} catch (error) {
  process.stderr.write(`Node exiting: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
