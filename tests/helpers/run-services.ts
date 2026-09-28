import { spawn, type ChildProcess } from "node:child_process";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
export const ownerPassword = "agent-command-process-owner-password";
const commandTimeoutMs = 700;
/** Real subprocess output, so the test waits on what the services really printed. */
export class ProcessOutput {
  text = "";
  exitStatus: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private readonly changes = new Set<() => void>();
  readonly exited: Promise<void>;

  constructor(readonly child: ChildProcess) {
    if (!child.stdout || !child.stderr) throw new Error("Test child output was unavailable");
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => this.append(chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => this.append(chunk));
    this.exited = new Promise((resolveExit) => {
      child.once("exit", (code, signal) => {
        this.exitStatus = { code, signal };
        this.changed();
        resolveExit();
      });
    });
  }

  waitFor(pattern: RegExp, timeoutMs = 15_000): Promise<RegExpMatchArray> {
    const current = this.text.match(pattern);
    if (current) return Promise.resolve(current);
    return new Promise((resolveMatch, reject) => {
      const finish = (match?: RegExpMatchArray) => {
        clearTimeout(timeout);
        this.changes.delete(check);
        if (match) resolveMatch(match);
        else reject(new Error(`Test process did not produce ${pattern}: ${this.text}`));
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

export async function stopProcess(output: ProcessOutput | undefined): Promise<void> {
  if (!output || output.exitStatus) return;
  output.child.kill("SIGTERM");
  await Promise.race([
    output.exited,
    new Promise<void>((resolveStop) =>
      setTimeout(() => {
        output.child.kill("SIGKILL");
        resolveStop();
      }, 2000),
    ),
  ]);
  await output.exited;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export async function eventually<T>(
  read: () => T | undefined,
  label: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function login(origin: string): Promise<string> {
  const response = await fetch(new URL("/api/auth/login", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: ownerPassword }),
  });
  expect(response.status).toBe(204);
  return response.headers.get("set-cookie")!.split(";", 1)[0]!;
}

export function startControlPlane(
  directory: string,
  nodeOperationTimeoutMs?: number,
): ProcessOutput {
  const entry = pathToFileURL(resolve("dist/src/control-plane/main.js")).href;
  const args =
    nodeOperationTimeoutMs === undefined
      ? [resolve("dist/src/control-plane/main.js")]
      : [
          "--input-type=module",
          "--eval",
          `const { startControlPlane } = await import(${JSON.stringify(entry)}); startControlPlane(0, undefined, { dataDir: process.env.MATE_CONTROL_PLANE_DATA_DIR, passwordFile: process.env.MATE_OWNER_PASSWORD_FILE, nodeOperationTimeoutMs: ${nodeOperationTimeoutMs} });`,
        ];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      MATE_CONTROL_PLANE_PORT: "0",
      MATE_CONTROL_PLANE_DATA_DIR: join(directory, "control-plane-data"),
      MATE_OWNER_PASSWORD_FILE: join(directory, "owner-password"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new ProcessOutput(child);
}

/**
 * The deployment node entry, with the real workspace provisioning and the real ordinary-command
 * ledger, and one scripted model worker instead of a provider stream. Only the command time bound
 * is shortened so a timeout can be observed inside one test.
 */
export function startNode(options: {
  origin: string;
  nodeData: string;
  workspaceRoot: string;
  pairingToken?: string;
  modelWorkerEntry: string;
  /** The node's ordinary-command time bound; tests that need a command to outlive the node raise it. */
  commandTimeoutMs?: number;
}): ProcessOutput {
  const clientModule = pathToFileURL(resolve("dist/src/nodes/client.js")).href,
    runtimeModule = pathToFileURL(resolve("dist/src/nodes/process-operation-runtime.js")).href,
    runner = `
      const { runLinuxNodeWithTestDependencies } = await import(${JSON.stringify(clientModule)});
      const { openNodeProcessOperations } = await import(${JSON.stringify(runtimeModule)});
      const { LinuxWorkspaceExecutor } = await import(${JSON.stringify(pathToFileURL(resolve("dist/src/nodes/workspace-execution.js")).href)});
      const store = openNodeProcessOperations(
        process.env.MATE_NODE_DATA_DIR,
        process.env.MATE_NODE_AGENT_WORKSPACE_ROOT,
        { commandTimeoutMs: Number(process.env.MATE_COMMAND_TIMEOUT_MS) },
      );
      const controller = new AbortController();
      process.on("SIGTERM", () => controller.abort());
      try {
        await runLinuxNodeWithTestDependencies({
          controlPlaneUrl: process.env.MATE_CONTROL_PLANE_URL,
          dataDirectory: process.env.MATE_NODE_DATA_DIR,
          agentWorkspaceRoot: process.env.MATE_NODE_AGENT_WORKSPACE_ROOT,
          pairingToken: process.env.MATE_NODE_PAIRING_TOKEN,
          // A slow heartbeat keeps this test about command execution: the control plane's periodic
          // mid-flight reconciliation belongs to the recovery ticket, not here.
          heartbeatIntervalMs: 30_000,
          heartbeatTimeoutMs: 60_000,
        }, controller.signal, {
          modelWorkerEntry: ${JSON.stringify(options.modelWorkerEntry)},
          processOperations: store.operations,
          workspaceExecutor: new LinuxWorkspaceExecutor(process.env.MATE_NODE_AGENT_WORKSPACE_ROOT, process.env.MATE_NODE_DATA_DIR),
        });
      } finally {
        store.close();
      }
    `;
  return new ProcessOutput(
    spawn(process.execPath, ["--input-type=module", "--eval", runner], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "C.UTF-8",
        MATE_CONTROL_PLANE_URL: options.origin,
        MATE_NODE_DATA_DIR: options.nodeData,
        MATE_NODE_AGENT_WORKSPACE_ROOT: options.workspaceRoot,
        MATE_COMMAND_TIMEOUT_MS: String(options.commandTimeoutMs ?? commandTimeoutMs),
        ...(options.pairingToken ? { MATE_NODE_PAIRING_TOKEN: options.pairingToken } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}
