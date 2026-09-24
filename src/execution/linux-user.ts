import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  operationSchema,
  type ExecutionBackend,
  type ExecutionRequest,
  type ExecutionResult,
} from "./backend.js";
import { within } from "./paths.js";

export interface LinuxIdentity {
  uid: number;
  gid: number;
  home: string;
  username?: string | undefined;
}
const identitySchema = z
  .object({
    uid: z.number().int().nonnegative(),
    gid: z.number().int().nonnegative(),
    home: z.string().startsWith("/"),
    username: z.string().optional(),
  })
  .strict();

export function linuxScopeCommand(
  identity: LinuxIdentity,
  cwd: string,
  program: string,
  programArgs: string[],
  name = `mate-agent-${identity.uid}-${randomUUID()}`,
): { command: string; args: string[]; unit: string } {
  if (
    !/^mate-agent-[0-9]+-[a-z0-9-]+$/.test(name) ||
    !name.startsWith(`mate-agent-${identity.uid}-`)
  )
    throw new Error("Invalid Agent scope name");
  const path = `${identity.home}/.local/bin:${identity.home}/bin:/usr/local/bin:/usr/bin:/bin`;
  return {
    command: "/usr/bin/systemd-run",
    unit: `${name}.scope`,
    args: [
      "--quiet",
      "--collect",
      "--scope",
      "--expand-environment=no",
      `--unit=${name}`,
      `--slice=mate-agent-${identity.uid}.slice`,
      `--working-directory=${cwd}`,
      `--setenv=HOME=${identity.home}`,
      `--setenv=PATH=${path}`,
      `--setenv=USER=${identity.username ?? identity.uid}`,
      `--setenv=LOGNAME=${identity.username ?? identity.uid}`,
      "--setenv=LANG=C.UTF-8",
      "--",
      "/usr/bin/setpriv",
      `--reuid=${identity.uid}`,
      `--regid=${identity.gid}`,
      "--clear-groups",
      "--no-new-privs",
      "--",
      program,
      ...programArgs,
    ],
  };
}

/** Ordinary host execution under the Agent's Unix identity. The caller must have setuid privilege. */
export class LinuxUserBackend implements ExecutionBackend {
  private readonly identities: Readonly<Record<string, LinuxIdentity>>;
  private readonly helper: string;
  constructor(identities: Readonly<Record<string, LinuxIdentity>>, helperPath?: string) {
    this.identities = Object.fromEntries(
      Object.entries(identities).map(([id, identity]) => [id, identitySchema.parse(identity)]),
    );
    const adjacent = fileURLToPath(new URL("./file-operation.mjs", import.meta.url));
    this.helper =
      helperPath ??
      (existsSync(adjacent)
        ? adjacent
        : resolve(dirname(adjacent), "../../dist/src/execution/file-operation.mjs"));
  }
  async execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    const op = operationSchema.parse(request.operation);
    z.number().int().min(1).max(300000).parse(request.timeoutMs);
    const identity = request.agentId ? this.identities[request.agentId] : undefined;
    if (!identity) throw new Error("Linux user identity is not configured for Agent");
    if (signal?.aborted) throw new Error("Execution aborted");
    const root = realpathSync(request.root);
    if (!statSync(root).isDirectory()) throw new Error("Workspace root is not a directory");
    const path = resolve(root, op.kind === "exec" ? op.cwd : op.path);
    if (op.kind === "exec" && !statSync(path).isDirectory()) throw new Error("Invalid command cwd");
    const shell = op.kind === "exec",
      privateHome = within(realpathSync(identity.home), path),
      umask = privateHome ? "077" : "022";
    const program = shell ? "/bin/sh" : process.execPath;
    const programArgs = shell
      ? ["-c", `umask ${umask}; ${op.command}`]
      : [this.helper, root, umask];
    // The systemd scope survives a shell that leaves background children behind. setpriv clears root's inherited groups.
    const privileged = process.platform === "linux" && process.getuid?.() === 0;
    if (!privileged && (process.getuid?.() !== identity.uid || process.getgid?.() !== identity.gid))
      throw new Error("Mate cannot switch to the configured Linux user");
    const scope = privileged
      ? linuxScopeCommand(identity, shell ? path : root, program, programArgs)
      : undefined;
    const command = scope?.command ?? program,
      args = scope?.args ?? programArgs;
    const env = {
      PATH: `${identity.home}/.local/bin:${identity.home}/bin:/usr/local/bin:/usr/bin:/bin`,
      HOME: identity.home,
      USER: identity.username ?? String(identity.uid),
      LOGNAME: identity.username ?? String(identity.uid),
      LANG: "C.UTF-8",
    };
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: shell ? path : root,
        env,
        detached: true,
        stdio: [shell ? "ignore" : "pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      let outBytes = 0,
        errBytes = 0,
        truncated = false,
        interrupted = false,
        settled = false;
      const collect = (parts: Buffer[], size: number, chunk: Buffer): number => {
        const available = 65536 - size;
        if (available <= 0) {
          truncated = true;
          return size;
        }
        const part = chunk.subarray(0, available);
        parts.push(part);
        if (part.length < chunk.length) truncated = true;
        return size + part.length;
      };
      child.stdout!.on("data", (chunk: Buffer) => {
        outBytes = collect(stdout, outBytes, chunk);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        errBytes = collect(stderr, errBytes, chunk);
      });
      const stop = () => {
        if (interrupted) return;
        interrupted = true;
        if (scope)
          spawnSync("/usr/bin/systemctl", ["stop", "--", scope.unit], {
            timeout: 10000,
            env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
            stdio: "ignore",
          });
        if (child.pid)
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
      };
      const timer = setTimeout(stop, request.timeoutMs);
      signal?.addEventListener("abort", stop, { once: true });
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
      };
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        finish();
        reject(error);
      });
      const complete = (code: number | null, openPipes: boolean) => {
        if (settled) return;
        settled = true;
        finish();
        if (openPipes) {
          child.stdout!.destroy();
          child.stderr!.destroy();
        }
        if (interrupted)
          reject(new Error("Linux user execution aborted or timed out; outcome may be unknown"));
        else
          resolvePromise({
            code: code ?? 1,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            truncated: truncated || openPipes,
          });
      };
      // A background child may inherit these pipes. Return after the shell exits, then close transient output capture.
      child.once("exit", (code) => {
        setTimeout(
          () => complete(code, !child.stdout!.readableEnded || !child.stderr!.readableEnded),
          25,
        );
      });
      child.once("close", (code) => complete(code, false));
      if (!shell) {
        child.stdin!.on("error", () => {});
        child.stdin!.end(JSON.stringify(op));
      }
    });
  }
}
