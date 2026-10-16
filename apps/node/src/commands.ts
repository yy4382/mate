import { spawn } from "node:child_process";
import type { Clock } from "@mate/clock";
import type { ToolResult } from "@mate/node-protocol";
import { ProcessGroup } from "./process-group.ts";

/** Bytes of output a result keeps: the tail, as Durable's own `bash` tool keeps it. */
const KEPT_OUTPUT_BYTES = 50 * 1024;
/** Bytes streamed to the gateway per call; past this only the result's tail is sent, so `yes` cannot flood the link. */
const STREAMED_OUTPUT_BYTES = 1024 * 1024;
/** How long a command whose shell exited may keep the output open or its group running before the node returns. */
const EXIT_GRACE_MS = 1000;
const POLL_MS = 20;

export type CommandRequest = {
  agentId: string;
  /** Passed to `/bin/sh -c` exactly as the Agent wrote it. */
  command: string;
  /** The Agent's workspace: the working directory and HOME. */
  workspace: string;
  timeoutSeconds: number | undefined;
};

/** How a command ended, as the shell process reports it, or why it never ran. */
type Ending =
  | { kind: "exited"; code: number }
  | { kind: "signaled"; signal: string }
  | { kind: "timed-out" }
  | { kind: "stopped" }
  | { kind: "not-started"; reason: string };

type Execution = { ending: Ending; pipesHeld: boolean; backgroundRunning: boolean };

/**
 * Runs commands in process groups of their own and remembers every group it started until the group has finished,
 * including groups whose shell already returned but which still run background processes. A group is the node's only
 * handle on what a command started; a process that leaves it (for example with `setsid`) is the Agent's own.
 */
export class Commands {
  readonly #clock: Clock;
  readonly #groups = new Set<ProcessGroup>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** Run one command until it ends, is timed out, or `signal` stops it, streaming output as it arrives. */
  async run(
    request: CommandRequest,
    onOutput: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const output = new Output(onOutput);
    const { ending, pipesHeld, backgroundRunning } = await this.#execute(
      request,
      output,
      signal,
    ).catch((error: unknown): Execution => {
      // Spawning itself throws for a command the OS cannot take at all, such as one with a NUL byte.
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ending: { kind: "not-started", reason },
        pipesHeld: false,
        backgroundRunning: false,
      };
    });
    return render(ending, output, pipesHeld, backgroundRunning, request.timeoutSeconds);
  }

  /** Kill every group this node started that may still run anything. For the node's own shutdown. */
  killAll(): void {
    for (const group of this.#groups) group.kill();
    this.#groups.clear();
  }

  async #execute(request: CommandRequest, output: Output, signal: AbortSignal): Promise<Execution> {
    const shell = spawn("/bin/sh", ["-c", request.command], {
      cwd: request.workspace,
      env: { ...process.env, HOME: request.workspace, PWD: request.workspace },
      // A session and process group of its own, so stopping the command reaches its descendants and never the node.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exit = new Promise<Ending>((resolve) => {
      shell.once("error", (error) => resolve({ kind: "not-started", reason: error.message }));
      shell.once("exit", (code, exitSignal) =>
        resolve(
          exitSignal === null
            ? { kind: "exited", code: code ?? 0 }
            : { kind: "signaled", signal: exitSignal },
        ),
      );
    });
    let open = 2;
    for (const stream of [shell.stdout, shell.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => output.push(chunk));
      stream.once("close", () => open--);
    }
    if (shell.pid === undefined) {
      return { ending: await exit, pipesHeld: false, backgroundRunning: false };
    }
    const group = new ProcessGroup(shell.pid);
    this.#groups.add(group);

    // Whichever comes first: the shell exits, the timeout passes, or the caller stops the call.
    let interruption: "timed-out" | "stopped" | undefined;
    const interrupted = new AbortController();
    const settled = new AbortController();
    const interrupt = (why: "timed-out" | "stopped") => {
      interruption ??= why;
      interrupted.abort();
    };
    const onStop = () => interrupt("stopped");
    if (signal.aborted) onStop();
    signal.addEventListener("abort", onStop, { once: true });
    if (request.timeoutSeconds !== undefined) {
      const waiting = AbortSignal.any([settled.signal, interrupted.signal]);
      void this.#clock.sleep(request.timeoutSeconds * 1000, waiting).then(() => {
        if (!waiting.aborted) interrupt("timed-out");
      });
    }
    const exited = await Promise.race([
      exit,
      this.#clock.sleep(undefined, interrupted.signal).then(() => undefined),
    ]);
    settled.abort();
    signal.removeEventListener("abort", onStop);
    let ending: Ending;
    if (exited === undefined || interruption !== undefined) {
      group.kill();
      await exit;
      ending = { kind: interruption ?? "stopped" };
    } else if (exited.kind === "not-started") {
      this.#groups.delete(group);
      return { ending: exited, pipesHeld: false, backgroundRunning: false };
    } else {
      ending = exited;
    }

    // The shell has exited. Output it already wrote may still be in flight, and a background process may hold the
    // pipes or keep running: wait briefly for both, then return rather than wait on the background.
    // A killed group only needs its pipes drained; a stop must not cut that short.
    const killed = ending.kind === "timed-out" || ending.kind === "stopped";
    const waitSignal = killed ? new AbortController().signal : signal;
    const deadline = this.#clock.now() + EXIT_GRACE_MS;
    while ((open > 0 || group.running()) && this.#clock.now() < deadline && !waitSignal.aborted) {
      await this.#clock.sleep(POLL_MS, waitSignal);
    }
    // A stop that arrives while waiting ends the background of a command that itself already finished.
    if (signal.aborted) group.kill();
    const pipesHeld = open > 0;
    shell.stdout.destroy();
    shell.stderr.destroy();
    const backgroundRunning = group.running();
    if (!backgroundRunning) this.#groups.delete(group);
    return { ending, pipesHeld, backgroundRunning };
  }
}

