import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";
import {
  decodeTerminalOutcome,
  decodeTerminalWaitOutcome,
  formatTerminalOutcome,
  type JsonValue,
  type NodeAccess,
  type TerminalOutcome,
  type TerminalWaitOutcome,
  type ToolName,
  type ToolResult,
} from "@palace/node-protocol";
import { FakeGateway } from "@palace/testkit";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const runner = fileURLToPath(new URL("./fixtures/running-node.ts", import.meta.url));
const tree = fileURLToPath(new URL("./fixtures/command-tree.mjs", import.meta.url));
export const linux = process.platform === "linux";
export const windows = process.platform === "win32";

/** A node started as its own process, the way systemd starts it (`palace node run`), against a fake gateway. */
export type NodeProcess = {
  /** The gateway the helpers below talk through; a test may swap it for one that replaced it. */
  gateway: FakeGateway;
  child: ChildProcess;
  home: string;
  workspacesRoot: string;
  /** Resolves with how the node process ended. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr: () => string;
  shutdown(): Promise<void>;
  /** Prepare a fresh Agent workspace and return its ID and real path. */
  agent(): Promise<{ agentId: string; workspace: string }>;
  run(
    agentId: string,
    tool: ToolName,
    args: Record<string, JsonValue>,
    onOutput?: (chunk: string) => void,
    access?: NodeAccess,
    conversationId?: number,
  ): Promise<ToolResult>;
};

export type StartOptions = {
  gateway?: FakeGateway;
  home?: string;
  env?: NodeJS.ProcessEnv;
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
  const home = options.home ?? realpathSync(mkdtempSync(join(tmpdir(), "palace-node-")));
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const workspacesRoot = join(home, "agents");
  const configDirectory = nodeConfigDirectory(home);
  mkdirSync(configDirectory, { recursive: true });
  const config = {
    controlPlaneUrl: gateway.url,
    workspacesRoot,
    pairingToken: options.pairingToken ?? "pairing-token-for-tests",
  };
  writeFileSync(join(configDirectory, "node.json"), JSON.stringify(config));
  const optionsFile = join(home, "options.json");
  writeFileSync(optionsFile, JSON.stringify({ ...config, dataDirectory: join(home, "node-data") }));
  const invocation = windows ? [runner, optionsFile] : [main, "node", "run"];
  const [command = process.execPath, ...args] = (options.launch ?? ((argv) => argv))([
    process.execPath,
    "--conditions=palace-source",
    ...invocation,
  ]);
  const child = spawn(command, args, {
    env: nodeEnvironment(home, options.env),
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const shutdown = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      if (windows) child.stdin?.end();
      else child.kill("SIGTERM");
    }
    await exited;
  };
  onTestFinished(shutdown);
  const node: NodeProcess = {
    gateway,
    child,
    home,
    workspacesRoot,
    exited,
    stderr: () => stderr,
    shutdown,
    async agent() {
      const agentId = `agent-${randomUUID()}`;
      const prepared = await node.gateway.prepareWorkspace(randomUUID(), agentId);
      if (prepared.isError) throw new Error(prepared.content[0]?.text);
      return { agentId, workspace: join(workspacesRoot, agentId) };
    },
    run: (agentId, tool, args, onOutput, access, conversationId) =>
      node.gateway.runTool(randomUUID(), agentId, tool, args, onOutput, access, conversationId),
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

export function textOf(result: { readonly content: readonly { text: string }[] }): string {
  return result.content.map((part) => part.text).join("");
}

export function displayTerminalResult(result: ToolResult): {
  content: [{ type: "text"; text: string }];
  isError: boolean;
  outcome?: TerminalOutcome;
} {
  const decoded = decodeTerminalOutcome(result);
  if (!decoded.ok) {
    return { content: [{ type: "text", text: decoded.error }], isError: result.isError };
  }
  const formatted = formatTerminalOutcome(decoded.outcome);
  return {
    content: [{ type: "text", text: formatted.text }],
    isError: formatted.isError,
    outcome: decoded.outcome,
  };
}

export async function execCommand(
  node: NodeProcess,
  agentId: string,
  args: {
    sessionId?: string;
    command: string;
    workdir?: string;
    yieldTimeMs?: number;
    timeoutMs?: number;
  },
  onOutput?: (chunk: string) => void,
  access?: NodeAccess,
  conversationId?: number,
): Promise<{
  content: [{ type: "text"; text: string }];
  isError: boolean;
  outcome?: TerminalOutcome;
  sessionId: string;
}> {
  const sessionId = args.sessionId ?? randomUUID();
  const raw = await node.run(
    agentId,
    "terminal_exec",
    { ...args, sessionId },
    onOutput,
    access,
    conversationId,
  );
  return { ...displayTerminalResult(raw), sessionId };
}

export async function writeStdin(
  node: NodeProcess,
  agentId: string,
  args: { sessionId: string; chars?: string; eof?: boolean; kill?: boolean; yieldTimeMs?: number },
  onOutput?: (chunk: string) => void,
  access?: NodeAccess,
): Promise<{
  content: [{ type: "text"; text: string }];
  isError: boolean;
  outcome?: TerminalOutcome;
}> {
  const raw = await node.run(agentId, "terminal_write", args, onOutput, access);
  return displayTerminalResult(raw);
}

export async function waitTerminal(
  node: NodeProcess,
  agentId: string,
  sessionId: string,
  access?: NodeAccess,
): Promise<{ ok: true; outcome: TerminalWaitOutcome } | { ok: false; error: string }> {
  const raw = await node.run(agentId, "terminal_wait", { sessionId }, undefined, access);
  return decodeTerminalWaitOutcome(raw);
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
  if (process.platform === "darwin") {
    try {
      const state = execFileSync("/bin/ps", ["-p", String(pid), "-o", "stat="], {
        encoding: "utf8",
      }).trim();
      return state !== "" && !state.startsWith("Z");
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

export function nodeConfigDirectory(home: string): string {
  return windows
    ? join(home, "AppData", "Local", "Palace", "config")
    : join(home, ".config", "palace");
}

export function nodeEnvironment(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const values = {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, "AppData", "Local"),
    ...extra,
  };
  for (const [key, value] of Object.entries(values)) {
    if (windows) {
      for (const existing of Object.keys(env)) {
        if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
      }
    }
    env[key] = value;
  }
  return env;
}

export function nodeCommand(script: string, args: string[] = []): string {
  const argv = [process.execPath, script, ...args];
  if (windows) return `& ${argv.map((value) => `'${value.replaceAll("'", "''")}'`).join(" ")}`;
  return argv.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
}

export function scriptCommand(workspace: string, source: string, name = "command"): string {
  const path = join(workspace, `${name}.mjs`);
  writeFileSync(path, source);
  return nodeCommand(path);
}

export function longCommand(name: string): string {
  return nodeCommand(tree, [name]);
}

export async function pidsOf(workspace: string, name: string): Promise<number[]> {
  const path = join(workspace, `${name}.pids`);
  await eventually(() => existsSync(path), `${name} started`, windows ? 15_000 : 5_000);
  return readFileSync(path, "utf8").trim().split(" ").map(Number);
}

/** Poll until `predicate` holds, or fail with `message`. */
export async function eventually(
  predicate: () => boolean,
  message: string,
  timeoutMs = windows ? 15_000 : 5_000,
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
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "palace-node-test-")));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
