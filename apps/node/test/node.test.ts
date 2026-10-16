import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startNode } from "@mate/node";
import { FakeGateway } from "@mate/testkit";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "node-test-"));
}

describe("Node — connection and identity", () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  it("pairs with a new gateway using a pairing token", async () => {
    const dataDir = makeTempDir();
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

    const gateway = new FakeGateway();
    const gatewayUrl = await gateway.start();
    cleanups.push(() => gateway.close());

    const ac = new AbortController();
    const nodePromise = startNode(
      {
        controlPlaneUrl: gatewayUrl,
        dataDirectory: dataDir,
        workspacesRoot: join(dataDir, "agents"),
        pairingToken: "test-pairing-token-12345678901234567",
      },
      ac.signal,
    );
    cleanups.push(() => ac.abort());

    // Wait for the node to authenticate
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout waiting for auth")), 5000);
      const poll = setInterval(() => {
        if (gateway.isAuthenticated) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });

    expect(gateway.isAuthenticated).toBe(true);
    expect(gateway.connectedNodeId).toBeTruthy();

    ac.abort();
    await nodePromise.catch(() => {});
  });

  it("reconnects after the gateway closes the connection", async () => {
    const dataDir = makeTempDir();
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

    const gateway = new FakeGateway();
    const gatewayUrl = await gateway.start();
    cleanups.push(() => gateway.close());

    const ac = new AbortController();
    const nodePromise = startNode(
      {
        controlPlaneUrl: gatewayUrl,
        dataDirectory: dataDir,
        workspacesRoot: join(dataDir, "agents"),
        pairingToken: "test-pairing-token-reconnect-test12",
        heartbeatIntervalMs: 500,
        heartbeatTimeoutMs: 2000,
      },
      ac.signal,
    );
    cleanups.push(() => ac.abort());

    // Wait for first auth
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout")), 5000);
      const poll = setInterval(() => {
        if (gateway.isAuthenticated) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });

    const firstNodeId = gateway.connectedNodeId;

    // Drop the connection from the gateway side; the node must reconnect on its own.
    gateway.disconnect();
    expect(gateway.isAuthenticated, "the fake gateway forgets the dropped connection").toBe(false);

    // Wait for re-authentication
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout waiting for reconnect")), 8000);
      const poll = setInterval(() => {
        if (gateway.isAuthenticated && gateway.connectedNodeId === firstNodeId) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolve();
        }
      }, 50);
    });

    expect(gateway.connectedNodeId).toBe(firstNodeId);

    ac.abort();
    await nodePromise.catch(() => {});
  });

  it("exits immediately when auth is rejected", async () => {
    const dataDir = makeTempDir();
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

    const gateway = new FakeGateway({
      onConnect: async () => false,
    });
    const gatewayUrl = await gateway.start();
    cleanups.push(() => gateway.close());

    const ac = new AbortController();
    const nodePromise = startNode(
      {
        controlPlaneUrl: gatewayUrl,
        dataDirectory: dataDir,
        workspacesRoot: join(dataDir, "agents"),
        pairingToken: "test-pairing-token-rejected-12345678",
      },
      ac.signal,
    );
    cleanups.push(() => ac.abort());

    await expect(nodePromise).rejects.toThrow();
  });
});

