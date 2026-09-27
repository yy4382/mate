import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { nodeOptionsFromEnvironment } from "../../src/node/main.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function releaseEntry(relativeEntry: string): { root: string; entry: string } {
  const root = mkdtempSync(join(tmpdir(), "mate-release-entrypoint-")),
    release = join(root, "releases", "test-release"),
    current = join(root, "current");
  roots.push(root);
  mkdirSync(release, { recursive: true });
  symlinkSync(resolve("dist"), join(release, "dist"), "dir");
  symlinkSync(release, current, "dir");
  return { root, entry: join(current, "dist", relativeEntry) };
}

function waitForControlPlane(child: ChildProcess): Promise<number> {
  const stdout = child.stdout,
    stderr = child.stderr;
  if (!stdout || !stderr) throw new Error("Control-plane process pipes were not created");

  let output = "",
    diagnostics = "";
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => {
    diagnostics += chunk;
  });

  return new Promise((resolvePort, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error(`Control plane did not start through the release symlink: ${diagnostics}`),
        ),
      5000,
    );
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      output += chunk;
      const match = output.match(/MATE_CONTROL_PLANE_LISTENING (\d+)\n/);
      if (!match) return;
      clearTimeout(timeout);
      resolvePort(Number(match[1]));
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Control plane exited before listening (code ${code}, signal ${signal}): ${diagnostics}`,
        ),
      );
    });
  });
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolveExit) => setTimeout(resolveExit, 1000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

it("serves status when the control plane starts through the current release symlink", async () => {
  const { root, entry } = releaseEntry("src/control-plane/main.js"),
    dataDir = join(root, "control-plane-data"),
    passwordFile = join(root, "owner-password");
  writeFileSync(passwordFile, "synthetic-owner-password-with-more-than-12-bytes\n", {
    mode: 0o600,
  });
  chmodSync(passwordFile, 0o600);

  const child = spawn(process.execPath, [entry], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      MATE_CONTROL_PLANE_PORT: "0",
      MATE_CONTROL_PLANE_DATA_DIR: dataDir,
      MATE_OWNER_PASSWORD_FILE: passwordFile,
      // An ordinary start must not depend on a service manager, even when one advertises a socket.
      NOTIFY_SOCKET: join(root, "missing-systemd-notify.sock"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const port = await waitForControlPlane(child),
      response = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "running" });
  } finally {
    await stopProcess(child);
  }
});

it("validates node startup configuration when launched through the current release symlink", () => {
  const { root, entry } = releaseEntry("src/node/main.js"),
    result = spawnSync(process.execPath, [entry], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "C.UTF-8",
        MATE_CONTROL_PLANE_URL: "",
        MATE_NODE_DATA_DIR: join(root, "node-data"),
        MATE_NODE_AGENT_WORKSPACE_ROOT: join(root, "agent-homes"),
      },
      encoding: "utf8",
    });

  expect(result.status).toBe(1);
  expect(`${result.stdout}\n${result.stderr}`).toContain("MATE_CONTROL_PLANE_URL is required");
});

it("keeps the node's Agent homes inside the launching account's own data directory", () => {
  const root = mkdtempSync(join(tmpdir(), "mate-node-options-"));
  roots.push(root);
  const dataDirectory = join(root, "node");

  expect(
    nodeOptionsFromEnvironment({
      MATE_CONTROL_PLANE_URL: "http://127.0.0.1:8787",
      MATE_NODE_DATA_DIR: dataDirectory,
    }).agentWorkspaceRoot,
  ).toBe(join(dataDirectory, "agents"));
  expect(
    nodeOptionsFromEnvironment({
      MATE_CONTROL_PLANE_URL: "http://127.0.0.1:8787",
      MATE_NODE_DATA_DIR: dataDirectory,
      MATE_NODE_AGENT_WORKSPACE_ROOT: join(root, "agent-homes"),
    }).agentWorkspaceRoot,
  ).toBe(join(root, "agent-homes"));
  expect(() =>
    nodeOptionsFromEnvironment({
      MATE_CONTROL_PLANE_URL: "http://127.0.0.1:8787",
      MATE_NODE_AGENT_WORKSPACE_ROOT: "relative/agent-homes",
    }),
  ).toThrow("must be an absolute path");
});
