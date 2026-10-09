import { systemErrorCode } from "../system-error.js";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { killProcessGroup, processStartToken } from "./linux-processes.js";

/** Captured bytes per stream for one ordinary command; anything beyond it is reported as cut. */
export const ordinaryCommandOutputLimitBytes = 65_536;

/** Grace after the shell exits, so output a fast command already wrote still arrives. */
const outputGraceMs = 25;

/** How long a stop waits for a killed process group to disappear before calling it unconfirmed. */
const stopConfirmationTimeoutMs = 500;
const stopConfirmationIntervalMs = 10;

export interface OrdinaryCommandRequest {
  operationId: string;
  agentId: string;
  /** The command exactly as the Agent wrote it. Mate adds nothing to it. */
  command: string;
  /** Absolute directory the command runs in. */
  cwd: string;
  /** HOME for the command: the Agent's own default workspace. */
  home: string;
  /** The running account's name, reported to the command as USER and LOGNAME. */
  username: string;
  timeoutMs: number;
}

/**
 * What one ordinary command really did. Every field is evidence, not an interpretation: `code` and
 * `signal` come from the shell process, `truncated` says the captured output is not the command's
 * complete output, `timedOut` says Mate ended the command at its own time bound, and
 * `processGroupRunning` says something still lives in the command's process group — which is
 * exactly the part Mate can see and, for the same account, still signal. A timed-out command whose
 * process group is still running is one Mate could not fully stop, not one it stopped. A descendant
 * that leaves that process group, or that this account may not signal, is outside everything these
 * fields describe: Mate reports no fate for it at all.
 */
export interface OrdinaryCommandReceipt {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  processGroupRunning: boolean;
  cwd: string;
  startedAt: number;
  durationMs: number;
}

export interface TrackedOrdinaryCommand {
  operationId: string;
  agentId: string;
  pid: number;
  startedAt: number;
  /** The command's own shell already exited; only its process group is still there. */
  exited: boolean;
}

interface TrackedProcess extends TrackedOrdinaryCommand {
  /** Identifies this process incarnation where the host can tell them apart (Linux). */
  startToken: string | undefined;
}
export type OrdinaryCommandPresence =
  | { state: "running" | "descendants_running"; pid: number }
  | { state: "not_tracked"; pid?: undefined };
export type OrdinaryCommandStop =
  | { state: "stopped"; operationId: string }
  | { state: "not_tracked" }
  | { state: "unconfirmed"; operationId: string; pid: number };

/** The command's shell never started, so nothing ran and the failure is definite. */
export class OrdinaryCommandNotStartedError extends Error {
  constructor(cause: unknown) {
    super(
      `The ordinary command could not be started: ${cause instanceof Error ? cause.message : "unknown error"}`,
    );
    this.name = "OrdinaryCommandNotStartedError";
  }
}

/**
 * Runs the command verbatim through a shell under the existing account (ADR-0004). Tracks the
 * process groups it starts for process tools and Agent stop; that memory ends with this node run.
 */
export class OrdinaryCommandRunner {
  private readonly tracked = new Map<string, TrackedProcess>();
  private readonly outputLimitBytes: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly processGroupAlive: (pid: number) => boolean;
  private readonly processStartToken: (pid: number) => string | undefined;

  constructor(
    options: {
      outputLimitBytes?: number;
      environment?: NodeJS.ProcessEnv;
      now?: () => number;
      /** How Mate decides a group is still there; substituted only to test the unconfirmed case. */
      processGroupAlive?: (pid: number) => boolean;
      /** How Mate tells one process incarnation from another; substituted only by tests. */
      processStartToken?: (pid: number) => string | undefined;
    } = {},
  ) {
    this.outputLimitBytes = options.outputLimitBytes ?? ordinaryCommandOutputLimitBytes;
    if (!Number.isSafeInteger(this.outputLimitBytes) || this.outputLimitBytes < 1)
      throw new Error("Ordinary command output limit must be a positive integer");
    this.environment = options.environment ?? process.env;
    this.now = options.now ?? Date.now;
    this.processGroupAlive = options.processGroupAlive ?? processGroupExists;
    this.processStartToken = options.processStartToken ?? processStartToken;
  }

