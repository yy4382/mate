import { spawn, spawnSync, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { Readable } from "node:stream";
import { PosixProcessGroup } from "./posix-processes.ts";
import type { CommandProcess, ShellRequest } from "./types.ts";

export const posixCommands = {
  start(request: ShellRequest): CommandProcess {
    const child = spawn(
      request.launch?.executable ?? "/bin/sh",
      request.launch?.args ?? ["-c", request.command],
      {
        cwd: request.cwd,
        env: request.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      },
    );
    if (!hasCommandPipes(child)) throw new Error("Command output pipes were not created");
    const metadata = child.stdio[3];
    const group = child.pid === undefined ? undefined : new PosixProcessGroup(child.pid);
    return {
      child,
      ...(metadata instanceof Readable ? { metadata } : {}),
      kill() {
        group?.kill();
        return { ok: true };
      },
      background() {
        return group?.running() ? "running" : "finished";
      },
    };
  },
};

function hasCommandPipes(
  child: ChildProcess,
): child is ChildProcessByStdio<null, Readable, Readable> {
  return (
    child.stdin === null && child.stdout instanceof Readable && child.stderr instanceof Readable
  );
}

export const windowsCommands = {
  start(request: ShellRequest): CommandProcess {
    const prefix = [
      "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
      "$OutputEncoding = [Console]::OutputEncoding",
    ];
    if (request.env.HOME !== undefined) {
      prefix.push("Set-Variable -Name HOME -Value $env:HOME -Force");
    }
    const command = [
      request.command,
      "$mateCommandSucceeded = $?",
      "if (-not $mateCommandSucceeded) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }",
    ].join("\n");
    const quotedCommand = command.replace(/['\u2018-\u201b]/g, "$&$&");
    const invocation = `${prefix.join("; ")}\n. ([ScriptBlock]::Create('${quotedCommand}'))`;
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", invocation],
      {
        cwd: request.cwd,
        env: request.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let exited = false;
    let killed = false;
    child.once("exit", () => {
      exited = true;
    });
    child.once("error", () => {
      exited = true;
    });
    return {
      child,
      kill() {
        if (child.pid === undefined || exited || killed) return { ok: true };
        const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
          timeout: 15_000,
          windowsHide: true,
        });
        killed = result.status === 0;
        if (!killed) {
          try {
            process.kill(child.pid, 0);
          } catch (error) {
            killed = (error as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
        if (killed) return { ok: true };
        const reason = result.error?.message || result.stderr.trim() || result.stdout.trim();
        return {
          ok: false,
          reason: reason || `Windows process-tree termination exited with code ${result.status}`,
        };
      },
      background() {
        return exited || killed ? "finished" : "running";
      },
    };
  },
};
