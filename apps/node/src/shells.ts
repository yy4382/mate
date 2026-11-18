import { statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { Commands } from "./commands.ts";
import { snapshotSource, startupCapture, type AccountShell } from "./shell-snapshot.ts";

export type ShellSnapshot =
  { ok: true; shell: AccountShell; path: string } | { ok: false; reason: string };

/** One startup snapshot per node process, and the directory each conversation's last inline command ended in. */
export class Shells {
  readonly #commands: Commands;
  readonly #snapshotPath: string;
  #snapshot: Promise<ShellSnapshot> | undefined;
  readonly #directories = new Map<string, string>();

  constructor(commands: Commands, dataDirectory: string) {
    this.#commands = commands;
    this.#snapshotPath = join(dataDirectory, "shell-snapshot");
  }

  /** Capture (once per node process) and return the account shell snapshot, or `"stopped"` if `signal` aborts while waiting. */
  async prepare(signal: AbortSignal): Promise<ShellSnapshot | "stopped"> {
    // The capture ignores its callers' signals, so a stopped first call cannot leave a failed snapshot behind.
    this.#snapshot ??= this.#capture();
    const snapshot = await Promise.race([this.#snapshot, aborted(signal)]);
    return snapshot ?? "stopped";
  }

  resolveDirectory(session: string, workspace: string): { directory: string; note?: string } {
    const saved = this.#directories.get(session);
    if (saved === undefined) return { directory: workspace };
    if (!isDirectory(saved)) {
      return {
        directory: workspace,
        note: `[${saved} no longer exists; started in ${workspace}]`,
      };
    }
    return { directory: saved };
  }

  recordDirectory(
    session: string,
    previousDirectory: string,
    metadataRecord: Buffer | undefined,
  ): string | undefined {
    const text = metadataRecord?.toString("utf8");
    const final = text?.endsWith("\n\0") ? text.slice(0, -2) : undefined;
    if (final === undefined) return undefined;
    this.#directories.set(session, final);
    return final === previousDirectory ? undefined : final;
  }

  async #capture(): Promise<ShellSnapshot> {
    try {
      return await this.#captureOrThrow();
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async #captureOrThrow(): Promise<ShellSnapshot> {
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
    else signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
