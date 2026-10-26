import { homedir, userInfo } from "node:os";
import { basename, isAbsolute } from "node:path";
import type { BashArguments, ConversationRole, ToolResult } from "@mate/node-protocol";
import { Commands } from "./commands.ts";
import {
  commandReplay,
  restoreSource,
  startupCapture,
  type AccountShell,
} from "./shell-baseline.ts";

type Baseline = { ok: true; shell: AccountShell; source: Buffer } | { ok: false; reason: string };

type CommandEnvironment = {
  baseline: Promise<Baseline>;
  initialization: AbortController;
  callers: Set<symbol>;
  mainDirectory: string;
  publisher: symbol | undefined;
  initializedNotice: boolean;
};

type ShellCall = {
  agentId: string;
  workspace: string;
  role: ConversationRole;
  arguments: BashArguments;
};

/** One immutable startup baseline and one remembered main directory per Agent for this node's lifetime. */
export class Shells {
  readonly #commands: Commands;
  readonly #agents = new Map<string, CommandEnvironment>();

  constructor(commands: Commands) {
    this.#commands = commands;
  }

  async run(
    call: ShellCall,
    output: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    if (signal.aborted) return stopped();
    if (call.arguments.workdir !== undefined && !isAbsolute(call.arguments.workdir)) {
      return failure("Invalid bash arguments: workdir must be an absolute directory path.");
    }
    let environment = this.#agents.get(call.agentId);
    if (environment === undefined) {
      const initialization = new AbortController();
      environment = {
        baseline: this.#initialize(call.workspace, initialization.signal),
        initialization,
        callers: new Set(),
        mainDirectory: call.workspace,
        publisher: undefined,
        initializedNotice: true,
      };
      this.#agents.set(call.agentId, environment);
    }
    const token = Symbol();
    environment.callers.add(token);
    const publishes =
      call.role === "main" && !call.arguments.background && environment.publisher === undefined;
    if (publishes) environment.publisher = token;
    const directory =
      call.arguments.workdir ??
      (call.role === "assistant" ? call.workspace : environment.mainDirectory);
    const aborted = Promise.withResolvers<undefined>();
    const onAbort = () => {
      environment.callers.delete(token);
      if (environment.callers.size === 0) environment.initialization.abort();
      aborted.resolve(undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const baseline = await Promise.race([environment.baseline, aborted.promise]);
      if (signal.aborted || baseline === undefined) return stopped();
      if (!baseline.ok)
        return failure(
          `Shell initialization failed: ${baseline.reason}. Restart the node after correcting its shell startup configuration.`,
        );
      const initialized = environment.initializedNotice;
      environment.initializedNotice = false;
      const outcome = await this.#commands.run(
        {
          command: call.arguments.command,
          directory,
          // No inherited exports or startup hooks can replace the captured baseline on a later call.
          env: {},
          timeoutSeconds: call.arguments.timeout,
          launch: commandReplay(baseline.shell, baseline.source, call.arguments.command),
        },
        output,
        signal,
      );
      const record = outcome.metadata?.toString("utf8");
      const finalDirectory = record?.endsWith("\n\0") ? record.slice(0, -2) : undefined;
      const accepted =
        outcome.ending.kind === "exited" &&
        !signal.aborted &&
        finalDirectory !== undefined &&
        isAbsolute(finalDirectory);
      const remarks: string[] = [];
      if (accepted) {
        const changed = finalDirectory !== (publishes ? environment.mainDirectory : directory);
        if (publishes) environment.mainDirectory = finalDirectory;
        if (changed) {
          remarks.push(
            publishes
              ? `[Working directory: ${finalDirectory}]`
              : `[This command's final directory: ${finalDirectory}. The main working directory remains unchanged.]`,
          );
        }
      } else {
        remarks.push(
          `[No working directory update was recorded. The main working directory remains ${environment.mainDirectory}.]`,
        );
      }
      if (initialized)
        remarks.push(
          `[Initialized a new command environment at ${call.workspace}. Startup configuration is kept until the node restarts.]`,
        );
      return {
        ...outcome.result,
        content: [
          ...outcome.result.content,
          ...remarks.map((text) => ({ type: "text" as const, text: `\n${text}` })),
        ],
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
      environment.callers.delete(token);
      if (environment.publisher === token) environment.publisher = undefined;
    }
  }

  shutdown(): void {
    for (const environment of this.#agents.values()) environment.initialization.abort();
  }

  async #initialize(workspace: string, signal: AbortSignal): Promise<Baseline> {
    try {
      const executable = userInfo().shell;
      const family = executable === null ? undefined : basename(executable);
      if (executable === null || (family !== "bash" && family !== "zsh")) {
        return {
          ok: false,
          reason: `the node account's configured shell ${executable ?? "(unknown)"} is unsupported; Bash or zsh is required`,
        };
      }
      const shell: AccountShell = { executable, family };
      const outcome = await this.#commands.run(
        {
          command: "",
          directory: workspace,
          env: { ...process.env, HOME: homedir(), PWD: workspace },
          timeoutSeconds: 30,
          launch: startupCapture(shell),
        },
        () => {},
        signal,
      );
      if (
        outcome.ending.kind !== "exited" ||
        outcome.ending.code !== 0 ||
        outcome.metadata === undefined ||
        signal.aborted
      ) {
        return {
          ok: false,
          reason: `startup did not produce a complete baseline within 30 seconds and 4 MiB (${outcome.result.content.map((part) => part.text).join("")})`,
        };
      }
      return { ok: true, shell, source: restoreSource(shell, outcome.metadata) };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

function failure(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
function stopped(): ToolResult {
  return failure(
    "Command was stopped: its caller stopped it or the connection to the node dropped",
  );
}
