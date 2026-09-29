import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  OrdinaryCommandNotStartedError,
  OrdinaryCommandRunner,
  ordinaryCommandOutputLimitBytes,
} from "../../src/execution/ordinary-command.js";

const account = {
  username: userInfo().username,
  uid: typeof process.getuid === "function" ? process.getuid() : 0,
  gid: typeof process.getgid === "function" ? process.getgid() : 0,
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mate-ordinary-command-"));
  return {
    root,
    home: join(root, "workspace"),
    request(overrides: Record<string, unknown> = {}) {
      return {
        operationId: randomUUID(),
        agentId: randomUUID(),
        command: "printf hello",
        cwd: root,
        home: root,
        username: account.username,
        timeoutMs: 5000,
        ...overrides,
      } as Parameters<OrdinaryCommandRunner["run"]>[0];
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it("runs the command text verbatim as the launching account in the requested directory", async () => {
  const files = fixture(),
    runner = new OrdinaryCommandRunner();
  try {
    const receipt = await runner.run(
      files.request({
        command: `printf '%s|' "$(id -u)"; printf '%s|' "$HOME"; printf '%s|' "$PPID"; pwd`,
        home: files.home,
      }),
    );
    expect(receipt.code).toBe(0);
    expect(receipt.timedOut).toBe(false);
    expect(receipt.truncated).toBe(false);
    expect(receipt.signal).toBeNull();
    expect(receipt.processGroupRunning).toBe(false);
    expect(receipt.cwd).toBe(files.root);
    // The shell is an ordinary child of this process: no identity switch and no launcher between.
    expect(receipt.stdout.trimEnd().split("|")).toEqual([
      String(account.uid),
      files.home,
      String(process.pid),
      files.root,
    ]);
  } finally {
    files.cleanup();
  }
});

it("bounds captured output and reports the cut instead of hiding it", async () => {
  const files = fixture(),
    runner = new OrdinaryCommandRunner();
  try {
    const receipt = await runner.run(
      files.request({ command: "head -c 200000 /dev/zero | tr '\\000' x" }),
    );
    expect(receipt.code).toBe(0);
    expect(receipt.stdout).toHaveLength(ordinaryCommandOutputLimitBytes);
    expect(receipt.truncated).toBe(true);
  } finally {
    files.cleanup();
  }
});

it("kills a command that exceeds its time bound and reports the timeout truthfully", async () => {
  const files = fixture(),
    marker = join(files.root, "late"),
    runner = new OrdinaryCommandRunner();
  try {
    const receipt = await runner.run(
      files.request({ command: `sleep 5; printf late > ${marker}`, timeoutMs: 200 }),
    );
    expect(receipt.timedOut).toBe(true);
    expect(receipt.code).toBeNull();
    expect(receipt.signal).toBe("SIGKILL");
    expect(receipt.processGroupRunning).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(() => readFileSync(marker, "utf8")).toThrow();
  } finally {
    files.cleanup();
  }
});

it("reports a command that never started as a definite failure with no side effect", async () => {
  const files = fixture(),
    runner = new OrdinaryCommandRunner();
  try {
    await expect(
      runner.run(
        files.request({
          command: `touch ${join(files.root, "ran")} && printf started`,
          cwd: join(files.root, "missing-directory"),
        }),
      ),
    ).rejects.toBeInstanceOf(OrdinaryCommandNotStartedError);
    expect(() => readFileSync(join(files.root, "ran"), "utf8")).toThrow();
  } finally {
    files.cleanup();
  }
});

it("keeps tracking a command whose process group outlives its shell and stops it on request", async () => {
  const files = fixture(),
    runner = new OrdinaryCommandRunner(),
    agentId = randomUUID(),
    operationId = randomUUID();
  try {
    const receipt = await runner.run(
      files.request({ agentId, operationId, command: "sleep 30 & printf started" }),
    );
    expect(receipt.code).toBe(0);
    expect(receipt.stdout).toBe("started");
    expect(receipt.processGroupRunning).toBe(true);
    expect(runner.presence(agentId, operationId).state).toBe("descendants_running");
    expect(runner.list(agentId)).toEqual([
      expect.objectContaining({ operationId, exited: true, agentId }),
    ]);
    await expect(runner.stop(agentId, operationId)).resolves.toEqual({
      state: "stopped",
      operationId,
    });
    expect(runner.presence(agentId, operationId).state).toBe("not_tracked");
    expect(runner.list(agentId)).toEqual([]);
  } finally {
    await runner.stopAll(agentId);
    files.cleanup();
  }
});

it("does not report a process group as stopped while it still cannot confirm that", async () => {
  const files = fixture(),
    agentId = randomUUID(),
    operationId = randomUUID();
  let groupAlive = true;
  const runner = new OrdinaryCommandRunner({ processGroupAlive: () => groupAlive });
  try {
    const receipt = await runner.run(
      files.request({ agentId, operationId, command: "sleep 30", timeoutMs: 200 }),
    );
    expect(receipt.timedOut).toBe(true);
    // Something in the group outlived Mate's best-effort kill, so Mate says exactly that.
    expect(receipt.processGroupRunning).toBe(true);
    expect(runner.presence(agentId, operationId)).toEqual({
      state: "descendants_running",
      pid: expect.any(Number),
    });
    await expect(runner.stop(agentId, operationId)).resolves.toEqual({
      state: "unconfirmed",
      operationId,
      pid: expect.any(Number),
    });
    groupAlive = false;
    expect(runner.presence(agentId, operationId).state).toBe("not_tracked");
  } finally {
    files.cleanup();
  }
});

it("reports a stop of a command it never started as not running", async () => {
  const files = fixture(),
    runner = new OrdinaryCommandRunner();
  try {
    await expect(runner.stop(randomUUID(), randomUUID())).resolves.toEqual({
      state: "not_tracked",
    });
    expect(runner.presence(randomUUID(), randomUUID()).state).toBe("not_tracked");
    expect(runner.list(randomUUID())).toEqual([]);
  } finally {
    files.cleanup();
  }
});

it("keeps two Agents' tracked commands apart and stops only the requested Agent's", async () => {
  const files = fixture(),
    runner = new OrdinaryCommandRunner(),
    alice = randomUUID(),
    bob = randomUUID();
  try {
    const aliceOperation = randomUUID(),
      bobOperation = randomUUID();
    await runner.run(
      files.request({ agentId: alice, operationId: aliceOperation, command: "sleep 30 &" }),
    );
    await runner.run(
      files.request({ agentId: bob, operationId: bobOperation, command: "sleep 30 &" }),
    );
    expect(runner.list(alice).map((entry) => entry.operationId)).toEqual([aliceOperation]);
    await expect(runner.stopAll(alice)).resolves.toEqual({
      stopped: [aliceOperation],
      unconfirmed: [],
    });
    expect(runner.list(alice)).toEqual([]);
    expect(runner.list(bob).map((entry) => entry.operationId)).toEqual([bobOperation]);
    expect(runner.presence(alice, aliceOperation).state).toBe("not_tracked");
    expect(runner.presence(bob, bobOperation).state).toBe("descendants_running");
  } finally {
    await runner.stopAll(alice);
    await runner.stopAll(bob);
    files.cleanup();
  }
});

it("passes a command's own sudo to the host without adding anything around it", async () => {
  const files = fixture(),
    shim = join(files.root, "bin"),
    runner = new OrdinaryCommandRunner();
  try {
    const { mkdirSync, chmodSync } = await import("node:fs");
    mkdirSync(shim, { recursive: true });
    const recorded = join(files.root, "sudo-argv");
    writeFileSync(
      join(shim, "sudo"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${recorded}\nprintf 'sudo refused\\n' >&2\nexit 7\n`,
      { mode: 0o700 },
    );
    chmodSync(join(shim, "sudo"), 0o700);
    const receipt = await runner.run(files.request({ command: `PATH="${shim}:$PATH" sudo id -u` }));
    expect(receipt.code).toBe(7);
    expect(receipt.stderr).toBe("sudo refused\n");
    expect(readFileSync(recorded, "utf8")).toBe("id\n-u\n");
  } finally {
    files.cleanup();
  }
});

it("reports nothing about a descendant that left the process group", async () => {
  // A command can start something in its own new session, which is how a sudo child with a pty can
  // look. That descendant is outside the only thing Mate can observe, so Mate must report nothing
  // about it — neither that it is running nor that it was stopped.
  const files = fixture(),
    runner = new OrdinaryCommandRunner(),
    agentId = randomUUID(),
    operationId = randomUUID();
  try {
    const escaped = `${JSON.stringify(process.execPath)} -e "require('node:child_process').spawn('sleep',['1'],{detached:true,stdio:'ignore'}).unref()"`;
    const receipt = await runner.run(files.request({ agentId, operationId, command: escaped }));
    expect(receipt.code).toBe(0);
    expect(receipt.processGroupRunning).toBe(false);
    await expect(runner.stop(agentId, operationId)).resolves.toEqual({ state: "not_tracked" });
    expect(runner.presence(agentId, operationId).state).toBe("not_tracked");
  } finally {
    files.cleanup();
  }
});

it("forgets a tracked process group whose ID now belongs to another process", async () => {
  // A group ID can only be reused once its group has ended. If the host says this ID is now a
  // different process incarnation, the entry is stale and must never be signalled.
  const files = fixture(),
    agentId = randomUUID(),
    operationId = randomUUID();
  let token = "the-command-mate-started";
  const runner = new OrdinaryCommandRunner({ processStartToken: () => token });
  let pid: number | undefined;
  try {
    const receipt = await runner.run(
      files.request({ agentId, operationId, command: "sleep 30 & printf started" }),
    );
    expect(receipt.processGroupRunning).toBe(true);
    pid = runner.list(agentId)[0]!.pid;
    expect(runner.presence(agentId, operationId).state).toBe("descendants_running");
    token = "a-stranger-now-holds-this-id";
    expect(runner.presence(agentId, operationId).state).toBe("not_tracked");
    await expect(runner.stop(agentId, operationId)).resolves.toEqual({ state: "not_tracked" });
    expect(runner.list(agentId)).toEqual([]);
  } finally {
    if (pid !== undefined) process.kill(-pid, "SIGKILL");
    files.cleanup();
  }
});

it("accepts parent and symlink working directories and preserves complete foreground output", async () => {
  const files = fixture(),
    runner = new OrdinaryCommandRunner();
  try {
    const { symlinkSync, realpathSync } = await import("node:fs");
    symlinkSync(files.root, join(files.root, "linked"));
    const linked = await runner.run(
      files.request({ cwd: join(files.root, "linked"), command: "pwd -P" }),
    );
    expect(linked.stdout.trim()).toBe(realpathSync(files.root));
    const parent = await runner.run(
      files.request({ cwd: `${files.root}/..`, command: "pwd -P" }),
    );
    expect(parent.code).toBe(0);
    expect(parent.stdout.trim()).toBe(realpathSync(join(files.root, "..")));
    const output = await runner.run(
      files.request({ command: "head -c 60000 /dev/zero | tr '\\000' x" }),
    );
    expect(output.stdout).toBe("x".repeat(60000));
    expect(output.truncated).toBe(false);
  } finally {
    files.cleanup();
  }
});

it("uses an installed CLI on a subsequent call through the existing host PATH", async () => {
  const files = fixture();
  const runner = new OrdinaryCommandRunner({
    environment: { ...process.env, PATH: `${files.root}/.local/bin:${process.env.PATH}` },
  });
  try {
    const install = await runner.run(
      files.request({
        command:
          'mkdir -p "$HOME/.local/bin"; printf "#!/bin/sh\\nprintf cli-ready\\n" > "$HOME/.local/bin/mate-test-cli"; chmod 700 "$HOME/.local/bin/mate-test-cli"',
      }),
    );
    expect(install.code).toBe(0);
    expect(await runner.run(files.request({ command: "mate-test-cli" }))).toMatchObject({
      code: 0,
      stdout: "cli-ready",
    });
  } finally {
    files.cleanup();
  }
});
