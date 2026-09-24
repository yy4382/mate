import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { killProcessGroup, stopUnit } from "./linux-processes.js";
import {
  systemCommandSchema,
  type PrivilegedExecutor,
  type SystemCommand,
} from "../policy/system-operations.js";

/** A deliberately separate, clean-environment root entry. Only the approval broker calls it. */
export class PrivilegedBackend implements PrivilegedExecutor {
  async execute(
    input: SystemCommand,
    signal?: AbortSignal,
  ): Promise<{ code: number; stdout: string; stderr: string; truncated: boolean }> {
    if (process.platform !== "linux" || process.getuid?.() !== 0)
      throw new Error("Privileged execution requires the Mate Linux root service");
    const command = systemCommandSchema.parse(input);
    signal?.throwIfAborted();
    const unit = `mate-system-${randomUUID()}.service`,
      env = {
        HOME: "/root",
        USER: "root",
        LOGNAME: "root",
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8",
      };
    return new Promise((resolve, reject) => {
      const child = spawn(
        "/usr/bin/systemd-run",
        [
          "--quiet",
          "--collect",
          "--wait",
          "--pipe",
          "--expand-environment=no",
          `--unit=${unit}`,
          `--working-directory=${command.cwd}`,
          "--property=KillMode=control-group",
          "--property=RuntimeMaxSec=60s",
          "--setenv=HOME=/root",
          "--setenv=USER=root",
          "--setenv=LOGNAME=root",
          "--setenv=LANG=C.UTF-8",
          `--setenv=PATH=${env.PATH}`,
          "--",
          command.program,
          ...command.args,
        ],
        { cwd: command.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      let out = 0,
        err = 0,
        truncated = false,
        done = false;
      const capture = (target: Buffer[], used: number, chunk: Buffer) => {
        const kept = chunk.subarray(0, Math.max(0, 65536 - used));
        if (kept.length) target.push(kept);
        if (kept.length < chunk.length) truncated = true;
        return used + kept.length;
      };
      child.stdout!.on("data", (chunk: Buffer) => {
        out = capture(stdout, out, chunk);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        err = capture(stderr, err, chunk);
      });
      const stop = async () => {
        if (done) return;
        done = true;
        finish();
        killProcessGroup(child.pid);
        await stopUnit(unit);
        child.stdout!.destroy();
        child.stderr!.destroy();
        reject(new Error("Privileged command outcome may be unknown"));
      };
      const cancel = () => void stop();
      const timer = setTimeout(cancel, 60000);
      signal?.addEventListener("abort", cancel, { once: true });
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      };
      child.once("error", (error) => {
        if (done) return;
        done = true;
        finish();
        reject(error);
      });
      child.once("close", (code) => {
        if (done) return;
        done = true;
        finish();
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          truncated,
        });
      });
    });
  }
}
