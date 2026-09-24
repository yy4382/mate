import { expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSystemctlRunner,
  LinuxProcessManager,
  ProcessNotRunningError,
  ProcessStopRejectedError,
  ProcessWaitInterruptedError,
} from "../../src/execution/linux-processes.js";

const unit = "mate-agent-1001-123e4567-e89b-42d3-a456-426614174000.scope";
const group = `/mate-agent-1001.slice/${unit}`;
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const report = (active = true) =>
  `Id=${unit}\nActiveState=${active ? "active" : "inactive"}\nSlice=mate-agent-1001.slice\nControlGroup=${group}\n`;
const deadline = 4000;
function within<T>(work: Promise<T>, ms = deadline): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error("the wait did not finish in time")), ms),
    ),
  ]);
}

it("lists current systemd scopes after restart without a Mate job record", async () => {
  const calls: string[][] = [];
  const manager = new LinuxProcessManager(
    { alice: 1001 },
    async (args) => {
      calls.push(args);
      return args[0] === "list-units" ? ok(`${unit} loaded active running Agent\n`) : ok(report());
    },
    () => [4101],
    () => 1001,
  );
  await expect(manager.list("alice")).resolves.toEqual([{ unit, pids: [4101] }]);
  expect(calls.map((call) => call[0])).toEqual(["list-units", "show"]);
});

it("skips a scope that disappears between list-units and show", async () => {
  const manager = new LinuxProcessManager({ alice: 1001 }, async (args) =>
    args[0] === "list-units"
      ? ok(`${unit} loaded active running Agent\n`)
      : ok(`Id=${unit}\nLoadState=not-found\nActiveState=inactive\n`),
  );
  await expect(manager.list("alice")).resolves.toEqual([]);
});

it("classifies rejection before stop separately from uncertain post-stop failure", async () => {
  let stopped = false;
  const missing = new LinuxProcessManager({ alice: 1001 }, async (args) => {
    if (args[0] === "stop") stopped = true;
    return ok(`Id=${unit}\nLoadState=not-found\nActiveState=inactive\n`);
  });
  await expect(missing.stop("alice", unit)).rejects.toBeInstanceOf(ProcessNotRunningError);
  expect(stopped).toBe(false);
  const wrong = new LinuxProcessManager({ alice: 1001 }, async () =>
    ok(`Id=${unit}\nActiveState=active\nSlice=other.slice\nControlGroup=${group}\n`),
  );
  await expect(wrong.stop("alice", unit)).rejects.toBeInstanceOf(ProcessStopRejectedError);
  const broken = new LinuxProcessManager(
    { alice: 1001 },
    async (args) =>
      args[0] === "show" ? ok(report()) : { code: 1, stdout: "", stderr: "stop failed" },
    () => [4101],
    () => 1001,
  );
  const failure = await broken.stop("alice", unit).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(ProcessStopRejectedError);
  expect(String(failure)).toContain("Cannot stop Agent scope");
});

it("checks the unit, slice and actual process UID before stopping and requires an empty cgroup afterward", async () => {
  let pids = [4101, 4102],
    stops = 0;
  const manager = new LinuxProcessManager(
    { alice: 1001, bob: 1002 },
    async (args) => {
      if (args[0] === "show") return ok(report());
      if (args[0] === "stop") {
        stops++;
        pids = [];
        return ok();
      }
      return ok();
    },
    () => pids,
    () => 1001,
  );
  await expect(manager.stop("bob", unit)).rejects.toThrow("scope");
  expect(stops).toBe(0);
  await expect(manager.stop("alice", unit)).resolves.toEqual({ unit, stopped: true });
  expect(stops).toBe(1);
});

