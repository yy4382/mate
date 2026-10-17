import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
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

  it("a stop ends that one call's process group and leaves every other call running, of the same Agent or another", async () => {
    const node = await connectedNode();
    const first = await node.agent();
    const second = await node.agent();
    const stopped = node.gateway.runTool("call-a", first.agentId, "bash", {
      command: longCommand("a"),
    });
    const sameAgent = node.run(first.agentId, "bash", { command: longCommand("b") });
    const otherAgent = node.run(second.agentId, "bash", { command: longCommand("c") });
    const stoppedPids = await pidsOf(first.workspace, "a");
    const otherPids = [
      ...(await pidsOf(first.workspace, "b")),
      ...(await pidsOf(second.workspace, "c")),
    ];

    node.gateway.stopTool("call-a");
    const result = await stopped;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Command was stopped");
    for (const pid of stoppedPids) {
      await eventually(() => !running(pid), `process ${pid} is stopped`);
    }
    expect(otherPids.every(running), "the other calls' commands still run").toBe(true);

    const next = await node.run(first.agentId, "bash", { command: "echo again" });
    expect(textOf(next), "the Agent's next call runs normally").toBe("again\n");
    node.gateway.disconnect();
    await Promise.allSettled([sameAgent, otherAgent]);
  });

  it("a stop that arrives after the command returned, while its background still holds the output, kills the background", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const call = node.gateway.runTool("call-bg", agentId, "bash", {
      command: "sleep 30 & echo $! > background.pid; echo started; touch returned",
    });
    await eventually(() => existsSync(join(workspace, "returned")), "the command returned");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const background = readPid(join(workspace, "background.pid"));
    expect(running(background), "the background still runs").toBe(true);

    node.gateway.stopTool("call-bg");
    const result = await call;
    expect(textOf(result), "the command itself had finished").toContain("started");
    expect(textOf(result)).not.toContain("Command was stopped");
    await eventually(() => !running(background), "the background is killed", 2_000);
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

  it("exits instead of retrying when the gateway rejects its identity, with the status its service unit never restarts", async () => {
    const gateway = new FakeGateway({ onConnect: () => false });
    await gateway.start();
    const node = await startNodeProcess({ gateway });
    const ended = await Promise.race([
      node.exited,
      new Promise((resolve) => setTimeout(() => resolve("still running"), 5000)),
    ]);
    await gateway.close();
    expect(ended, node.stderr()).toEqual({ code: 78, signal: null });
    expect(node.stderr()).toContain("pairing_rejected");
  });

  it("reconnects instead of exiting when the gateway ends the connection over a protocol error such as a handshake timeout", async () => {
    let attempts = 0;
    const gateway = new FakeGateway({
      onConnect: () => (++attempts === 1 ? "handshake_timeout" : true),
    });
    await gateway.start();
    onTestFinished(() => gateway.close());
    const node = await startNodeProcess({ gateway });
    await Promise.race([
      gateway.waitForNode(),
      node.exited.then(({ code }) => {
        throw new Error(`node exited (${code}): ${node.stderr()}`);
      }),
    ]);
    expect(attempts, "the second attempt got in").toBe(2);
    expect(node.child.exitCode, "the node is still running").toBeNull();
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
