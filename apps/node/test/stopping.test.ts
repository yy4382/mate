import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeGateway } from "@mate/testkit";
import {
  connectedNode,
  eventually,
  readPid,
  running,
  startNodeProcess,
  textOf,
} from "./support.ts";

/** A command that records its shell and a child in `<name>.pids`, then waits for the child. */
const longCommand = (name: string) =>
  `sleep 30 & echo "$$ $!" > ${name}.tmp; mv ${name}.tmp ${name}.pids; wait`;

async function pidsOf(workspace: string, name: string): Promise<number[]> {
  const path = join(workspace, `${name}.pids`);
  await eventually(() => existsSync(path), `${name} started`);
  return readFileSync(path, "utf8").trim().split(" ").map(Number);
}

describe("node connection and stopping (MODULE_TESTS 8.3)", () => {
  it("stops the process groups of running tool calls when the connection drops", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const call = node.run(agentId, "bash", { command: longCommand("call") });
    const pids = await pidsOf(workspace, "call");
    expect(pids.every(running), "the command runs").toBe(true);

    node.gateway.disconnect();
    await expect(call, "the dropped connection ends the call for the gateway").rejects.toThrow();
    for (const pid of pids) await eventually(() => !running(pid), `process ${pid} is stopped`);
  });

  it("stopAgent stops every running call of that Agent and no other Agent's", async () => {
    const node = await connectedNode();
    const first = await node.agent();
    const second = await node.agent();
    const firstCalls = [
      node.run(first.agentId, "bash", { command: longCommand("a") }),
      node.run(first.agentId, "bash", { command: longCommand("b") }),
    ];
    const otherCall = node.run(second.agentId, "bash", { command: longCommand("c") });
    const firstPids = [
      ...(await pidsOf(first.workspace, "a")),
      ...(await pidsOf(first.workspace, "b")),
    ];
    const otherPids = await pidsOf(second.workspace, "c");

    node.gateway.stopAgent(first.agentId);
    for (const result of await Promise.all(firstCalls)) {
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Command was stopped");
    }
    for (const pid of firstPids) await eventually(() => !running(pid), `process ${pid} is stopped`);
    expect(otherPids.every(running), "the other Agent's command still runs").toBe(true);

    const next = await node.run(first.agentId, "bash", { command: "echo again" });
    expect(textOf(next), "the stopped Agent's next call runs normally").toBe("again\n");

    node.gateway.stopAgent(second.agentId);
    expect(textOf(await otherCall)).toContain("Command was stopped");
  });

  it("on shutdown stops every group it started, including the background of commands that already returned", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const finished = await node.run(agentId, "bash", {
      command: "sleep 30 > /dev/null 2>&1 & echo $! > background.pid",
    });
    expect(finished.isError).toBe(false);
    const background = readPid(join(workspace, "background.pid"));
    void node.run(agentId, "bash", { command: longCommand("running") }).catch(() => {});
    const runningPids = await pidsOf(workspace, "running");
    expect(running(background), "the finished command's background still runs").toBe(true);

    node.child.kill("SIGTERM");
    expect(await node.exited, "a requested shutdown is a clean exit").toEqual({
      code: 0,
      signal: null,
    });
    for (const pid of [background, ...runningPids]) {
      await eventually(() => !running(pid), `process ${pid} is stopped`);
    }
  });

  it("runs commands the same after MEMORY.md is made unreadable or deleted", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const memory = join(workspace, "MEMORY.md");
    expect(existsSync(memory), "preparing creates MEMORY.md").toBe(true);
    chmodSync(memory, 0o000);
    expect(textOf(await node.run(agentId, "bash", { command: "echo unreadable" }))).toBe(
      "unreadable\n",
    );
    rmSync(memory);
    expect(textOf(await node.run(agentId, "bash", { command: "echo deleted" }))).toBe("deleted\n");
    expect(
      (await node.run(agentId, "write", { path: "notes.txt", content: "x" })).isError,
      "file tools too",
    ).toBe(false);
  });

  it("exits instead of retrying when the gateway rejects its identity", async () => {
    const gateway = new FakeGateway({ onConnect: () => false });
    await gateway.start();
    const node = await startNodeProcess({ gateway });
    const ended = await Promise.race([
      node.exited,
      new Promise((resolve) => setTimeout(() => resolve("still running"), 5000)),
    ]);
    await gateway.close();
    expect(ended, node.stderr()).toEqual({ code: 1, signal: null });
    expect(node.stderr()).toContain("pairing_rejected");
  });

  it("keeps reconnecting with backoff while the gateway is unreachable, then connects again", async () => {
    const first = new FakeGateway();
    await first.start();
    const node = await connectedNode({ gateway: first });
    const port = Number(new URL(first.url).port);
    await first.close();
    // Something listens on the port but drops every connection: each one is a failed attempt the node must space out.
    let attempts = 0;
    const refuser = createServer((socket) => {
      attempts++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => refuser.listen(port, "127.0.0.1", resolve));
    await new Promise((resolve) => setTimeout(resolve, 3500));
    await new Promise((resolve) => refuser.close(resolve));
    expect(node.child.exitCode, "a network failure never ends the node").toBeNull();
    // Starting at 250 ms and doubling, about three attempts fit in 3.5 s; a fixed 250 ms retry would make fourteen.
    expect(attempts, "it retried").toBeGreaterThanOrEqual(2);
    expect(attempts, "it backed off").toBeLessThanOrEqual(6);

    const second = new FakeGateway({ port });
    await second.start();
    try {
      await second.waitForNode(15_000);
      node.gateway = second;
      const { agentId } = await node.agent();
      const result = await node.run(agentId, "bash", { command: "echo back" });
      expect(textOf(result)).toBe("back\n");
    } finally {
      await second.close();
    }
  });

  it("returns a clear error and does not recreate a workspace that is missing", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    rmSync(workspace, { recursive: true });
    for (const [tool, args] of [
      ["bash", { command: "echo hi" }],
      ["write", { path: "a.txt", content: "a" }],
      ["read", { path: "a.txt" }],
    ] as const) {
      const result = await node.run(agentId, tool, args);
      expect(result.isError, tool).toBe(true);
      expect(textOf(result), tool).toMatch(/does not exist\. The node does not recreate it/);
    }
    expect(existsSync(workspace)).toBe(false);
  });
});
