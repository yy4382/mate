import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { within } from "./paths.js";

/** One systemd slice per Agent Linux UID; the unit name derives from the UID, never from the Agent id. */
export const agentSliceUnit = (uid: number): string => `mate-agent-${uid}.slice`;

export interface ProcessScope {
  unit: string;
  pids: number[];
}
/** A stop was refused before systemctl stop was invoked, so no effect is uncertain. */
export class ProcessStopRejectedError extends Error {}
export class ProcessNotRunningError extends ProcessStopRejectedError {}
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

/** systemd and /proc are the only runtime state sources; Mate keeps no background-job table. */
export class LinuxProcessManager {
  constructor(
    private readonly identities: Readonly<Record<string, number>>,
    private readonly run: SystemctlRunner = systemctl,
    private readonly readPids: (group: string) => number[] = cgroupPids,
    private readonly readUid: (pid: number) => number | undefined = pidUid,
  ) {}
  private uid(agentId: string): number {
    const uid = this.identities[agentId];
    if (!Number.isInteger(uid) || uid! < 1) throw new Error("Unknown Agent Linux user");
    return uid!;
  }
  async verifyQuota(agentId: string, signal?: AbortSignal): Promise<void> {
    const slice = agentSliceUnit(this.uid(agentId)),
      result = await this.run(
        [
          "show",
          slice,
          "-p",
          "LoadState",
          "-p",
          "MemoryMax",
          "-p",
          "TasksMax",
          "-p",
          "CPUQuotaPerSecUSec",
          "--no-pager",
        ],
        { signal },
      );
    if (result.truncated) throw new Error("Agent systemd slice quota output exceeded the limit");
    if (result.code !== 0) throw new Error("Agent systemd slice quota is unavailable");
    const fields = Object.fromEntries(
      result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
    if (
      fields.LoadState !== "loaded" ||
      !Number.isFinite(Number(fields.MemoryMax)) ||
      Number(fields.MemoryMax) < 1 ||
      !Number.isFinite(Number(fields.TasksMax)) ||
      Number(fields.TasksMax) < 1 ||
      !fields.CPUQuotaPerSecUSec ||
      fields.CPUQuotaPerSecUSec === "infinity"
    )
      throw new Error("Agent systemd slice must have finite memory, task and CPU quota");
  }
  private unitPattern(uid: number): RegExp {
    const prefix = agentSliceUnit(uid).replace(/\.slice$/, "");
    return new RegExp(
      `^${prefix}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.scope$`,
    );
  }
  private async show(
    uid: number,
    unit: string,
    signal?: AbortSignal,
  ): Promise<{ group: string; pids: number[]; active: boolean }> {
    if (!this.unitPattern(uid).test(unit)) throw new Error("Agent scope identity mismatch");
    const result = await this.run(
      [
        "show",
        unit,
        "-p",
        "Id",
        "-p",
        "LoadState",
        "-p",
        "ActiveState",
        "-p",
        "Slice",
        "-p",
        "ControlGroup",
        "--no-pager",
      ],
      { signal },
    );
    if (result.truncated) throw new Error("Agent scope state output exceeded the limit");
    if (result.code !== 0) {
      if (/not found|not loaded|could not be found/i.test(result.stderr))
        throw new ProcessNotRunningError("Agent scope is not running");
      throw new Error(`Cannot inspect Agent scope: ${result.stderr.slice(0, 200)}`);
    }
    const fields = Object.fromEntries(
      result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
    if (fields.LoadState === "not-found" || fields.ActiveState === "inactive")
      throw new ProcessNotRunningError("Agent scope is not running");
    if (fields.Id !== unit || fields.Slice !== agentSliceUnit(uid))
      throw new Error("Agent scope slice or identity mismatch");
    const group = fields.ControlGroup ?? "";
    if (!group.startsWith("/") || !group.endsWith(`/${unit}`) || group.split("/").includes(".."))
      throw new Error("Agent scope control group mismatch");
    const pids = this.readPids(group);
    for (const pid of pids) {
      const actual = this.readUid(pid);
      if (actual !== undefined && actual !== uid)
        throw new Error("Agent scope contains a different UID");
    }
    return { group, pids, active: fields.ActiveState === "active" };
  }
  async list(agentId: string, signal?: AbortSignal): Promise<ProcessScope[]> {
    const uid = this.uid(agentId),
      result = await this.run(
        [
          "list-units",
          "--type=scope",
          "--state=active",
          "--all",
          "--plain",
          "--no-legend",
          "--no-pager",
          "--full",
          `${agentSliceUnit(uid).replace(/\.slice$/, "")}-*.scope`,
        ],
        { signal },
      );
    if (result.truncated) throw new Error("Agent process list exceeded the limit");
    if (result.code !== 0)
      throw new Error(`Cannot list Agent processes: ${result.stderr.slice(0, 200)}`);
    const units = result.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0] ?? "")
      .filter((unit) => this.unitPattern(uid).test(unit));
    const scopes: ProcessScope[] = [];
    for (const unit of units)
      try {
        const state = await this.show(uid, unit, signal);
        if (state.active) scopes.push({ unit, pids: state.pids });
      } catch (error) {
        if (!(error instanceof ProcessNotRunningError)) throw error;
      }
    return scopes;
  }
  async stop(
    agentId: string,
    unit: string,
    signal?: AbortSignal,
  ): Promise<{ unit: string; stopped: true }> {
    let before: { group: string; pids: number[]; active: boolean };
    try {
      if (signal?.aborted)
        throw new ProcessStopRejectedError("Stop cancelled before systemctl stop");
      before = await this.show(this.uid(agentId), unit, signal);
      if (!before.active) throw new ProcessNotRunningError("Agent scope is not running");
    } catch (error) {
      if (error instanceof ProcessStopRejectedError) throw error;
      throw new ProcessStopRejectedError(
        error instanceof ProcessWaitInterruptedError
          ? `Stop refused before systemctl stop: ${error.message}`
          : String(error),
      );
    }
    // Past this boundary systemctl stop may have taken effect: any failure leaves an unknown
    // result, and the caller keeps it in the existing operation record instead of retrying.
    const result = await this.run(["stop", "--", unit], { signal });
    if (result.code !== 0)
      throw new Error(`Cannot stop Agent scope: ${result.stderr.slice(0, 200)}`);
    if (this.readPids(before.group).length)
      throw new Error("Agent scope stop left processes running");
    return { unit, stopped: true };
  }

  /** Stop all Mate scopes for this UID, then read systemd again before confirming. */
  async stopAll(agentId: string): Promise<{ stopped: true; units: string[] }> {
    const scopes = await this.list(agentId);
    for (const scope of scopes) {
      try {
        await this.stop(agentId, scope.unit);
      } catch (error) {
        if (!(error instanceof ProcessNotRunningError)) throw error;
      }
    }
    if ((await this.list(agentId)).length > 0) throw new Error("Agent scopes remain after stop");
    return { stopped: true, units: scopes.map((scope) => scope.unit) };
  }
}
