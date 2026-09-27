import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { within } from "./paths.js";

/** A systemctl wait was cancelled or timed out; an effect that already started may be unknown. */
export class ProcessWaitInterruptedError extends Error {}
export interface SystemctlResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Output was longer than the capture limit; the caller must not parse it as complete. */
  truncated?: boolean;
}
export interface SystemctlWait {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}
export type SystemctlRunner = (args: string[], wait?: SystemctlWait) => Promise<SystemctlResult>;

const systemctlTimeoutMs = 10000;
const outputLimit = 65536;

/**
 * Awaits systemctl instead of blocking on it, so one slow host operation cannot stall other
 * Agents. Cancelling the wait kills the systemctl client; whether its request reached systemd
 * is then the caller's unknown result, not a silent timeout.
 */
export function createSystemctlRunner(program = "/usr/bin/systemctl"): SystemctlRunner {
  return (args, wait = {}) => {
    const { signal, timeoutMs = systemctlTimeoutMs } = wait;
    if (signal?.aborted)
      return Promise.reject(new ProcessWaitInterruptedError(`systemctl ${args[0]} cancelled`));
    return new Promise((resolvePromise, reject) => {
      const child = spawn(program, args, {
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "",
        truncated = false,
        interrupted: string | undefined,
        settled = false;
      const collect = (text: string, chunk: Buffer) => {
        const room = outputLimit - text.length;
        if (room <= 0) {
          truncated = true;
          return text;
        }
        if (room < chunk.length) truncated = true;
        return text + chunk.subarray(0, room).toString("utf8");
      };
      child.stdout!.on("data", (chunk: Buffer) => {
        stdout = collect(stdout, chunk);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr = collect(stderr, chunk);
      });
      const interrupt = (reason: string) => {
        if (interrupted || settled) return;
        interrupted = reason;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => interrupt(`systemctl ${args[0]} timed out`), timeoutMs);
      const cancel = () => interrupt(`systemctl ${args[0]} cancelled`);
      signal?.addEventListener("abort", cancel, { once: true });
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      };
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        finish();
        reject(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        finish();
        if (interrupted) reject(new ProcessWaitInterruptedError(interrupted));
        else resolvePromise({ code: code ?? 1, stdout, stderr, truncated });
      });
    });
  };
}
const systemctl: SystemctlRunner = createSystemctlRunner();

/** Kill a command's process group; never throws, because the caller is already unwinding. */
export function killProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* Already exited. */
  }
}

/** Stop one Mate systemd unit as cleanup after a cancelled or timed-out command; bounded. */
export async function stopUnit(unit: string | undefined): Promise<void> {
  if (!unit) return;
  try {
    await systemctl(["stop", "--", unit], { timeoutMs: systemctlTimeoutMs });
  } catch {
    /* The unit may already be gone; the command's own result stays unknown either way. */
  }
}

export function cgroupPids(group: string): number[] {
  if (!group.startsWith("/") || group.split("/").includes(".."))
    throw new Error("Invalid systemd control group");
  const base = "/sys/fs/cgroup",
    root = resolve(base, `.${group}`);
  if (!within(base, root)) throw new Error("Invalid systemd control group");
  const pids: number[] = [];
  const visit = (path: string, depth: number) => {
    if (depth > 8) throw new Error("Systemd control group nesting exceeds limit");
    let content: string;
    try {
      content = readFileSync(resolve(path, "cgroup.procs"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const text of content.split("\n").filter(Boolean)) {
      const pid = Number(text);
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid cgroup PID");
      pids.push(pid);
    }
    for (const entry of readdirSync(path, { withFileTypes: true }))
      if (entry.isDirectory()) visit(resolve(path, entry.name), depth + 1);
  };
  visit(root, 0);
  return [...new Set(pids)].sort((a, b) => a - b);
}
export function pidUid(pid: number): number | undefined {
  let status: string;
  try {
    status = readFileSync(`/proc/${pid}/status`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const line = status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m);
  if (!line) throw new Error("Cannot verify process UID");
  const uids = line.slice(1).map(Number);
  if (new Set(uids).size !== 1) throw new Error("Process has mixed UIDs");
  return uids[0];
}
