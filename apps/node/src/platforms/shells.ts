import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { darwinProcesses, linuxProcesses, PosixProcessGroup } from "./posix-processes.ts";
import type { CommandProcess, ShellRequest } from "./types.ts";
import { WindowsProcessTree } from "./windows-processes.ts";

export const linuxCommands = {
  start(request: ShellRequest): CommandProcess {
    return startPosix(request, linuxProcesses);
  },
};

export const darwinCommands = {
  start(request: ShellRequest): CommandProcess {
    return startPosix(request, darwinProcesses);
  },
};

function startPosix(request: ShellRequest, processes: typeof linuxProcesses): CommandProcess {
  const child = spawn("/bin/sh", ["-c", request.command], {
    cwd: request.cwd,
    env: request.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const group = child.pid === undefined ? undefined : new PosixProcessGroup(child.pid, processes);
  return {
    child,
    kill() {
      return group?.kill() ?? { ok: true };
    },
    background() {
      return group?.background() ?? "finished";
    },
  };
}

export const windowsCommands = {
  start(request: ShellRequest): CommandProcess {
    const marker = `mate-command-${randomUUID()}`;
    const prefix = [
      `$mateCommand = '${marker}'`,
      "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
      "$OutputEncoding = [Console]::OutputEncoding",
    ];
    if (
      Object.entries(request.env).some(
        ([key, value]) => key.toUpperCase() === "HOME" && value !== undefined,
      )
    ) {
      prefix.push("Set-Variable -Name HOME -Value $env:HOME -Force");
    }
    const quotedCommand = request.command.replace(/['\u2018-\u201b]/g, "$&$&");
    const invocation = `${prefix.join("; ")}\n& ([ScriptBlock]::Create('${quotedCommand}'))`;
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
    const tree = new WindowsProcessTree(child, marker);
    return {
      child,
      kill() {
        return tree.kill();
      },
      background() {
        return tree.background();
      },
    };
  },
};
