import { type ChildProcess } from "node:child_process";

export class ProcessOutput {
  text = "";
  exitStatus: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private readonly changes = new Set<() => void>();
  readonly exited: Promise<void>;

  constructor(readonly child: ChildProcess) {
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) throw new Error("Process output pipes were not created");
    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");
    stdout.on("data", (chunk: string) => this.append(chunk));
    stderr.on("data", (chunk: string) => this.append(chunk));
    this.exited = new Promise((resolveExit) => {
      child.once("exit", (code, signal) => {
        this.exitStatus = { code, signal };
        this.changed();
        resolveExit();
      });
    });
  }

  waitFor(pattern: RegExp, timeoutMs = 7000): Promise<RegExpMatchArray> {
    const current = this.text.match(pattern);
    if (current) return Promise.resolve(current);
    if (this.exitStatus)
      return Promise.reject(new Error(`Process exited before ${pattern}: ${this.text}`));

    return new Promise((resolveMatch, reject) => {
      const finish = (match?: RegExpMatchArray) => {
        clearTimeout(timeout);
        this.changes.delete(check);
        if (match) resolveMatch(match);
        else reject(new Error(`Process did not produce ${pattern}: ${this.text}`));
      };
      const check = () => {
        const match = this.text.match(pattern);
        if (match) finish(match);
        else if (this.exitStatus) finish();
      };
      const timeout = setTimeout(() => finish(), timeoutMs);
      this.changes.add(check);
    });
  }

  private append(chunk: string): void {
    this.text += chunk;
    this.changed();
  }

  private changed(): void {
    for (const change of [...this.changes]) change();
  }
}

export async function stopProcess(output: ProcessOutput): Promise<void> {
  if (output.exitStatus) return;
  const child = output.child;
  child.kill("SIGTERM");
  const graceful = new Promise<void>((resolveExit) => {
    if (output.exitStatus) resolveExit();
    else child.once("exit", () => resolveExit());
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    graceful,
    new Promise<void>((resolveTimeout) => {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolveTimeout();
      }, 1500);
    }),
  ]);
  if (timer) clearTimeout(timer);
  await output.exited;
}

export async function waitForExit(output: ProcessOutput, timeoutMs = 5000): Promise<void> {
  await Promise.race([
    output.exited,
    delay(timeoutMs).then(() => {
      throw new Error(`Process did not exit: ${output.text}`);
    }),
  ]);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
