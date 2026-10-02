import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { processIsRunning, processStartToken } from "../../src/processes/linux-processes.js";

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

it.runIf(linux)(
  "does not call an unreaped zombie a running process (Linux /proc only)",
  async () => {
    // Keep the parent alive and block its event loop so libuv cannot reap the exited child yet.
    // Orphaning a child would race the host's init process, which may reap it before this assertion.
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process");
       const { readSync, writeSync } = require("node:fs");
       const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
       writeSync(1, String(child.pid));
       readSync(0, Buffer.alloc(1), 0, 1, null);`,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    children.push(parent);
    const closed = once(parent, "close");
    try {
      const [output] = await once(parent.stdout!, "data");
      const pid = Number(String(output));
      expect(Number.isSafeInteger(pid)).toBe(true);
      await expect
        .poll(() => readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.charAt(0))
        .toBe("Z");
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(processStartToken(pid)).toBeDefined();
      expect(processIsRunning(pid, undefined)).toBe(false);
      expect(processIsRunning(pid, processStartToken(pid))).toBe(false);
      // A process that really is executing is still reported as running.
      const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      children.push(live);
      expect(processIsRunning(live.pid!, processStartToken(live.pid!))).toBe(true);
    } finally {
      // Unblock the parent's event loop so it reaps its child and exits normally.
      parent.stdin!.end("\n");
      await closed;
    }
  },
);