  async run(request: OrdinaryCommandRequest): Promise<OrdinaryCommandReceipt> {
    const startedAt = this.now();
    const key = trackedKey(request.agentId, request.operationId);
    let shell: ChildProcess;
    try {
      shell = spawn("/bin/sh", ["-c", request.command], {
        cwd: request.cwd,
        env: commandEnvironment(request, this.environment),
        // Its own session and process group, so Mate can end the command and its descendants
        // without touching the node's own process group.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw new OrdinaryCommandNotStartedError(error);
    }
    const pid = shell.pid;
    let timedOut = false;
    let exited = false;
    let spawned = false;
    let hardStop: ReturnType<typeof setTimeout> | undefined;
    let releaseHardStop: (() => void) | undefined;
    // The listeners exist before any await, so a failed start is always this call's definite
    // result instead of an unhandled child-process error.
    const outcome = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveOutcome) => {
        // A shell that cannot start emits only 'error'; that is a definite not-started result.
        shell.once("error", () => resolveOutcome({ code: null, signal: null }));
        shell.once("exit", (code, signal) => {
          exited = true;
          resolveOutcome({ code, signal });
        });
        shell.once("spawn", () => {
          spawned = true;
        });
      },
    );
    if (pid === undefined) {
      await outcome;
      throw new OrdinaryCommandNotStartedError(
        new Error(`the shell process could not start in ${request.cwd}`),
      );
    }
    const tracked: TrackedProcess = {
      operationId: request.operationId,
      agentId: request.agentId,
      pid,
      startedAt,
      exited: false,
      startToken: this.processStartToken(pid),
    };
    this.tracked.set(key, tracked);
    // A process-group ID can only be reused once its group is gone. If this ID was still tracked
    // for another operation, that entry is stale, and keeping it would let a later stop signal
    // this brand-new command by mistake.
    for (const [otherKey, other] of this.tracked)
      if (other.pid === pid && otherKey !== key) this.tracked.delete(otherKey);
    const stdout = new BoundedOutput(this.outputLimitBytes);
    const stderr = new BoundedOutput(this.outputLimitBytes);
    shell.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    shell.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    const timer = setTimeout(() => {
      // A command that already exited ended on its own; the deadline is then just a late timer,
      // and reporting a timeout would turn its own result into a command Mate never ended.
      if (exited) return;
      timedOut = true;
      killProcessGroup(pid);
      // A signal that could not be delivered must still end the tool call; the process group
      // report below says whether anything survived it.
      hardStop = setTimeout(() => releaseHardStop?.(), stopConfirmationTimeoutMs);
    }, request.timeoutMs);
    const { code, signal } = await Promise.race([
      outcome,
      new Promise<{ code: null; signal: null }>((resolveHardStop) => {
        releaseHardStop = () => resolveHardStop({ code: null, signal: null });
      }),
    ]);
    clearTimeout(timer);
    if (hardStop) clearTimeout(hardStop);
    if (!spawned) {
      this.tracked.delete(key);
      throw new OrdinaryCommandNotStartedError(
        new Error(`the shell process could not start in ${request.cwd}`),
      );
    }
    // Give output a command already wrote a moment to arrive, then stop waiting for pipes a
    // background descendant may hold open: the command's own shell has exited.
    await new Promise((resolveGrace) => setTimeout(resolveGrace, outputGraceMs));
    const pipesOpen = !shell.stdout?.readableEnded || !shell.stderr?.readableEnded;
    if (pipesOpen) {
      shell.stdout?.destroy();
      shell.stderr?.destroy();
    }
    tracked.exited = true;
    const processGroupRunning = this.processGroupAlive(pid);
    if (!processGroupRunning) this.tracked.delete(key);
    return {
      code,
      signal,
      stdout: stdout.text(),
      stderr: stderr.text(),
      // A descendant that still holds the output pipes may add output Mate never captured, so a
      // result with open pipes is not a complete one either.
      truncated: stdout.truncated || stderr.truncated || pipesOpen,
      timedOut,
      processGroupRunning,
      cwd: request.cwd,
      startedAt,
      durationMs: this.now() - startedAt,
    };
  }

  list(agentId: string): TrackedOrdinaryCommand[] {
    const entries: TrackedOrdinaryCommand[] = [];
    for (const command of [...this.tracked.values()])
      if (command.agentId === agentId && this.live(command)) entries.push({ ...command });
    return entries.sort((left, right) => left.startedAt - right.startedAt);
  }

  /** The tracked entry for one operation, so callers can report its presence and process ID. */
  presence(agentId: string, operationId: string): OrdinaryCommandPresence {
    const command = this.live(this.tracked.get(trackedKey(agentId, operationId)));
    if (!command) return { state: "not_tracked" };
    return { state: command.exited ? "descendants_running" : "running", pid: command.pid };
  }

