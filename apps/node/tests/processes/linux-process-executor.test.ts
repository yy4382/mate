import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  OrdinaryCommandRunner,
  type OrdinaryCommandReceipt,
} from "../../src/processes/ordinary-command.js";
import { prepareAgentWorkspace } from "../../src/provisioning/agent-workspace.js";
import {
  createLinuxAgentProcessExecutor,
  type LinuxAgentProcessExecutorOptions,
} from "../../src/processes/linux-process-executor.js";
import { AgentProcessOperations } from "../../src/processes/operation-ledger.js";

const accountUid = typeof process.getuid === "function" ? process.getuid() : 0;

async function commandFixture(options: LinuxAgentProcessExecutorOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "mate-agent-command-"));
  const workspaceRoot = join(root, "agents");
  const agentId = randomUUID();
  const identity = await prepareAgentWorkspace({ agentId, workspaceRoot });
  const runner = options.runner ?? new OrdinaryCommandRunner();
  const database = new Database(join(root, "operations.sqlite"));
  const operations = new AgentProcessOperations(
    database,
    createLinuxAgentProcessExecutor(workspaceRoot, { ...options, runner }),
  );
  return {
    root,
    agentId,
    identity,
    database,
    operations,
    async cleanup() {
      await runner.stopAll(agentId);
      database.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it("runs an ordinary command in the Agent's own workspace as the launching account", async () => {
  const fixture = await commandFixture();
  try {
    const receipt = await fixture.operations.execute(fixture.agentId, randomUUID(), {
      kind: "exec",
      command: `printf '%s|' "$(id -u)"; printf '%s|' "$HOME"; pwd; : > wrote-here.txt`,
      cwd: ".",
    });
    expect(receipt.state).toBe("succeeded");
    expect(receipt.receipt).toMatchObject({
      code: 0,
      signal: null,
      truncated: false,
      timedOut: false,
      cwd: fixture.identity.workspace,
    });
    const [uid, home, cwd] = (receipt.receipt as { stdout: string }).stdout.trimEnd().split("|");
    expect(uid).toBe(String(accountUid));
    expect(home).toBe(fixture.identity.workspace);
    expect(cwd).toBe(fixture.identity.workspace);
    expect(readFileSync(join(fixture.identity.workspace, "wrote-here.txt"), "utf8")).toBe("");
    expect(userInfo().username).toBe(fixture.identity.username);
  } finally {
    await fixture.cleanup();
  }
});

it("runs in a workspace subdirectory the Agent names and refuses one that does not exist", async () => {
  const fixture = await commandFixture();
  try {
    mkdirSync(join(fixture.identity.workspace, "sub"));
    const receipt = await fixture.operations.execute(fixture.agentId, randomUUID(), {
      kind: "exec",
      command: "pwd",
      cwd: "sub",
    });
    expect(receipt.state).toBe("succeeded");
    expect(receipt.receipt).toMatchObject({
      cwd: join(fixture.identity.workspace, "sub"),
    });
    const missing = await fixture.operations.execute(fixture.agentId, randomUUID(), {
      kind: "exec",
      command: "pwd",
      cwd: "not-there",
    });
    expect(missing).toMatchObject({
      state: "failed",
      receipt: { reason: "command_cwd_unavailable" },
    });
  } finally {
    await fixture.cleanup();
  }
});

it("reports a failed command with its real exit code and stderr", async () => {
  const fixture = await commandFixture();
  try {
    const receipt = await fixture.operations.execute(fixture.agentId, randomUUID(), {
      kind: "exec",
      command: "printf 'boom' >&2; exit 9",
      cwd: ".",
    });
    expect(receipt.state).toBe("failed");
    expect(receipt.receipt).toMatchObject({
      code: 9,
      stderr: "boom",
      timedOut: false,
      processGroupRunning: false,
    });
  } finally {
    await fixture.cleanup();
  }
});

it("reports truncated output instead of passing it off as the whole result", async () => {
  const fixture = await commandFixture();
  try {
    const receipt = await fixture.operations.execute(fixture.agentId, randomUUID(), {
      kind: "exec",
      command: "head -c 200000 /dev/zero | tr '\\000' x",
      cwd: ".",
    });
    expect(receipt.state).toBe("succeeded");
    expect(receipt.receipt).toHaveProperty("truncated", true);
    expect(receipt.receipt).toHaveProperty("stdout.length", 65_536);
  } finally {
    await fixture.cleanup();
  }
});

it("reports a timed-out command as failed and stops the work that had not run yet", async () => {
  const fixture = await commandFixture({ commandTimeoutMs: 300 });
  try {
    const marker = join(fixture.identity.workspace, "late.txt");
    const receipt = await fixture.operations.execute(fixture.agentId, randomUUID(), {
      kind: "exec",
      command: `sleep 5; : > ${marker}`,
      cwd: ".",
    });
    expect(receipt.state).toBe("failed");
    expect(receipt.receipt).toMatchObject({
      code: null,
      signal: "SIGKILL",
      timedOut: true,
      processGroupRunning: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(() => readFileSync(marker, "utf8")).toThrow();
  } finally {
    await fixture.cleanup();
  }
});

it("replays one operation ID from its durable receipt without running the command twice", async () => {
  const fixture = await commandFixture();
  try {
    const operationId = randomUUID();
    const operation = {
      kind: "exec" as const,
      command: "printf 'once\\n' >> ledger.txt",
      cwd: ".",
    };
    const ledger = join(fixture.identity.workspace, "ledger.txt");
    const first = await fixture.operations.execute(fixture.agentId, operationId, operation);
    const second = await fixture.operations.execute(fixture.agentId, operationId, operation);
    expect(first.state).toBe("succeeded");
    expect(second).toEqual(first);
    expect(readFileSync(ledger, "utf8")).toBe("once\n");
  } finally {
    await fixture.cleanup();
  }
});

it("refuses to reuse an operation ID for other input without running the second command", async () => {
  const fixture = await commandFixture();
  try {
    const operationId = randomUUID();
    const ledger = join(fixture.identity.workspace, "ledger.txt");
    await fixture.operations.execute(fixture.agentId, operationId, {
      kind: "exec",
      command: "printf 'once\\n' >> ledger.txt",
      cwd: ".",
    });
    await expect(
      fixture.operations.execute(fixture.agentId, operationId, {
        kind: "exec",
        command: "printf 'twice\\n' >> ledger.txt",
        cwd: ".",
      }),
    ).rejects.toThrow("identity conflict");
    expect(readFileSync(ledger, "utf8")).toBe("once\n");
  } finally {
    await fixture.cleanup();
  }
});

it("passes the Agent's own sudo through to the host without wrapping or approving it", async () => {
  const fixture = await commandFixture();
  try {
    const shim = join(fixture.identity.workspace, "bin");
    const recorded = join(fixture.identity.workspace, "sudo-argv");
    mkdirSync(shim);
    writeFileSync(
      join(shim, "sudo"),
      `#!/bin/sh
printf '%s\\n' "$@" > ${recorded}
printf 'sudo refused\\n' >&2
exit 7
`,
    );
    chmodSync(join(shim, "sudo"), 0o700);
    const receipt = await fixture.operations.execute(fixture.agentId, randomUUID(), {
      kind: "exec",
      command: `PATH="${shim}:$PATH" sudo id -u`,
      cwd: ".",
    });
    expect(receipt.state).toBe("failed");
    expect(receipt.receipt).toMatchObject({ code: 7, stderr: "sudo refused\n" });
    expect(readFileSync(recorded, "utf8")).toBe("id\n-u\n");
  } finally {
    await fixture.cleanup();
  }
});

it("reports an explicit sudo the host allowed as that command's own success", async () => {
  const fixture = await commandFixture();
  try {
    const shim = join(fixture.identity.workspace, "bin");
    const recorded = join(fixture.identity.workspace, "sudo-argv");
    mkdirSync(shim);
    writeFileSync(
      join(shim, "sudo"),
      `#!/bin/sh
printf '%s\\n' "$@" > ${recorded}
printf 'root\\n'
exit 0
`,
    );
    chmodSync(join(shim, "sudo"), 0o700);
    const receipt = await fixture.operations.execute(fixture.agentId, randomUUID(), {
      kind: "exec",
      command: `PATH="${shim}:$PATH" sudo id -un`,
      cwd: ".",
    });
    // The host allowed it, so the receipt is an ordinary successful command result: no Mate
    // approval state exists anywhere on this path.
    expect(receipt.state).toBe("succeeded");
    expect(receipt.receipt).toMatchObject({
      code: 0,
      stdout: "root\n",
      stderr: "",
      timedOut: false,
    });
    expect(readFileSync(recorded, "utf8")).toBe("id\n-un\n");
  } finally {
    await fixture.cleanup();
  }
});

it("never inserts sudo the Agent did not write", async () => {
  const fixture = await commandFixture();
  try {
    const shim = join(fixture.identity.workspace, "bin");
    const recorded = join(fixture.identity.workspace, "sudo-was-called");
    mkdirSync(shim);
    writeFileSync(
      join(shim, "sudo"),
      `#!/bin/sh
: > ${recorded}
exit 0
`,
    );
    chmodSync(join(shim, "sudo"), 0o700);
    const receipt = await fixture.operations.execute(fixture.agentId, randomUUID(), {
      kind: "exec",
      command: `PATH="${shim}:$PATH" id -u`,
      cwd: ".",
    });
    expect(receipt.state).toBe("succeeded");
    expect(() => readFileSync(recorded, "utf8")).toThrow();
  } finally {
    await fixture.cleanup();
  }
});

it("keeps tracking a command whose group outlives its shell and reports it to the Agent", async () => {
  const fixture = await commandFixture();
  try {
    const started = await fixture.operations.execute(fixture.agentId, randomUUID(), {
      kind: "exec",
      command: "sleep 30 & printf started",
      cwd: ".",
    });
    const operationId = started.operationId;
    expect(started.state).toBe("succeeded");
    expect(started.receipt).toMatchObject({ stdout: "started", processGroupRunning: true });
    const listed = await fixture.operations.execute(fixture.agentId, randomUUID(), {
      kind: "process.list",
    });
    expect(listed.receipt).toEqual({
      processes: [
        expect.objectContaining({
          operationId,
          state: "descendants_running",
          pid: expect.any(Number),
        }),
      ],
    });
    const inspected = await fixture.operations.execute(fixture.agentId, randomUUID(), {
      kind: "process.inspect",
      targetOperationId: operationId,
    });
    expect(inspected.receipt).toMatchObject({ operationId, state: "descendants_running" });
    const stopped = await fixture.operations.execute(fixture.agentId, randomUUID(), {
      kind: "process.stop",
      targetOperationId: operationId,
    });
    expect(stopped).toMatchObject({
      state: "succeeded",
      receipt: { operationId, state: "stopped" },
    });
    const after = await fixture.operations.execute(fixture.agentId, randomUUID(), {
      kind: "process.list",
    });
    expect(after.receipt).toEqual({ processes: [] });
  } finally {
    await fixture.cleanup();
  }
});

it("reports an unconfirmable stop instead of claiming the command was stopped", async () => {
  // A descendant Mate may not signal (for example a root process sudo created) keeps the process
  // group alive. This substitutes only the liveness probe, because creating such a descendant
  // needs root; the kill itself is still real.
  const fixture = await commandFixture({
    runner: new OrdinaryCommandRunner({ processGroupAlive: () => true }),
  });
  try {
    const started = await fixture.operations.execute(fixture.agentId, randomUUID(), {
      kind: "exec",
      command: "sleep 30 & printf started",
      cwd: ".",
    });
    const operationId = started.operationId;
    expect(started.receipt).toMatchObject({ processGroupRunning: true });
    const stopped = await fixture.operations.execute(fixture.agentId, randomUUID(), {
      kind: "process.stop",
      targetOperationId: operationId,
    });
    expect(stopped).toMatchObject({
      state: "failed",
      receipt: { reason: "process_stop_unconfirmed", state: "unconfirmed", operationId },
    });
    expect(
      await fixture.operations.execute(fixture.agentId, randomUUID(), { kind: "process.stop_all" }),
    ).toMatchObject({
      state: "failed",
      receipt: { reason: "process_stop_unconfirmed", stopped: false },
    });
  } finally {
    await fixture.cleanup();
  }
});

it("never reports a command Mate had to end as a success", async () => {
  // The shell can exit with code 0 in the same instant the deadline fires. Whatever its exit
  // status was, a command Mate ended (or one that died from a signal) is not a success.
  let receipt: OrdinaryCommandReceipt = {
    code: 0,
    signal: null,
    stdout: "finished",
    stderr: "",
    truncated: false,
    timedOut: true,
    processGroupRunning: false,
    cwd: "/tmp/agent-workspace",
    startedAt: 1,
    durationMs: 2,
  };
  const fixture = await commandFixture({
    runner: {
      run: async () => receipt,
      list: () => [],
      presence: () => ({ state: "not_tracked" }),
      stop: async () => ({ state: "not_tracked" }),
      stopAll: async () => ({ stopped: [], unconfirmed: [] }),
    },
  });
  try {
    const execute = () =>
      fixture.operations.execute(fixture.agentId, randomUUID(), {
        kind: "exec",
        command: "true",
        cwd: ".",
      });
    expect(await execute()).toMatchObject({
      state: "failed",
      receipt: { code: 0, timedOut: true },
    });
    receipt = { ...receipt, timedOut: false, signal: "SIGKILL" };
    expect(await execute()).toMatchObject({
      state: "failed",
      receipt: { code: 0, signal: "SIGKILL", timedOut: false },
    });
  } finally {
    await fixture.cleanup();
  }
});

it("says which commands its Agent-wide stop covers", async () => {
  // The tracker only knows this node process's commands, and the receipt must say so instead of
  // letting an empty list read as "nothing from an earlier node run can still be running".
  const fixture = await commandFixture();
  try {
    expect(
      await fixture.operations.execute(fixture.agentId, randomUUID(), { kind: "process.stop_all" }),
    ).toMatchObject({
      state: "succeeded",
      receipt: { stopped: true, operationIds: [], scope: "this_node_run" },
    });
  } finally {
    await fixture.cleanup();
  }
});
