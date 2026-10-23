import { spawnSync, type ChildProcess } from "node:child_process";
import type { Background, CommandProcess } from "./types.ts";

export class WindowsProcessTree {
  readonly #child: ChildProcess;
  readonly #marker: string;
  #exited = false;
  #killed = false;

  constructor(child: ChildProcess, marker: string) {
    this.#child = child;
    this.#marker = marker;
    child.once("exit", () => {
      this.#exited = true;
    });
    child.once("error", () => {
      this.#exited = true;
    });
  }

  background(): Background {
    if (this.#killed) return "finished";
    return this.#exited ? "unknown" : "running";
  }

  kill(): ReturnType<CommandProcess["kill"]> {
    const pid = this.#child.pid;
    if (pid === undefined || this.#killed) return { ok: true };
    if (this.#exited) {
      return {
        ok: false,
        reason: "The command shell has exited; Windows cannot find all of its orphaned processes",
      };
    }
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
      `$target = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
      `if ($null -eq $target -or -not $target.CommandLine.Contains('${this.#marker}')) { Write-Error 'The command shell is no longer running under its original process ID'; exit 2 }`,
      `& taskkill.exe /PID ${pid} /T /F`,
      "exit $LASTEXITCODE",
    ].join("; ");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
      },
    );
    this.#killed = result.status === 0;
    if (this.#killed) return { ok: true };
    const reason = result.error?.message || result.stderr.trim() || result.stdout.trim();
    return {
      ok: false,
      reason: reason || `Windows process-tree termination exited with code ${result.status}`,
    };
  }
}
