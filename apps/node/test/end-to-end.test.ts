import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createNodeGateway, type NodeGateway } from "@mate/gateway";
import { startNode, loadOrCreateNodeIdentity } from "@mate/node";

/**
 * End-to-end: a real gateway talks to a real in-process node over a real WebSocket.
 * Proves the two modules are wired together; the specific edge cases live in their own module tests.
 */
describe("End-to-end: gateway ↔ node over a real WebSocket", () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  it("pairs, prepares a workspace, and runs a bash command that writes a real file", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "e2e-"));
    const nodeDataDir = join(dataDir, "node-data");
    const workspacesRoot = join(dataDir, "agents");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

    const gateway = createNodeGateway({ dataDirectory: dataDir });
    cleanups.push(() => gateway.close());

    const server = createServer();
    server.on("upgrade", (req, socket, head) => {
      gateway.handleUpgrade(req, socket, head);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );
    const { port } = server.address() as AddressInfo;
    const controlPlaneUrl = `http://127.0.0.1:${port}`;

    // The node needs an identity before it can pair, and the gateway needs the same nodeId.
    const { identity } = loadOrCreateNodeIdentity(nodeDataDir);
    const { pairingToken } = gateway.createPairingToken();

    const ac = new AbortController();
    const nodePromise = startNode(
      {
        controlPlaneUrl,
        dataDirectory: nodeDataDir,
        workspacesRoot,
        pairingToken,
      },
      ac.signal,
    );
    cleanups.push(() => ac.abort());
    cleanups.push(() => nodePromise.catch(() => {}));

    // Wait for the gateway to see the node as online
    await waitFor(() => gateway.status(identity.id).online, 8000);

    const agentId = "agent-e2e";
    await gateway.prepareWorkspace(identity.id, agentId);
    expect(existsSync(join(workspacesRoot, agentId, "MEMORY.md"))).toBe(true);

    // The command runs in the workspace directory, writes a real file there, and streams what it prints.
    const chunks: string[] = [];
    const result = await gateway.runTool(
      identity.id,
      agentId,
      {
        requestId: randomUUID(),
        tool: "bash",
        arguments: { command: "echo e2e-marker > marker.txt && echo e2e-streamed" },
      },
      (chunk) => chunks.push(chunk),
      new AbortController().signal,
    );

    expect(result.isError).toBe(false);
    expect(chunks.join(""), "bash output streams to the caller").toContain("e2e-streamed");
    const markerPath = join(workspacesRoot, agentId, "marker.txt");
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf8").trim()).toBe("e2e-marker");

    // Durable's read tool does not stream: the file contents come back in the result.
    const readResult = await gateway.runTool(
      identity.id,
      agentId,
      { requestId: randomUUID(), tool: "read", arguments: { path: "marker.txt" } },
      () => {},
      new AbortController().signal,
    );
    expect(readResult.isError).toBe(false);
    expect(readResult.content.map((c) => c.text).join("")).toContain("e2e-marker");
  });

  it("returns offline once the node stops", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "e2e-offline-"));
    const nodeDataDir = join(dataDir, "node-data");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

    const gateway = createNodeGateway({ dataDirectory: dataDir });
    cleanups.push(() => gateway.close());

    const server = createServer();
    server.on("upgrade", (req, socket, head) => {
      gateway.handleUpgrade(req, socket, head);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );
    const { port } = server.address() as AddressInfo;

    const { identity } = loadOrCreateNodeIdentity(nodeDataDir);
    const { pairingToken } = gateway.createPairingToken();

    const ac = new AbortController();
    const nodePromise = startNode(
      {
        controlPlaneUrl: `http://127.0.0.1:${port}`,
        dataDirectory: nodeDataDir,
        workspacesRoot: join(dataDir, "agents"),
        pairingToken,
      },
      ac.signal,
    );
    cleanups.push(() => nodePromise.catch(() => {}));

    await waitFor(() => gateway.status(identity.id).online, 8000);

    ac.abort();
    await nodePromise.catch(() => {});

    await waitFor(() => !gateway.status(identity.id).online, 8000);

    const result = await gateway.runTool(
      identity.id,
      "agent-e2e",
      { requestId: randomUUID(), tool: "bash", arguments: { command: "echo hi" } },
      () => {},
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/offline/i);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for condition");
}
