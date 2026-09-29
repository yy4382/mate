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

export interface FileExecutionAccount {
  uid: number;
  gid: number;
  home: string;
  username?: string | undefined;
}
const accountSchema = z
  .object({
    uid: z.number().int().nonnegative(),
    gid: z.number().int().nonnegative(),
    home: z.string().startsWith("/"),
    username: z.string().optional(),
  })
  .strict();

/** Executes file helpers as Mate's existing account, with the Agent workspace as HOME. */
export class SameAccountFileBackend implements ExecutionBackend {
  private readonly account: FileExecutionAccount;
  private readonly helper: string;
  constructor(account: FileExecutionAccount, helperPath?: string) {
    this.account = accountSchema.parse(account);
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
    const account = this.account;
    if (signal?.aborted) throw new Error("Execution aborted");
    const root = realpathSync(request.root);
    if (!statSync(root).isDirectory()) throw new Error("Workspace root is not a directory");
    const path = resolve(root, op.path);
    const privateHome = within(realpathSync(account.home), path),
      umask = privateHome ? "077" : "022";
    if (process.getuid?.() !== account.uid || process.getgid?.() !== account.gid)
      throw new Error("File execution account does not match the running Mate account");
    const env = {
      PATH: `${account.home}/.local/bin:${account.home}/bin:/usr/local/bin:/usr/bin:/bin`,
      HOME: account.home,
      USER: account.username ?? String(account.uid),
      LOGNAME: account.username ?? String(account.uid),
      LANG: "C.UTF-8",
    };
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [this.helper, root, umask], {
        cwd: root,
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
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
          reject(new Error("File execution aborted or timed out; outcome may be unknown"));
        else
          resolvePromise({
            code: code ?? 1,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            truncated: truncated || openPipes,
          });
      };
      // A background child may inherit these pipes. Return after the helper exits, then close transient output capture.
      child.once("exit", (code) => {
        setTimeout(
          () => complete(code, !child.stdout!.readableEnded || !child.stderr!.readableEnded),
          25,
        );
      });
      child.once("close", (code) => complete(code, false));
      child.stdin!.on("error", () => {});
      child.stdin!.end(JSON.stringify(op));
    });
  }
}
