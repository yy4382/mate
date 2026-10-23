import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname, release } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeGateway } from "@mate/gateway";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  eventually,
  nodeConfigDirectory,
  nodeEnvironment,
  temporaryDirectory,
  windows,
} from "./support.ts";

describe("node system information over its process boundary", () => {
  it("reports the host facts and dev version when pairing and authenticating from source", async () => {
    const home = temporaryDirectory();
    const gateway = createNodeGateway({ dataDirectory: join(home, "control-plane") });
    const server = createServer();
    server.on("upgrade", (request, socket, head) => gateway.handleUpgrade(request, socket, head));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(async () => {
      gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const configDirectory = nodeConfigDirectory(home);
    mkdirSync(configDirectory, { recursive: true });
    const config = {
      controlPlaneUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      workspacesRoot: join(home, "agents"),
    };
    const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const expected = {
      platform: process.platform,
      arch: process.arch,
      hostname: hostname(),
      osRelease: release(),
      version: "dev",
    };

    for (const pairingToken of [gateway.createPairingToken().pairingToken, undefined]) {
      writeFileSync(
        join(configDirectory, "node.json"),
        JSON.stringify({ ...config, pairingToken }),
      );
      const child = spawn(process.execPath, ["--conditions=mate-source", main, "node", "run"], {
        env: nodeEnvironment(home),
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += String(chunk);
      });
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      onTestFinished(async () => {
        child.kill("SIGTERM");
        await exited;
      });
      await eventually(() => gateway.nodes().some((node) => node.online), "the node connected");
      expect(gateway.nodes()).toEqual([
        expect.objectContaining({ online: true, system: expected }),
      ]);
      child.kill("SIGTERM");
      await exited;
      if (windows) expect(child.signalCode, stderr).toBe("SIGTERM");
      else expect(child.exitCode, stderr).toBe(0);
      await eventually(
        () => gateway.nodes().every((node) => !node.online),
        "the node disconnected",
      );
    }
  });
});
