import type { Clock } from "@mate/clock";
import { BASH_KEPT_OUTPUT_BYTES, type ToolResult } from "@mate/node-protocol";
import { currentPlatform } from "./platforms/index.ts";
import type { Background, CommandProcess } from "./platforms/types.ts";

/** Bytes streamed to the gateway per call; past this only the result's tail is sent, so `yes` cannot flood the link. */
const STREAMED_OUTPUT_BYTES = 1024 * 1024;
/** How long a command whose shell exited may keep the output open or its group running before the node returns. */
const EXIT_GRACE_MS = 1000;
const POLL_MS = 20;

export type CommandRequest = {
  agentId: string;
  /** Passed to the node's system shell. */
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
  | { kind: "stop-failed"; reason: string }
  | { kind: "not-started"; reason: string };

type Execution = { ending: Ending; pipesHeld: boolean; background: Background };

/** Keeps each platform's handle while it can still identify and stop a command's running processes. */
export class Commands {
  readonly #clock: Clock;
  readonly #groups = new Set<CommandProcess>();

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
    const { ending, pipesHeld, background } = await this.#execute(request, output, signal);
    return render(ending, output, pipesHeld, background, request.timeoutSeconds);
  }

  /** Kill every group this node started that may still run anything. For the node's own shutdown. */
  killAll(): void {
    const failures: string[] = [];
    for (const group of this.#groups) {
      const stopped = group.kill();
      if (stopped.ok) {
        this.#groups.delete(group);
      } else {
        failures.push(stopped.reason);
        group.child.stdout.destroy();
        group.child.stderr.destroy();
        group.child.unref();
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Node shutdown could not stop every command; processes may still be running: ${failures.join("; ")}`,
      );
    }
  }

  async #execute(request: CommandRequest, output: Output, signal: AbortSignal): Promise<Execution> {
    let group: CommandProcess;
    try {
      group = currentPlatform().commands.start({
        command: request.command,
        cwd: request.workspace,
        env: { ...process.env, HOME: request.workspace, PWD: request.workspace },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ending: { kind: "not-started", reason }, pipesHeld: false, background: "finished" };
    }
    const shell = group.child;
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
      return { ending: await exit, pipesHeld: false, background: "finished" };
    }
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
      const stopped = group.kill();
      if (stopped.ok) {
        await exit;
        ending = { kind: interruption ?? "stopped" };
      } else {
        ending = { kind: "stop-failed", reason: stopped.reason };
      }
    } else if (exited.kind === "not-started") {
      this.#groups.delete(group);
      return { ending: exited, pipesHeld: false, background: "finished" };
    } else {
      ending = exited;
    }

    const killed = ending.kind === "timed-out" || ending.kind === "stopped";
    const waitSignal = killed ? new AbortController().signal : signal;
    const deadline = this.#clock.now() + EXIT_GRACE_MS;
    while (
      (open > 0 || group.background() === "running") &&
      this.#clock.now() < deadline &&
      !waitSignal.aborted
    ) {
      await this.#clock.sleep(POLL_MS, waitSignal);
    }
    // A stop that arrives while waiting ends the background of a command that itself already finished.
    if (signal.aborted && !killed && ending.kind !== "stop-failed") {
      const stopped = group.kill();
      if (!stopped.ok) ending = { kind: "stop-failed", reason: stopped.reason };
    }
    const pipesHeld = open > 0;
    shell.stdout.destroy();
    shell.stderr.destroy();
    const background = group.background();
    if (background !== "running") this.#groups.delete(group);
    return { ending, pipesHeld, background };
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
    const excess = Buffer.byteLength(this.#text) - BASH_KEPT_OUTPUT_BYTES;
    if (excess > 0) {
      const bytes = Buffer.from(this.#text);
      let offset = excess;
      while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset++;
      this.#dropped += offset;
      this.#text = bytes.subarray(offset).toString("utf8");
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
  background: Background,
  timeoutSeconds: number | undefined,
): ToolResult {
  const remarks: string[] = [];
  if (output.droppedBytes > 0) {
    remarks.push(
      `[Output truncated: the first ${output.droppedBytes} bytes were dropped; the last ${BASH_KEPT_OUTPUT_BYTES} bytes are kept]`,
    );
  }
  if (pipesHeld && ending.kind !== "stop-failed") {
    remarks.push(
      "[Output may be incomplete: a background process still holds the output after the command exited]",
    );
  }
  if (background === "running") {
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
      return "Command was stopped: its caller stopped it or the connection to the node dropped";
    case "stop-failed":
      return `Command could not be stopped; processes may still be running: ${ending.reason}`;
    case "not-started":
      return `Command could not start: ${ending.reason}`;
  }
}