it("does not stop a scope containing a different UID or misleading unit metadata", async () => {
  let stopped = false;
  const runner = async (args: string[]) => {
    if (args[0] === "stop") stopped = true;
    return ok(report());
  };
  const foreign = new LinuxProcessManager(
    { alice: 1001 },
    runner,
    () => [4101, 4102],
    (pid) => (pid === 4101 ? 1001 : 0),
  );
  await expect(foreign.stop("alice", unit)).rejects.toThrow("UID");
  expect(stopped).toBe(false);
  const wrongGroup = new LinuxProcessManager(
    { alice: 1001 },
    async () =>
      ok(
        `Id=${unit}\nActiveState=active\nSlice=system.slice\nControlGroup=/system.slice/${unit}\n`,
      ),
    () => [4101],
    () => 1001,
  );
  await expect(wrongGroup.stop("alice", unit)).rejects.toThrow("slice");
});

it("requires a bounded Agent slice before ordinary work is admitted", async () => {
  const quota = (memory: string, tasks: string, cpu: string) =>
    ok(`LoadState=loaded\nMemoryMax=${memory}\nTasksMax=${tasks}\nCPUQuotaPerSecUSec=${cpu}\n`);
  await expect(
    new LinuxProcessManager({ alice: 1001 }, async () =>
      quota("1073741824", "128", "1s"),
    ).verifyQuota("alice"),
  ).resolves.toBeUndefined();
  await expect(
    new LinuxProcessManager({ alice: 1001 }, async () =>
      quota("infinity", "128", "1s"),
    ).verifyQuota("alice"),
  ).rejects.toThrow("quota");
  await expect(
    new LinuxProcessManager({ alice: 1001 }, async () =>
      quota("1073741824", "infinity", "1s"),
    ).verifyQuota("alice"),
  ).rejects.toThrow("quota");
  await expect(
    new LinuxProcessManager({ alice: 1001 }, async () =>
      quota("1073741824", "128", "infinity"),
    ).verifyQuota("alice"),
  ).rejects.toThrow("quota");
});

it("does not report a successful stop while descendants remain in the cgroup", async () => {
  const manager = new LinuxProcessManager(
    { alice: 1001 },
    async (args) => (args[0] === "show" ? ok(report()) : ok()),
    () => [4101],
    () => 1001,
  );
  const failure = await manager.stop("alice", unit).catch((error: unknown) => error);
  expect(failure).not.toBeInstanceOf(ProcessStopRejectedError);
  expect(String(failure)).toContain("left processes");
});

it("answers another Agent while a slow systemctl wait is still in flight", async () => {
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let slowSettled = false,
    slowStarted = false,
    stopIssued = false;
  const alice = new LinuxProcessManager(
    { alice: 1001 },
    async (args) => {
      if (args[0] === "show") {
        slowStarted = true;
        await blocked;
        return ok(report());
      }
      stopIssued = true;
      return ok();
    },
    () => (stopIssued ? [] : [4101]),
    () => 1001,
  );
  const bob = new LinuxProcessManager(
    { bob: 1002 },
    async (args) =>
      args[0] === "list-units"
        ? ok(`mate-agent-1002-123e4567-e89b-42d3-a456-426614174000.scope loaded active running B\n`)
        : ok(
            `Id=mate-agent-1002-123e4567-e89b-42d3-a456-426614174000.scope\nActiveState=active\nSlice=mate-agent-1002.slice\nControlGroup=/mate-agent-1002.slice/mate-agent-1002-123e4567-e89b-42d3-a456-426614174000.scope\n`,
          ),
    () => [4202],
    () => 1002,
  );
  const stopping = alice.stop("alice", unit).then((value) => {
    slowSettled = true;
    return value;
  });
  await vi.waitFor(() => expect(slowStarted).toBe(true));
  await expect(within(bob.list("bob"))).resolves.toEqual([
    { unit: "mate-agent-1002-123e4567-e89b-42d3-a456-426614174000.scope", pids: [4202] },
  ]);
  expect(slowSettled).toBe(false);
  release();
  await expect(within(stopping)).resolves.toEqual({ unit, stopped: true });
});

