import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import type { Background, CommandProcess } from "./types.ts";

type Process = { pid: number; group: number; state: string; start: string };
type Processes = () => Process[] | undefined;

export class PosixProcessGroup {
  readonly #pgid: number;
  readonly #processes: Processes;
  readonly #leaderStart: string | undefined;

  constructor(pgid: number, processes: Processes) {
    this.#pgid = pgid;
    this.#processes = processes;
    this.#leaderStart = processes()?.find((process) => process.pid === pgid)?.start;
  }

  background(): Background {
    const processes = this.#processes();
    if (!this.#owned(processes)) return "finished";
    if (processes !== undefined) {
      return processes.some(
        (process) => process.group === this.#pgid && !"ZXx".includes(process.state[0] ?? ""),
      )
        ? "running"
        : "finished";
    }
    try {
      process.kill(-this.#pgid, 0);
      return "running";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM" ? "running" : "finished";
    }
  }

  kill(): ReturnType<CommandProcess["kill"]> {
    if (!this.#owned(this.#processes())) return { ok: true };
    try {
      process.kill(-this.#pgid, "SIGKILL");
      return { ok: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return { ok: true };
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  #owned(processes: Process[] | undefined): boolean {
    const leader = processes?.find((process) => process.pid === this.#pgid);
    return (
      leader === undefined || this.#leaderStart === undefined || leader.start === this.#leaderStart
    );
  }
}

export function linuxProcesses(): Process[] | undefined {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return undefined;
  }
  const processes: Process[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const text = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      const [state, , group] = fields;
      const start = fields[19];
      if (state === undefined || group === undefined || start === undefined) continue;
      processes.push({ pid: Number(entry), group: Number(group), state, start });
    } catch {
      // A process can exit while the process table is being read.
    }
  }
  return processes;
}

export function darwinProcesses(): Process[] | undefined {
  let output: string;
  try {
    output = execFileSync("/bin/ps", ["-axo", "pid=,pgid=,stat=,lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
  const processes: Process[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (match === null) continue;
    processes.push({
      pid: Number(match[1]),
      group: Number(match[2]),
      state: match[3]!,
      start: match[4]!,
    });
  }
  return processes;
}
