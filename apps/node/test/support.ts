import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";
import type { JsonValue, ToolName, ToolResult } from "@mate/node-protocol";
import { FakeGateway } from "@mate/testkit";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
export const linux = process.platform === "linux";

/** A node started as its own process, the way systemd starts it, against a fake gateway. */
export type NodeProcess = {
  /** The gateway the helpers below talk through; a test may swap it for one that replaced it. */
  gateway: FakeGateway;
  child: ChildProcess;
  workspacesRoot: string;
  /** Resolves with how the node process ended. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr: () => string;
  /** Prepare a fresh Agent workspace and return its ID and real path. */
  agent(): Promise<{ agentId: string; workspace: string }>;
  run(
    agentId: string,
    tool: ToolName,
    args: Record<string, JsonValue>,
    onOutput?: (chunk: string) => void,
  ): Promise<ToolResult>;
};

export type StartOptions = {
  gateway?: FakeGateway;
  env?: Record<string, string>;
  pairingToken?: string;
  /** Wraps the node's command line, for a test that must start it inside something else. */
  launch?: (argv: string[]) => string[];
};

export async function startNodeProcess(options: StartOptions = {}): Promise<NodeProcess> {
  const gateway = options.gateway ?? new FakeGateway();
  if (options.gateway === undefined) {
    await gateway.start();
    onTestFinished(() => gateway.close());
  }
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mate-node-")));
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const workspacesRoot = join(home, "agents");
  const [command = process.execPath, ...args] = (options.launch ?? ((argv) => argv))([
    process.execPath,
    "--conditions=mate-source",
    main,
  ]);
  const child = spawn(command, args, {
    env: {
      ...process.env,
      MATE_CONTROL_PLANE_URL: gateway.url,
      MATE_NODE_DATA_DIR: join(home, "node"),
      MATE_NODE_WORKSPACES_ROOT: workspacesRoot,
      MATE_NODE_PAIRING_TOKEN: options.pairingToken ?? "pairing-token-for-tests",
      ...options.env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  });
  const node: NodeProcess = {
    gateway,
    child,
    workspacesRoot,
    exited,
    stderr: () => stderr,
    async agent() {
      const agentId = `agent-${randomUUID()}`;
      const prepared = await node.gateway.prepareWorkspace(randomUUID(), agentId);
      if (prepared.isError) throw new Error(prepared.content[0]?.text);
      return { agentId, workspace: join(workspacesRoot, agentId) };
    },
    run: (agentId, tool, args, onOutput) =>
      node.gateway.runTool(randomUUID(), agentId, tool, args, onOutput),
  };
  return node;
}

/** Start a node and wait until the gateway has authenticated it. */
export async function connectedNode(options: StartOptions = {}): Promise<NodeProcess> {
  const node = await startNodeProcess(options);
  await Promise.race([
    node.gateway.waitForNode(),
    node.exited.then(({ code }) => {
      throw new Error(`node exited (${code}) before connecting: ${node.stderr()}`);
    }),
  ]);
  return node;
}

export function textOf(result: ToolResult): string {
  return result.content.map((part) => part.text).join("");
}

/**
 * Whether a process can still run. On Linux a zombie has finished, and `/proc` says so; elsewhere only the signal
 * probe is available.
 */
export function running(pid: number): boolean {
  if (linux) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return !"ZXx".includes(stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3));
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `predicate` holds, or fail with `message`. */
export async function eventually(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function readPid(path: string): number {
  return Number(readFileSync(path, "utf8").trim());
}

/** A real directory that is removed when the test ends. */
export function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "mate-node-test-")));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
