import { readdirSync, readFileSync } from "node:fs";

/**
 * One process group a command started, identified so that a recycled ID can never be mistaken for it.
 *
 * The group's ID is its leader's PID. Linux never hands out a PID while a process group of that ID still exists, so
 * while any member is left, signalling `-pgid` reaches exactly this group. Once the group is gone the ID may go to an
 * unrelated process; that process then has a different start time than the leader we recorded, which is how `owned`
 * tells them apart.
 */
export class ProcessGroup {
  readonly pgid: number;
  readonly #leaderStart: string | undefined;

  constructor(pgid: number) {
    this.pgid = pgid;
    this.#leaderStart = procStat(pgid)?.start;
  }

  /** Whether something in the group can still run. A group of only zombies has finished. */
  running(): boolean {
    return this.#owned() && groupHasRunningMember(this.pgid);
  }

  /** SIGKILL every member, unless the ID now belongs to someone else. Never throws. */
  kill(): void {
    if (!this.#owned()) return;
    try {
      process.kill(-this.pgid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }

  #owned(): boolean {
    const now = procStat(this.pgid)?.start;
    return now === undefined || this.#leaderStart === undefined || now === this.#leaderStart;
  }
}

/**
 * `kill(-pgid, 0)` succeeds while the group exists at all, including when every member is a zombie whose parent has
 * not reaped it, the normal state under an init that does not reap orphans. On Linux, `/proc` tells zombies apart.
 * EPERM means a member this account may not signal exists, which counts as running. Without `/proc` (macOS, used
 * only in development) the signal probe is all the evidence there is.
 */
function groupHasRunningMember(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return true;
  }
  return entries.some((name) => {
    if (!/^\d+$/.test(name)) return false;
    const stat = procStat(Number(name));
    return stat !== undefined && stat.group === pgid && !"ZXx".includes(stat.state);
  });
}

/**
 * `/proc/<pid>/stat` is `pid (comm) state ppid pgrp session ... starttime ...`. The command name may contain spaces
 * and parentheses, so fields are counted from the last `)`.
 */
function procStat(pid: number): { state: string; group: number; start: string } | undefined {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  const [state, , group] = fields;
  const start = fields[19];
  if (state === undefined || group === undefined || start === undefined) return undefined;
  return { state, group: Number(group), start };
}
