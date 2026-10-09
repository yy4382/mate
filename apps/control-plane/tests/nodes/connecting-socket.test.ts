import { spawn } from "node:child_process";

import { chmodSync, mkdtempSync, rmSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { startUnresponsiveWebSocketEndpoint } from "../support/node/connection-fixture.js";
import { ProcessOutput, stopProcess, waitForExit } from "../support/node/process-output.js";

it("keeps retrying when the WebSocket handshake never completes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-node-handshake-timeout-"));
  chmodSync(directory, 0o700);
  const endpoint = await startUnresponsiveWebSocketEndpoint();
  const moduleUrl = import.meta.resolve("@mate/node");
  const runner = `
    const { runLinuxNode } = await import(${JSON.stringify(moduleUrl)});
    await runLinuxNode({
      controlPlaneUrl: process.env.MATE_CONTROL_PLANE_URL,
      dataDirectory: process.env.MATE_NODE_DATA_DIR,
      pairingToken: process.env.MATE_NODE_PAIRING_TOKEN
    }, new AbortController().signal);`;
  const node = new ProcessOutput(
    spawn(process.execPath, ["--input-type=module", "--eval", runner], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MATE_CONTROL_PLANE_URL: `http://127.0.0.1:${endpoint.port}`,
        MATE_NODE_DATA_DIR: join(directory, "node-data"),
        MATE_NODE_PAIRING_TOKEN: "test-pairing-token-that-is-long-enough-74",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  try {
    await endpoint.waitForAttempts(1);
    expect(node.exitStatus).toBeUndefined();
    await node.waitFor(/Node WebSocket connection failed; retrying\./, 12_000);
    expect(node.exitStatus).toBeUndefined();
    await endpoint.waitForAttempts(2, 5000);
    expect(node.exitStatus).toBeUndefined();
  } finally {
    await stopProcess(node);
    await endpoint.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);

it("aborts a connecting WebSocket without an unhandled error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-node-handshake-abort-"));
  chmodSync(directory, 0o700);
  const endpoint = await startUnresponsiveWebSocketEndpoint();
  const moduleUrl = import.meta.resolve("@mate/node");
  const runner = `
    const { runLinuxNode } = await import(${JSON.stringify(moduleUrl)});
    const controller = new AbortController();
    process.on("message", (message) => {
      if (message === "abort") {
        controller.abort();
        process.disconnect();
      }
    });
    await runLinuxNode({
      controlPlaneUrl: process.env.MATE_CONTROL_PLANE_URL,
      dataDirectory: process.env.MATE_NODE_DATA_DIR,
      pairingToken: process.env.MATE_NODE_PAIRING_TOKEN
    }, controller.signal);`;
  const node = new ProcessOutput(
    spawn(process.execPath, ["--input-type=module", "--eval", runner], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MATE_CONTROL_PLANE_URL: `http://127.0.0.1:${endpoint.port}`,
        MATE_NODE_DATA_DIR: join(directory, "node-data"),
        MATE_NODE_PAIRING_TOKEN: "test-pairing-token-that-is-long-enough-74",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }),
  );
  try {
    await endpoint.waitForAttempts(1);
    node.child.send("abort");
    await waitForExit(node);
    expect(node.exitStatus?.code).toBe(0);
    expect(node.text).not.toContain("WebSocket was closed before the connection was established");
  } finally {
    await stopProcess(node);
    await endpoint.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 10000);