/** The tail of a command's combined output, and whether anything before it was dropped. */
class Output {
  readonly #onOutput: (chunk: string) => void;
  #text = "";
  #dropped = 0;
  #streamed = 0;

  constructor(onOutput: (chunk: string) => void) {
    this.#onOutput = onOutput;
  }

  push(chunk: string): void {
    if (this.#streamed < STREAMED_OUTPUT_BYTES) {
      this.#streamed += Buffer.byteLength(chunk);
      this.#onOutput(chunk);
    }
    this.#text += chunk;
    const excess = Buffer.byteLength(this.#text) - KEPT_OUTPUT_BYTES;
    if (excess > 0) {
      const kept = Buffer.from(this.#text).subarray(excess).toString("utf8");
      this.#dropped += excess;
      this.#text = kept;
    }
  }

  get text(): string {
    return this.#text;
  }

  get droppedBytes(): number {
    return this.#dropped;
  }
}

function render(
  ending: Ending,
  output: Output,
  pipesHeld: boolean,
  backgroundRunning: boolean,
  timeoutSeconds: number | undefined,
): ToolResult {
  const remarks: string[] = [];
  if (output.droppedBytes > 0) {
    remarks.push(
      `[Output truncated: the first ${output.droppedBytes} bytes were dropped; the last ${KEPT_OUTPUT_BYTES} bytes are kept]`,
    );
  }
  if (pipesHeld) {
    remarks.push(
      "[Output may be incomplete: a background process still holds the output after the command exited]",
    );
  }
  if (backgroundRunning) {
    remarks.push("[Background processes started by this command are still running]");
  }
  const outcome = describe(ending, timeoutSeconds);
  if (outcome !== undefined) remarks.push(outcome);
  const text = [output.text, ...remarks].filter((part) => part !== "").join("\n");
  return {
    content: [{ type: "text", text: text === "" ? "(no output)" : text }],
    isError: !(ending.kind === "exited" && ending.code === 0),
  };
}

function describe(ending: Ending, timeoutSeconds: number | undefined): string | undefined {
  switch (ending.kind) {
    case "exited":
      return ending.code === 0 ? undefined : `Command exited with code ${ending.code}`;
    case "signaled":
      return `Command was killed by signal ${ending.signal}`;
    case "timed-out":
      return `Command timed out after ${timeoutSeconds} seconds and was killed`;
    case "stopped":
      return "Command was stopped: the Agent was stopped or the connection to the node dropped";
    case "not-started":
      return `Command could not start: ${ending.reason}`;
  }
}
