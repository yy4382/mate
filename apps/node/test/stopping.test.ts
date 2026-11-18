import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { FakeGateway } from "@palace/testkit";
import {
  connectedNode,
  displayTerminalResult,
  eventually,
  execCommand,
  longCommand,
  pidsOf,
  readPid,
  running,
  scriptCommand,
  startNodeProcess,
  temporaryDirectory,
  textOf,
  windows,
  writeStdin,
} from "./support.ts";

describe("node connection and stopping (TESTS 1.3)", () => {
  it("stops the process groups of running tool calls when the connection drops", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const call = execCommand(node, agentId, { command: longCommand("call") });
    const pids = await pidsOf(workspace, "call");
    expect(pids.every(running), "the command runs").toBe(true);

    node.gateway.disconnect();
    await expect(call, "the dropped connection ends the call for the gateway").rejects.toThrow();
    for (const pid of pids) await eventually(() => !running(pid), `process ${pid} is stopped`);
  });

  it("stops detached yielded sessions when terminal_wait is stopped or the connection drops", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const first = await execCommand(node, agentId, {
      command: longCommand("waitstop"),
      yieldTimeMs: 0,
    });
    expect(first.outcome?.running).toBe(true);
    const firstPids = await pidsOf(workspace, "waitstop");
    expect(firstPids.every(running)).toBe(true);

    const waitCall = node.gateway.runTool("wait-stop", agentId, "terminal_wait", {
      sessionId: first.sessionId,
    });
    // Allow gateway message to reach node before stopping it.
    await eventually(() => running(firstPids[0]!), "process runs");
    node.gateway.stopTool("wait-stop");
    expect((await waitCall).isError).toBe(true);
    for (const pid of firstPids)
      await eventually(() => !running(pid), `waited process ${pid} is stopped`);

    const second = await execCommand(node, agentId, {
      command: longCommand("drop"),
      yieldTimeMs: 0,
    });
    expect(second.outcome?.running).toBe(true);
    const secondPids = await pidsOf(workspace, "drop");
    expect(secondPids.every(running)).toBe(true);
    node.gateway.disconnect();
    for (const pid of secondPids)
      await eventually(() => !running(pid), `detached process ${pid} is stopped`);
  });

  it("stops a newly yielded session on late gateway.stop.tool or terminal_write kill before it can touch files", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const gatedCommand = (tag: string, releaseFile: string, leakedFile: string) =>
      scriptCommand(
        workspace,
        [
          'import { existsSync, writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(`${tag}.pids`)}, String(process.pid));`,
          `const timer = setInterval(() => {`,
          `  if (existsSync(${JSON.stringify(releaseFile)})) {`,
          `    clearInterval(timer);`,
          `    writeFileSync(${JSON.stringify(leakedFile)}, "mutated");`,
          "    process.exit(0);",
          "  }",
          "}, 10);",
        ].join("\n"),
        tag,
      );

    // Case A: gateway.stop.tool arrives after terminal_exec already yielded running: true.
    const sessionA = randomUUID();
    const execA = await node.gateway.runTool("exec-yield-stop", agentId, "terminal_exec", {
      sessionId: sessionA,
      command: gatedCommand("yield-stop-a", "release-a", "leaked-a"),
      yieldTimeMs: 20,
    });
    expect(displayTerminalResult(execA).outcome?.running).toBe(true);
    const pidsA = await pidsOf(workspace, "yield-stop-a");
    node.gateway.stopTool("exec-yield-stop");
    for (const pid of pidsA) {
      await eventually(() => !running(pid), `yielded process ${pid} stopped via late stopTool`);
    }
    writeFileSync(join(workspace, "release-a"), "go");
    expect(existsSync(join(workspace, "leaked-a"))).toBe(false);

    // Case B: terminal_write({ kill: true }) arrives while terminal_exec is still waiting in flight.
    const sessionB = randomUUID();
    const execB = execCommand(node, agentId, {
      sessionId: sessionB,
      command: gatedCommand("kill-race-b", "release-b", "leaked-b"),
      yieldTimeMs: 30_000,
    });
    const pidsB = await pidsOf(workspace, "kill-race-b");
    const killResult = await writeStdin(node, agentId, {
      sessionId: sessionB,
      yieldTimeMs: 0,
      kill: true,
    });
    expect(killResult.isError).toBe(false);
    expect(killResult.outcome).toMatchObject({ running: false, ending: { kind: "killed" } });
    writeFileSync(join(workspace, "release-b"), "go");
    const settledB = await execB;
    expect(settledB.outcome?.running).toBe(false);
    for (const pid of pidsB) {
      await eventually(() => !running(pid), `raced process ${pid} is stopped`);
    }
    expect(existsSync(join(workspace, "leaked-b"))).toBe(false);
  });

  it("a stop ends that one call's process group and leaves every other call running, of the same Agent or another", async () => {
    const node = await connectedNode();
    const first = await node.agent();
    const second = await node.agent();
    const stopped = node.gateway.runTool("call-a", first.agentId, "terminal_exec", {
      sessionId: randomUUID(),
      command: longCommand("a"),
    });
    const sameAgent = execCommand(node, first.agentId, { command: longCommand("b") });
    const otherAgent = execCommand(node, second.agentId, { command: longCommand("c") });
    const stoppedPids = await pidsOf(first.workspace, "a");
    const otherPids = [
      ...(await pidsOf(first.workspace, "b")),
      ...(await pidsOf(second.workspace, "c")),
    ];

    node.gateway.stopTool("call-a");
    const result = displayTerminalResult(await stopped);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Command was stopped");
    for (const pid of stoppedPids) {
      await eventually(() => !running(pid), `process ${pid} is stopped`);
    }
    expect(otherPids.every(running), "the other calls' commands still run").toBe(true);

    const next = await execCommand(node, first.agentId, { command: "echo again" });
    expect(textOf(next).split(/\r?\n/)[0], "the Agent's next call runs normally").toBe("again");
    node.gateway.disconnect();
    await Promise.allSettled([sameAgent, otherAgent]);
  });

  it.runIf(windows)(
    "accepts failed Windows termination when the process has already exited",
    async () => {
      const bin = temporaryDirectory();
      const racingTaskkill = join(bin, "taskkill.exe");
      copyFileSync(process.execPath, racingTaskkill);
      const preload = join(bin, "taskkill.cjs");
      writeFileSync(
        preload,
        `
if (require('node:path').basename(process.execPath).toLowerCase() === 'taskkill.exe') {
  const result = require('node:child_process').spawnSync(
    require('node:path').join(process.env.SystemRoot, 'System32', 'taskkill.exe'),
    ['/PID', ...process.argv.slice(2)],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(JSON.stringify(result));
  process.exit(1);
}
`,
      );
      const hostPath =
        Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
      const node = await connectedNode({
        env: {
          PATH: `${bin};${hostPath}`,
          NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
        },
      });
      const { agentId, workspace } = await node.agent();
      const call = node.gateway.runTool("exit-during-stop", agentId, "terminal_exec", {
        sessionId: randomUUID(),
        command: longCommand("exit-during-stop"),
      });
      const pids = await pidsOf(workspace, "exit-during-stop");
      try {
        node.gateway.stopTool("exit-during-stop");
        const result = displayTerminalResult(await call);
        expect(textOf(result)).toContain("Command was stopped");
        expect(textOf(result)).not.toContain("processes may still be running");
        for (const pid of pids) await eventually(() => !running(pid), `process ${pid} is stopped`);
      } finally {
        rmSync(racingTaskkill);
        await node.shutdown();
      }
      expect(await node.exited).toEqual({ code: 0, signal: null });
    },
  );

  it.runIf(windows)(
    "reports failed Windows tree termination and retries it on shutdown",
    async () => {
      const bin = temporaryDirectory();
      const failingTaskkill = join(bin, "taskkill.exe");
      copyFileSync(process.execPath, failingTaskkill);
      const hostPath =
        Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
      const node = await connectedNode({ env: { PATH: `${bin};${hostPath}` } });
      const { agentId, workspace } = await node.agent();
      const call = node.gateway.runTool("cannot-stop", agentId, "terminal_exec", {
        sessionId: randomUUID(),
        command: longCommand("failed-stop"),
      });
      const pids = await pidsOf(workspace, "failed-stop");
      try {
        node.gateway.stopTool("cannot-stop");
        const raw = await Promise.race([
          call,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("failed stop did not return")), 20_000),
          ),
        ]);
        const result = displayTerminalResult(raw);
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("Command could not be stopped");
        expect(textOf(result)).toContain("processes may still be running");
        expect(textOf(result)).not.toContain("Command could not start");
        expect(pids.every(running), "the failure does not claim the tree was killed").toBe(true);
      } finally {
        rmSync(failingTaskkill);
        await node.shutdown();
      }
      for (const pid of pids)
        await eventually(() => !running(pid), `shutdown retried process ${pid}`);
      expect(await node.exited).toEqual({ code: 0, signal: null });
    },
  );

  it.each(windows ? ["alive"] : ["alive", "exited"])(
    "retries a failed stop when the shell is %s",
    async (state) => {
      const bin = temporaryDirectory();
      const blocker = join(bin, windows ? "taskkill.exe" : "deny-kill");
      let env: NodeJS.ProcessEnv;
      if (windows) {
        copyFileSync(process.execPath, blocker);
        const path = Object.entries(process.env).find(([key]) => key.toLowerCase() === "path");
        env = { PATH: `${bin};${path?.[1] ?? ""}` };
      } else {
        writeFileSync(blocker, "");
        const preload = join(bin, "deny-kill.cjs");
        writeFileSync(
          preload,
          `
const kill = process.kill;
process.kill = function(pid, signal) {
  if (pid < 0 && signal === "SIGKILL" && require("node:fs").existsSync(${JSON.stringify(blocker)})) {
    throw Object.assign(new Error("permission denied"), { code: "EPERM" });
  }
  return kill.call(process, pid, signal);
};`,
        );
        env = { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
      }
      const node = await connectedNode({ env });
      const { agentId, workspace } = await node.agent();
      let command = longCommand("retry-stop");
      if (state === "exited") {
        const child = scriptCommand(
          workspace,
          [
            'import { writeFileSync } from "node:fs";',
            'const writer = setInterval(() => process.stdout.write("."), 20);',
            'process.stdout.once("error", () => { clearInterval(writer); writeFileSync("pipes-closed", ""); });',
            "setTimeout(() => process.exit(0), 60_000);",
          ].join("\n"),
        );
        command = `${child} & echo $! > retry-stop.pids; echo $$ > shell.pid`;
      }
      const { sessionId } = await execCommand(node, agentId, { command, yieldTimeMs: 0 });
      const pids = await pidsOf(workspace, "retry-stop");
      if (state === "exited") {
        await eventually(
          () =>
            existsSync(join(workspace, "shell.pid")) &&
            !running(readPid(join(workspace, "shell.pid"))),
          "shell exited",
        );
      }
      let observed = false;
      const observation = node
        .run(agentId, "terminal_wait", { sessionId, observeOnly: true })
        .then((result) => {
          observed = true;
          return result;
        });
      const stop = () => writeStdin(node, agentId, { sessionId, kill: true });
      try {
        const failed = await stop();
        expect(failed.outcome).toMatchObject({ ending: { kind: "stop-failed" } });
        if (state === "exited") {
          await eventually(
            () => existsSync(join(workspace, "pipes-closed")),
            "child outlives the shell's exit grace",
          );
        }
        expect(pids.every(running)).toBe(true);
        await node.run(agentId, "memory_read", {});
        expect(observed, "an unconfirmed stop keeps the session under observation").toBe(false);
      } finally {
        rmSync(blocker);
      }
      expect((await stop()).outcome).toMatchObject({
        ending: { kind: state === "alive" ? "killed" : "exited" },
      });
      for (const pid of pids) await eventually(() => !running(pid), `stopped process ${pid}`);
      expect((await observation).isError).toBe(false);
    },
  );

  it.skipIf(windows)("stops a POSIX background process after its shell has returned", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const call = node.gateway.runTool("call-bg", agentId, "terminal_exec", {
      sessionId: randomUUID(),
      command: "sleep 30 & echo $! > background.pid; echo started; touch returned",
    });
    await eventually(() => existsSync(join(workspace, "returned")), "the command returned");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const background = readPid(join(workspace, "background.pid"));
    expect(running(background), "the background still runs").toBe(true);

    node.gateway.stopTool("call-bg");
    const result = displayTerminalResult(await call);
    expect(textOf(result), "the command itself had finished").toContain("started");
    expect(textOf(result)).not.toContain("Command was stopped");
    await eventually(() => !running(background), "the background is killed", 2_000);
  });

  it("on normal shutdown stops all running commands and their descendants", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const second = await node.agent();
    void execCommand(node, agentId, { command: longCommand("first") }).catch(() => {});
    void execCommand(node, second.agentId, { command: longCommand("second") }).catch(() => {});
    const pids = [
      ...(await pidsOf(workspace, "first")),
      ...(await pidsOf(second.workspace, "second")),
    ];
    expect(pids.every(running)).toBe(true);
    await node.shutdown();
    expect(await node.exited, "a requested shutdown is a clean exit").toEqual({
      code: 0,
      signal: null,
    });
    for (const pid of pids) {
      await eventually(() => !running(pid), `process ${pid} is stopped`);
    }
  });

  it.skipIf(windows)(
    "on shutdown stops POSIX background groups whose shell already returned",
    async () => {
      const node = await connectedNode();
      const { agentId, workspace } = await node.agent();
      const finished = await execCommand(node, agentId, {
        command: "sleep 30 > /dev/null 2>&1 & echo $! > background.pid",
      });
      expect(finished.isError).toBe(false);
      const background = readPid(join(workspace, "background.pid"));
      void execCommand(node, agentId, { command: longCommand("running") }).catch(() => {});
      const runningPids = await pidsOf(workspace, "running");
      expect(running(background), "the finished command's background still runs").toBe(true);

      await node.shutdown();
      expect(await node.exited, "a requested shutdown is a clean exit").toEqual({
        code: 0,
        signal: null,
      });
      for (const pid of [background, ...runningPids]) {
        await eventually(() => !running(pid), `process ${pid} is stopped`);
      }
    },
  );

  it("runs commands the same after memory/MEMORY.md or memory/ is made unreadable or deleted", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const memoryDir = join(workspace, "memory");
    const memory = join(memoryDir, "MEMORY.md");
    expect(existsSync(memoryDir), "preparing creates memory/").toBe(true);
    expect(existsSync(join(workspace, "MEMORY.md"))).toBe(false);
    writeFileSync(memory, "fact");
    if (!windows) chmodSync(memory, 0o000);
    expect(
      textOf(await execCommand(node, agentId, { command: "echo unreadable" })).split(/\r?\n/)[0],
    ).toBe("unreadable");
    if (windows) chmodSync(memory, 0o600);
    rmSync(memoryDir, { recursive: true });
    expect(
      textOf(await execCommand(node, agentId, { command: "echo deleted" })).split(/\r?\n/)[0],
    ).toBe("deleted");
    expect(
      (await node.run(agentId, "write", { path: "notes.txt", content: "x" })).isError,
      "file tools too",
    ).toBe(false);
    expect(existsSync(memoryDir)).toBe(false);
    expect((await node.gateway.prepareWorkspace("prepare-existing", agentId)).isError).toBe(false);
    expect(existsSync(memoryDir)).toBe(true);
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "topic.md"), "kept");
    expect((await node.gateway.prepareWorkspace("prepare-preserves", agentId)).isError).toBe(false);
    expect(readFileSync(join(memoryDir, "topic.md"), "utf8")).toBe("kept");
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
      const result = await execCommand(node, agentId, { command: "echo back" });
      expect(textOf(result).split(/\r?\n/)[0]).toBe("back");
    } finally {
      await second.close();
    }
  });

  it("returns a clear error and does not recreate a workspace that is missing", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    rmSync(workspace, { recursive: true });
    for (const run of [
      () => execCommand(node, agentId, { command: "echo hi" }),
      () => node.run(agentId, "write", { path: "a.txt", content: "a" }),
      () => node.run(agentId, "read", { path: "a.txt" }),
    ] as const) {
      const result = await run();
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/does not exist\. The node does not recreate it/);
    }
    expect(existsSync(workspace)).toBe(false);
  });
});
