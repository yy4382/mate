import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { within } from "./paths.js";

export interface ProcessScope {
  unit: string;
  pids: number[];
}
/** A stop was refused before systemctl stop was invoked, so no effect is uncertain. */
export class ProcessStopRejectedError extends Error {}
export class ProcessNotRunningError extends ProcessStopRejectedError {}
export type SystemctlRunner = (args: string[]) => { code: number; stdout: string; stderr: string };
const systemctl: SystemctlRunner = (args) => {
  const result = spawnSync("/usr/bin/systemctl", args, {
    encoding: "utf8",
    timeout: 10000,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    maxBuffer: 65536,
  });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
function cgroupPids(group: string): number[] {
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
function pidUid(pid: number): number | undefined {
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
  verifyQuota(agentId: string): void {
    const slice = `mate-agent-${this.uid(agentId)}.slice`,
      result = this.run([
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
      ]);
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
    return new RegExp(
      `^mate-agent-${uid}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.scope$`,
    );
  }
  private show(uid: number, unit: string): { group: string; pids: number[]; active: boolean } {
    if (!this.unitPattern(uid).test(unit)) throw new Error("Agent scope identity mismatch");
    const result = this.run([
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
    ]);
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
    if (fields.Id !== unit || fields.Slice !== `mate-agent-${uid}.slice`)
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
  list(agentId: string): ProcessScope[] {
    const uid = this.uid(agentId),
      result = this.run([
        "list-units",
        "--type=scope",
        "--state=active",
        "--all",
        "--plain",
        "--no-legend",
        "--no-pager",
        "--full",
        `mate-agent-${uid}-*.scope`,
      ]);
    if (result.code !== 0)
      throw new Error(`Cannot list Agent processes: ${result.stderr.slice(0, 200)}`);
    const units = result.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0] ?? "")
      .filter((unit) => this.unitPattern(uid).test(unit));
    const scopes: ProcessScope[] = [];
    for (const unit of units)
      try {
        const state = this.show(uid, unit);
        if (state.active) scopes.push({ unit, pids: state.pids });
      } catch (error) {
        if (!(error instanceof ProcessNotRunningError)) throw error;
      }
    return scopes;
  }
  stop(agentId: string, unit: string): { unit: string; stopped: true } {
    let before: { group: string; pids: number[]; active: boolean };
    try {
      before = this.show(this.uid(agentId), unit);
      if (!before.active) throw new ProcessNotRunningError("Agent scope is not running");
    } catch (error) {
      if (error instanceof ProcessStopRejectedError) throw error;
      throw new ProcessStopRejectedError(String(error));
    }
    const result = this.run(["stop", "--", unit]);
    if (result.code !== 0)
      throw new Error(`Cannot stop Agent scope: ${result.stderr.slice(0, 200)}`);
    if (this.readPids(before.group).length)
      throw new Error("Agent scope stop left processes running");
    return { unit, stopped: true };
  }
}
