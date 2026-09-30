import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { afterEach, expect, it } from "vitest";
import { processIsRunning, processStartToken } from "../../src/execution/linux-processes.js";

/**
 * These checks start real processes. `/proc` is Linux-only, so the incarnation checks are Linux-only
 * too and every claim here is about what this host can actually observe.
 */
const children: Array<ReturnType<typeof spawn>> = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});
const linux = process.platform === "linux";

it("reports a running process as running and a finished one as gone", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child);
  const pid = child.pid!;
  expect(processIsRunning(pid, processStartToken(pid))).toBe(true);
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGKILL");
  await exited;
  // A killed child this process never waited on may still be a zombie; either way it is not running.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  expect(processIsRunning(pid, processStartToken(pid))).toBe(false);
});

it.runIf(linux)("does not call an unreaped zombie a running process (Linux /proc only)", () => {
  // A shell that starts a child and exits without waiting for it leaves that child a zombie: the
  // PID is still allocated and `kill(pid, 0)` still succeeds, but nothing is running. A service
  // started through a wrapper that outlives it looks exactly like this once it has stopped, so
  // "the PID exists" must never be Mate's test for "the service is up".
  const launched = spawnSync(
    "/bin/sh",
    ["-c", `${process.execPath} -e "process.exit(0)" & echo $!`],
    {
      encoding: "utf8",
    },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const pid = Number(launched.stdout.trim());
  expect(Number.isSafeInteger(pid)).toBe(true);
  const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.charAt(0);
  expect(state).toBe("Z");
  expect(() => process.kill(pid, 0)).not.toThrow();
  expect(processIsRunning(pid, undefined)).toBe(false);
  expect(processIsRunning(pid, processStartToken(pid))).toBe(false);
  // A process that really is executing is still reported as running.
  const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(live);
  expect(processIsRunning(live.pid!, processStartToken(live.pid!))).toBe(true);
});
