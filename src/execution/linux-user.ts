import { spawn } from "node:child_process";
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
import { killProcessGroup } from "./linux-processes.js";
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

/**
 * Ordinary host execution as the account Mate already runs as. The caller must already run as the
 * identity it names: Mate never becomes another UID, spawns no service manager and starts no
 * systemd scope. An Agent's file tools therefore run as this one account, and a command that needs
 * more writes `sudo` itself, which the host's own policy decides.
 */
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
    if (process.getuid?.() !== identity.uid || process.getgid?.() !== identity.gid)
      throw new Error("Mate cannot switch to the configured Linux user");
    const env = {
      PATH: `${identity.home}/.local/bin:${identity.home}/bin:/usr/local/bin:/usr/bin:/bin`,
      HOME: identity.home,
      USER: identity.username ?? String(identity.uid),
      LOGNAME: identity.username ?? String(identity.uid),
      LANG: "C.UTF-8",
    };
    return new Promise((resolvePromise, reject) => {
      const child = spawn(program, programArgs, {
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
      // The process group is the only handle Mate has: a descendant that leaves it, or that this
      // account may not signal, is outside everything the result below describes.
      const stop = () => {
        if (interrupted) return;
        interrupted = true;
        killProcessGroup(child.pid);
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