  /** Best-effort termination of one tracked process group; never claims more than it confirmed. */
  async stop(agentId: string, operationId: string): Promise<OrdinaryCommandStop> {
    const command = this.live(this.tracked.get(trackedKey(agentId, operationId)));
    if (!command) return { state: "not_tracked" };
    killProcessGroup(command.pid);
    return (await this.confirmGone(command.pid))
      ? { state: "stopped", operationId }
      : { state: "unconfirmed", operationId, pid: command.pid };
  }

  async stopAll(agentId: string): Promise<{ stopped: string[]; unconfirmed: string[] }> {
    const stopped: string[] = [];
    const unconfirmed: string[] = [];
    for (const entry of this.list(agentId)) {
      const result = await this.stop(agentId, entry.operationId);
      if (result.state === "stopped") stopped.push(entry.operationId);
      else if (result.state === "unconfirmed") unconfirmed.push(entry.operationId);
    }
    return { stopped, unconfirmed };
  }

  /**
   * The one place that decides whether Mate still owns a tracked process group, and it is the only
   * way anything here reaches a process ID. An entry is forgotten when its group is gone, and also
   * when the host says that ID now belongs to a different process incarnation: a group ID can only
   * be reused after its group ended, and signalling the new owner would kill a stranger.
   */
  private live(command: TrackedProcess | undefined): TrackedProcess | undefined {
    if (!command) return undefined;
    const forget = () => {
      this.tracked.delete(trackedKey(command.agentId, command.operationId));
      return undefined;
    };
    if (command.startToken !== undefined) {
      const current = this.processStartToken(command.pid);
      if (current !== undefined && current !== command.startToken) return forget();
    }
    if (!this.processGroupAlive(command.pid)) return forget();
    return command;
  }

  private async confirmGone(pid: number): Promise<boolean> {
    const deadline = this.now() + stopConfirmationTimeoutMs;
    while (this.processGroupAlive(pid)) {
      if (this.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, stopConfirmationIntervalMs));
    }
    return true;
  }
}

/**
 * Whether any process in this command's group can still run.
 *
 * `kill(-pid, 0)` succeeds whenever the group exists at all, and a group exists while its leader's
 * exit status is unreaped — the normal state on a Linux host whose init does not reap orphans. So
 * the signal probe is only the first half of the answer, and on Linux `/proc` supplies the rest: a
 * group whose every member is a zombie has finished, and nothing in it is running any more. EPERM
 * from the probe means a member exists that this account may not signal, which counts as running.
 */
function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    return systemErrorCode(error) !== "ESRCH";
  }
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    // No `/proc`, so this host cannot tell a finished process from a running one. The conservative
    // answer is "still there": a caller may only ever claim a stop it observed.
    return true;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const member = procGroupMember(Number(name));
    // Only this group's members count: a live process elsewhere on the host says nothing about
    // whether the command Mate started has finished.
    if (member === undefined || member.group !== pid) continue;
    if (member.state !== "Z" && member.state !== "X" && member.state !== "x") return true;
  }
  return false;
}

/** The group and state of one `/proc` entry, counting fields from the parenthesised command name. */
function procGroupMember(pid: number): { group: number; state: string } | undefined {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  const closing = stat.lastIndexOf(")");
  if (closing < 0) return undefined;
  const fields = stat.slice(closing + 2).split(" ");
  const group = Number(fields[2]);
  return fields[0] && Number.isSafeInteger(group) ? { group, state: fields[0] } : undefined;
}

function trackedKey(agentId: string, operationId: string): string {
  return `${agentId}\0${operationId}`;
}

/**
 * Inherit the existing account's environment, including MATE_* variables (ADR-0004), and point
 * HOME, USER, LOGNAME and PWD at the Agent's workspace and account identity.
 */
function commandEnvironment(
  request: OrdinaryCommandRequest,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    HOME: request.home,
    USER: request.username,
    LOGNAME: request.username,
    PWD: request.cwd,
  };
}

/** Keeps a captured stream inside its byte limit and remembers that it cut something. */
class BoundedOutput {
  private readonly parts: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    const room = this.limit - this.size;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    const part = chunk.subarray(0, room);
    this.parts.push(part);
    this.size += part.length;
    if (part.length < chunk.length) this.truncated = true;
  }

  text(): string {
    return Buffer.concat(this.parts).toString("utf8");
  }
}
