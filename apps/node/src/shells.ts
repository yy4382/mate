import { statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import type { BashArguments, ToolResult } from "@mate/node-protocol";
import { Commands } from "./commands.ts";
import {
  commandReplay,
  snapshotSource,
  startupCapture,
  type AccountShell,
} from "./shell-snapshot.ts";

type Snapshot = { ok: true; shell: AccountShell; path: string } | { ok: false; reason: string };

type ShellCall = {
  /** Whose remembered directory the call starts from and, in the foreground, updates. */
  session: string;
  workspace: string;
  arguments: BashArguments;
};

/** One startup snapshot per node process, and the directory each conversation's last foreground command ended in. */
export class Shells {
  readonly #commands: Commands;
  readonly #snapshotPath: string;
  #snapshot: Promise<Snapshot> | undefined;
  readonly #directories = new Map<string, string>();

  constructor(commands: Commands, dataDirectory: string) {
    this.#commands = commands;
    this.#snapshotPath = join(dataDirectory, "shell-snapshot");
  }

  async run(
    call: ShellCall,
    output: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    // The capture ignores its callers' signals, so a stopped first call cannot leave a failed snapshot behind.
    this.#snapshot ??= this.#capture();
    const snapshot = await Promise.race([this.#snapshot, aborted(signal)]);
    if (snapshot === undefined) return stopped();
    if (!snapshot.ok)
      return failure(
        `Shell initialization failed: ${snapshot.reason}. Restart the node after correcting its shell startup configuration.`,
      );
    const notes: string[] = [];
    let directory = this.#directories.get(call.session) ?? call.workspace;
    if (!isDirectory(directory)) {
      notes.push(`[${directory} no longer exists; started in ${call.workspace}]`);
      directory = call.workspace;
    }
    const outcome = await this.#commands.run(
      {
        command: call.arguments.command,
        directory,
        // An empty environment keeps BASH_ENV, ENV and exported functions from bypassing the snapshot.
        env: {},
        timeoutSeconds: call.arguments.timeout,
        launch: commandReplay(snapshot.shell, snapshot.path, call.arguments.command),
      },
      output,
      signal,
    );
    const record = outcome.metadata?.toString("utf8");
    const final = record?.endsWith("\n\0") ? record.slice(0, -2) : undefined;
    if (final !== undefined && !call.arguments.background) {
      this.#directories.set(call.session, final);
      if (final !== directory) notes.push(`[Working directory: ${final}]`);
    }
    return notes.length === 0
      ? outcome.result
      : {
          ...outcome.result,
          content: [
            ...outcome.result.content,
            ...notes.map((text) => ({ type: "text" as const, text: `\n${text}` })),
          ],
        };
  }

  async #capture(): Promise<Snapshot> {
    try {
      return await this.#captureOrThrow();
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async #captureOrThrow(): Promise<Snapshot> {
    const executable = userInfo().shell;
    const family = executable === null ? undefined : basename(executable);
    if (executable === null || (family !== "bash" && family !== "zsh")) {
      return {
        ok: false,
        reason: `the node account's configured shell ${executable ?? "(unknown)"} is unsupported; Bash or zsh is required`,
      };
    }
    const shell: AccountShell = { executable, family };
    const home = homedir();
    const outcome = await this.#commands.run(
      {
        command: "",
        directory: home,
        env: { ...process.env, HOME: home, PWD: home },
        timeoutSeconds: 30,
        launch: startupCapture(shell),
      },
      () => {},
      new AbortController().signal,
    );
    if (
      outcome.ending.kind !== "exited" ||
      outcome.ending.code !== 0 ||
      outcome.metadata === undefined
    ) {
      return {
        ok: false,
        reason: `startup did not produce a complete snapshot within 30 seconds and 4 MiB (${outcome.result.content.map((part) => part.text).join("")})`,
      };
    }
    writeFileSync(this.#snapshotPath, snapshotSource(shell, outcome.metadata), { mode: 0o600 });
    return { ok: true, shell, path: this.#snapshotPath };
  }
}

function aborted(signal: AbortSignal): Promise<undefined> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(undefined);
    signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
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