it("refuses a stop cancelled before systemctl stop is invoked", async () => {
  const controller = new AbortController();
  const stop = vi.fn(async () => ok());
  const manager = new LinuxProcessManager(
    { alice: 1001 },
    async (args, wait) => {
      if (args[0] === "show") {
        controller.abort();
        wait?.signal?.throwIfAborted();
        return ok(report());
      }
      return stop();
    },
    () => [4101],
    () => 1001,
  );
  await expect(manager.stop("alice", unit, controller.signal)).rejects.toBeInstanceOf(
    ProcessStopRejectedError,
  );
  expect(stop).not.toHaveBeenCalled();
  const expired = new LinuxProcessManager(
    { alice: 1001 },
    async (args) => {
      if (args[0] === "show") throw new ProcessWaitInterruptedError("systemctl show timed out");
      return ok();
    },
    () => [4101],
    () => 1001,
  );
  const beforeBoundary = await expired.stop("alice", unit).catch((error: unknown) => error);
  expect(beforeBoundary).toBeInstanceOf(ProcessStopRejectedError);
  expect(String(beforeBoundary)).toContain("timed out");
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const never = vi.fn(async () => ok());
  const unused = new LinuxProcessManager({ alice: 1001 }, never);
  await expect(unused.stop("alice", unit, alreadyAborted.signal)).rejects.toBeInstanceOf(
    ProcessStopRejectedError,
  );
  expect(never).not.toHaveBeenCalled();
});

it("reports a stop cancelled after the stop request as an interrupted wait, not a refusal", async () => {
  const controller = new AbortController();
  let stopIssued = false;
  const manager = new LinuxProcessManager(
    { alice: 1001 },
    async (args, wait) => {
      if (args[0] === "show") return ok(report());
      stopIssued = true;
      return new Promise((_resolve, reject) => {
        wait?.signal?.addEventListener(
          "abort",
          () => reject(new ProcessWaitInterruptedError("systemctl stop cancelled")),
          { once: true },
        );
      });
    },
    () => [4101],
    () => 1001,
  );
  const stopping = manager.stop("alice", unit, controller.signal);
  await vi.waitFor(() => expect(stopIssued).toBe(true));
  controller.abort();
  const failure = await within(stopping).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ProcessWaitInterruptedError);
  expect(failure).not.toBeInstanceOf(ProcessStopRejectedError);
});

it("kills the real systemctl wait when it is cancelled or exceeds its timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "mate-systemctl-wait-")),
    marker = join(root, "finished");
  try {
    const runner = createSystemctlRunner("/bin/sh");
    await expect(runner(["-c", "printf ready"])).resolves.toEqual({
      code: 0,
      stdout: "ready",
      stderr: "",
      truncated: false,
    });
    await expect(runner(["-c", "exit 3"])).resolves.toMatchObject({ code: 3 });
    const controller = new AbortController();
    const cancelled = runner(["-c", `sleep 0.2; touch ${marker}`], {
      signal: controller.signal,
      timeoutMs: 5000,
    });
    setTimeout(() => controller.abort(), 20);
    const cancelStarted = Date.now();
    await expect(cancelled).rejects.toBeInstanceOf(ProcessWaitInterruptedError);
    expect(Date.now() - cancelStarted).toBeLessThan(2000);
    const timedOut = await runner(["-c", `sleep 0.2; touch ${marker}`], {
      timeoutMs: 20,
    }).catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(ProcessWaitInterruptedError);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("refuses to parse systemctl output that exceeded the capture limit", async () => {
  const runner = createSystemctlRunner("/bin/sh");
  const long = await runner(["-c", "head -c 200000 /dev/zero | tr '\\000' x"]);
  expect(long.truncated).toBe(true);
  expect(long.code).toBe(0);
  expect(long.stdout).toHaveLength(65536);
  const manager = new LinuxProcessManager({ alice: 1001 }, async () => ({
    code: 0,
    stdout: `${unit} loaded active running Agent\n`,
    stderr: "",
    truncated: true,
  }));
  await expect(manager.list("alice")).rejects.toThrow("exceeded the limit");
  const quota = new LinuxProcessManager({ alice: 1001 }, async () => ({
    code: 0,
    stdout: "LoadState=loaded\nMemoryMax=1073741824\nTasksMax=128\nCPUQuotaPerSecUSec=1s\n",
    stderr: "",
    truncated: true,
  }));
  await expect(quota.verifyQuota("alice")).rejects.toThrow("exceeded the limit");
});
