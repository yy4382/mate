import { systemErrorCode } from "../system-error.js";
import { readFileSync } from "node:fs";

/**
 * Kill a command's process group; never throws, because the caller is already unwinding.
 *
 * A process group is the only handle an ordinary account has on work it started. A descendant that
 * leaves the group, or that this account may not signal — most often a `sudo`-derived root
 * descendant — is outside what Mate can end, and no caller may report it as stopped.
 */
export function killProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* Already exited. */
  }
}

/**
 * What `/proc/<pid>/stat` says about one process: its state letter and its start time in clock
 * ticks. `/proc/<pid>/stat` is `pid (comm) state ppid pgrp session ... itrealvalue starttime ...`;
 * the command name is parenthesised and may contain spaces, so fields are counted from its close.
 * A host without `/proc` returns nothing, and callers then rely on liveness alone.
 */
function procStat(pid: number): { state: string; startToken: string | undefined } | undefined {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  const closing = text.lastIndexOf(")");
  if (closing < 0) return undefined;
  const fields = text.slice(closing + 2).split(" ");
  const startToken = fields[19];
  return {
    state: fields[0] ?? "",
    startToken: startToken !== undefined && /^\d+$/.test(startToken) ? startToken : undefined,
  };
}

/**
 * One process incarnation, as Linux reports it. A recycled process ID always has a different start
 * time, so it can never look like the process it replaced.
 */
export function processStartToken(pid: number): string | undefined {
  return procStat(pid)?.startToken;
}

/**
 * Whether this PID is a live process of the incarnation the caller started.
 *
 * On Linux a zombie is not running: the process has exited and only its unreaped exit status keeps
 * the PID allocated. Without this check a service started by a wrapper that outlives it — a shell,
 * `su`, or any other long-lived parent — would look alive forever after it stopped, and Mate would
 * report a dead service as running and refuse to restart it.
 */
export function processIsRunning(pid: number, startToken: string | undefined): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  const stat = procStat(pid);
  if (stat) {
    if (stat.state === "Z" || stat.state === "X" || stat.state === "x") return false;
    // A recorded token that no longer matches means the PID was recycled and is not ours; a missing
    // recorded token means the caller could not read one, so liveness is all the evidence there is.
    if (startToken !== undefined && stat.startToken !== undefined && stat.startToken !== startToken)
      return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return systemErrorCode(error) === "EPERM";
  }
}
