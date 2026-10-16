import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";
import { createNodeGateway, type NodeGateway } from "@mate/gateway";
import { loadOrCreateNodeIdentity, startNode } from "@mate/node";
import { eventually, running, temporaryDirectory, textOf } from "./support.ts";

const never = new AbortController().signal;

/** A real gateway and a real in-process node, paired over a real WebSocket. */
async function gatewayWithNode(): Promise<{
  gateway: NodeGateway;
  nodeId: string;
  workspacesRoot: string;
  stopNode: () => Promise<void>;
}> {
  const home = temporaryDirectory();
  const gateway = createNodeGateway({ dataDirectory: home });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => gateway.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const nodeData = join(home, "node");
  const workspacesRoot = join(home, "agents");
  const { identity } = loadOrCreateNodeIdentity(nodeData);
  const stop = new AbortController();
  const running = startNode(
    {
      controlPlaneUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      dataDirectory: nodeData,
      workspacesRoot,
      pairingToken: gateway.createPairingToken().pairingToken,
    },
    stop.signal,
  );
  const stopNode = async () => {
    stop.abort();
    await running.catch(() => {});
  };
  onTestFinished(async () => {
    await stopNode();
    gateway.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await eventually(() => gateway.status(identity.id).online, "the node is online", 8_000);
  return { gateway, nodeId: identity.id, workspacesRoot, stopNode };
}

/**
 * End to end: a real gateway talks to a real in-process node over a real WebSocket. Proves the two modules are wired
 * together; the specific edge cases live in their own module tests.
 */
describe("End-to-end: gateway ↔ node over a real WebSocket", () => {
  it("pairs, prepares a workspace, and runs a bash command that writes a real file", async () => {
    const { gateway, nodeId, workspacesRoot } = await gatewayWithNode();
    const agentId = "agent-e2e";
    await gateway.prepareWorkspace(nodeId, agentId);
    expect(existsSync(join(workspacesRoot, agentId, "MEMORY.md"))).toBe(true);

    // The command runs in the workspace directory, writes a real file there, and streams what it prints.
    const chunks: string[] = [];
    const result = await gateway.runTool(
      nodeId,
      agentId,
      {
        tool: "bash",
        arguments: { command: "echo e2e-marker > marker.txt && echo e2e-streamed" },
      },
      (chunk) => chunks.push(chunk),
      never,
    );

    expect(result.isError).toBe(false);
    expect(chunks.join(""), "bash output streams to the caller").toContain("e2e-streamed");
    const markerPath = join(workspacesRoot, agentId, "marker.txt");
    expect(readFileSync(markerPath, "utf8").trim()).toBe("e2e-marker");

    // Durable's read tool does not stream: the file contents come back in the result.
    const readResult = await gateway.runTool(
      nodeId,
      agentId,
      { tool: "read", arguments: { path: "marker.txt" } },
      () => {},
      never,
    );
    expect(readResult.isError).toBe(false);
    expect(textOf(readResult)).toContain("e2e-marker");
  });

  it("keeps two Agents' concurrent calls apart, and a caller's abort stops only its own command on the node", async () => {
    const { gateway, nodeId, workspacesRoot } = await gatewayWithNode();
    for (const agentId of ["agent-a", "agent-b"]) await gateway.prepareWorkspace(nodeId, agentId);
    // The same command in both workspaces: it records its shell and a child, then waits for a signal file.
    const command =
      'sleep 30 & echo "$$ $!" > pids.tmp; mv pids.tmp pids; while [ ! -e go ]; do sleep 0.05; done; echo "done in $(basename "$PWD")"';
    const abortA = new AbortController();
    const outputs = { "agent-a": [] as string[], "agent-b": [] as string[] };
    const callA = gateway.runTool(
      nodeId,
      "agent-a",
      { tool: "bash", arguments: { command } },
      (chunk) => outputs["agent-a"].push(chunk),
      abortA.signal,
    );
    const callB = gateway.runTool(
      nodeId,
      "agent-b",
      { tool: "bash", arguments: { command } },
      (chunk) => outputs["agent-b"].push(chunk),
      never,
    );
    const pidsOf = async (agentId: string) => {
      const path = join(workspacesRoot, agentId, "pids");
      await eventually(() => existsSync(path), `${agentId}'s command started`);
      return readFileSync(path, "utf8").trim().split(" ").map(Number);
    };
    const [pidsA, pidsB] = [await pidsOf("agent-a"), await pidsOf("agent-b")];

    abortA.abort();
    const resultA = await callA;
    expect(resultA.isError).toBe(true);
    expect(textOf(resultA), "the caller is told its call was stopped").toMatch(/stopped/i);
    for (const pid of pidsA) {
      await eventually(() => !running(pid), `agent-a's process ${pid} is gone from the node`);
    }
    expect(pidsB.every(running), "agent-b's command still runs").toBe(true);

    writeFileSync(join(workspacesRoot, "agent-b", "go"), "");
    const resultB = await callB;
    expect(textOf(resultB), "agent-b gets its own result").toContain("done in agent-b");
    expect(outputs["agent-b"].join("")).toContain("done in agent-b");
    expect(outputs["agent-a"].join(""), "nothing of agent-b's reached agent-a").toBe("");
  });

  it("returns offline once the node stops", async () => {
    const { gateway, nodeId, stopNode } = await gatewayWithNode();
    await stopNode();
    await eventually(() => !gateway.status(nodeId).online, "the node is offline", 8_000);

    const result = await gateway.runTool(
      nodeId,
      "agent-e2e",
      { tool: "bash", arguments: { command: "echo hi" } },
      () => {},
      never,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/offline/i);
  });
});