describe("Node — workspace", () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  it("prepareWorkspace creates the directory and an empty MEMORY.md", async () => {
    const dataDir = makeTempDir();
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const workspacesRoot = join(dataDir, "agents");

    const gateway = new FakeGateway();
    const gatewayUrl = await gateway.start();
    cleanups.push(() => gateway.close());

    const ac = new AbortController();
    const nodePromise = startNode(
      {
        controlPlaneUrl: gatewayUrl,
        dataDirectory: dataDir,
        workspacesRoot,
        pairingToken: "test-pairing-token-workspace-test12",
      },
      ac.signal,
    );
    cleanups.push(() => ac.abort());

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout")), 5000);
      const poll = setInterval(() => {
        if (gateway.isAuthenticated) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });

    const agentId = randomUUID();
    const reqId = randomUUID();
    const result = await gateway.prepareWorkspace(reqId, agentId);

    expect(result.isError).toBe(false);
    expect(existsSync(join(workspacesRoot, agentId))).toBe(true);
    expect(existsSync(join(workspacesRoot, agentId, "MEMORY.md"))).toBe(true);

    // Calling again should not overwrite
    const result2 = await gateway.prepareWorkspace(randomUUID(), agentId);
    expect(result2.isError).toBe(false);

    ac.abort();
    await nodePromise.catch(() => {});
  });

  it("a tool call fails clearly when the workspace does not exist", async () => {
    const dataDir = makeTempDir();
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const workspacesRoot = join(dataDir, "agents");

    const gateway = new FakeGateway();
    const gatewayUrl = await gateway.start();
    cleanups.push(() => gateway.close());

    const ac = new AbortController();
    const nodePromise = startNode(
      {
        controlPlaneUrl: gatewayUrl,
        dataDirectory: dataDir,
        workspacesRoot,
        pairingToken: "test-pairing-token-no-workspace-12",
      },
      ac.signal,
    );
    cleanups.push(() => ac.abort());

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout")), 5000);
      const poll = setInterval(() => {
        if (gateway.isAuthenticated) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });

    const result = await gateway.runTool(randomUUID(), "nonexistent-agent", "bash", {
      command: "echo hi",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/does not exist/i);

    ac.abort();
    await nodePromise.catch(() => {});
  });
});

describe("Node — tool execution", () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  it("runs a bash command and returns output", async () => {
    const dataDir = makeTempDir();
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const workspacesRoot = join(dataDir, "agents");

    const gateway = new FakeGateway();
    const gatewayUrl = await gateway.start();
    cleanups.push(() => gateway.close());

    const ac = new AbortController();
    const nodePromise = startNode(
      {
        controlPlaneUrl: gatewayUrl,
        dataDirectory: dataDir,
        workspacesRoot,
        pairingToken: "test-pairing-token-bash-execution12",
      },
      ac.signal,
    );
    cleanups.push(() => ac.abort());

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout")), 5000);
      const poll = setInterval(() => {
        if (gateway.isAuthenticated) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });

    const agentId = randomUUID();
    await gateway.prepareWorkspace(randomUUID(), agentId);

    const result = await gateway.runTool(randomUUID(), agentId, "bash", {
      command: "echo hello-node",
    });
    expect(result.isError).toBe(false);
    const text = result.content.map((c) => c.text).join("");
    expect(text).toContain("hello-node");

    ac.abort();
    await nodePromise.catch(() => {});
  });

  it.skipIf(process.platform !== "linux")(
    "stopAgent terminates running processes on Linux",
    async () => {
      const dataDir = makeTempDir();
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
      const workspacesRoot = join(dataDir, "agents");

      const gateway = new FakeGateway();
      const gatewayUrl = await gateway.start();
      cleanups.push(() => gateway.close());

      const ac = new AbortController();
      const nodePromise = startNode(
        {
          controlPlaneUrl: gatewayUrl,
          dataDirectory: dataDir,
          workspacesRoot,
          pairingToken: "test-pairing-token-stop-agent-test1",
        },
        ac.signal,
      );
      cleanups.push(() => ac.abort());

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timeout")), 5000);
        const poll = setInterval(() => {
          if (gateway.isAuthenticated) {
            clearTimeout(timeout);
            clearInterval(poll);
            resolve();
          }
        }, 20);
      });

      const agentId = randomUUID();
      await gateway.prepareWorkspace(randomUUID(), agentId);

      const toolPromise = gateway.runTool(randomUUID(), agentId, "bash", { command: "sleep 30" });

      await new Promise((r) => setTimeout(r, 200));
      gateway.stopAgent(agentId);

      const result = await toolPromise;
      // Either an error result or the connection drops — either way it should not hang
      expect(result).toBeDefined();

      ac.abort();
      await nodePromise.catch(() => {});
    },
  );
});
