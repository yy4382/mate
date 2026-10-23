import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NetworkProxy,
  HumanBrowser,
  ScriptedProvider,
  type ScriptedRequest,
  type ScriptedRequestBody,
} from "@mate/testkit";
import { onTestFailed, onTestFinished, vi } from "vitest";

const controlPlaneMain = fileURLToPath(
  new URL("../../../apps/control-plane/src/main.ts", import.meta.url),
);
const nodeMain = fileURLToPath(new URL("../../../apps/node/src/main.ts", import.meta.url));

export const PASSWORD = "system scenario owner password";
export const settings = { model: { provider: "openai", modelId: "gpt-4.1" } };

/** Wait, without a fixed delay, until `check` stops throwing. */
export function until<T>(check: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(check, { timeout: 30_000, interval: 25 });
}

type Child = {
  readonly process: ChildProcess;
  readonly exited: Promise<void>;
  readonly output: () => string;
};

/** Start `node --conditions=mate-source <main> <args>` as its own process and collect what it prints. */
function launch(main: string, args: string[], env: Record<string, string>): Child {
  const process = spawn(globalThis.process.execPath, ["--conditions=mate-source", main, ...args], {
    env: { ...globalThis.process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [process.stdout, process.stderr])
    stream.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  const exited = new Promise<void>((resolve) => process.once("exit", () => resolve()));
  return { process, exited, output: () => output };
}

const STOP_TIMEOUT_MS = 10_000;

/** Send `signal` and wait for the exit. A child that ignores it is SIGKILLed after a timeout, and that is reported as a failure. */
async function stop(child: Child | undefined, signal: NodeJS.Signals): Promise<void> {
  if (child === undefined || child.process.exitCode !== null || child.process.signalCode !== null)
    return;
  child.process.kill(signal);
  let timer: NodeJS.Timeout | undefined;
  const stuck = new Promise<"stuck">((resolve) => {
    timer = setTimeout(() => resolve("stuck"), STOP_TIMEOUT_MS);
  });
  const result = await Promise.race([child.exited.then(() => "exited" as const), stuck]);
  clearTimeout(timer);
  if (result === "exited") return;
  child.process.kill("SIGKILL");
  await child.exited;
  throw new Error(
    `the process ignored ${signal} for ${STOP_TIMEOUT_MS} ms and was killed with SIGKILL:\n${child.output()}`,
  );
}

/** The control plane as its own process, on a data directory that outlives the process. */
class ControlPlaneProcess {
  /** The port the first start bound; every restart asks for it again so a node's configured URL stays valid. */
  port = 0;
  readonly #env: Record<string, string>;
  #child: Child | undefined;
  readonly logs: string[] = [];

  constructor(data: string, passwordFile: string) {
    this.#env = {
      MATE_DATA_DIRECTORY: data,
      MATE_HOST: "127.0.0.1",
      MATE_INITIAL_PASSWORD_FILE: passwordFile,
    };
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Start it and resolve once it listens. */
  async start(): Promise<void> {
    const child = launch(controlPlaneMain, [], { ...this.#env, MATE_PORT: String(this.port) });
    this.#child = child;
    this.port = await Promise.race([
      until(() => {
        const bound = /listening on http:\/\/[^\s:]+:(\d+)/.exec(child.output())?.[1];
        if (bound === undefined) throw new Error("not listening yet");
        return Number(bound);
      }),
      child.exited.then(() => {
        throw new Error(`the control plane exited while starting:\n${child.output()}`);
      }),
    ]);
  }

  /** SIGKILL: no shutdown code runs, as in a crash or a power cut. */
  async kill(): Promise<void> {
    await stop(this.#child, "SIGKILL");
    this.#remember();
  }

  async close(): Promise<void> {
    await stop(this.#child, "SIGTERM");
    this.#remember();
  }

  #remember(): void {
    if (this.#child !== undefined) this.logs.push(this.#child.output());
    this.#child = undefined;
  }

  output(): string {
    return [...this.logs, this.#child?.output() ?? ""].join("\n--- restart ---\n");
  }
}

/** The node as its own process: `mate node run` with a config in a home directory of its own. */
class NodeProcess {
  readonly home: string;
  readonly workspacesRoot: string;
  readonly #child: Child;

  constructor(home: string, controlPlaneUrl: string, pairingToken: string) {
    this.home = home;
    this.workspacesRoot = join(home, "agents");
    mkdirSync(join(home, ".config/mate"), { recursive: true });
    writeFileSync(
      join(home, ".config/mate/node.json"),
      JSON.stringify({ controlPlaneUrl, workspacesRoot: this.workspacesRoot, pairingToken }),
    );
    this.#child = launch(nodeMain, ["node", "run"], { HOME: home });
  }

  output(): string {
    return this.#child.output();
  }

  async close(): Promise<void> {
    await stop(this.#child, "SIGTERM");
  }
}

export type Hired = { agentId: string; account: number; workspace: string };

/** The tool call a script step makes to read a timeline forward. */
export const readUnread = (conversation: number) => ({
  name: "chat_read_unread",
  arguments: { timeline: { conversation } },
});

/** The tool call a script step makes to speak. */
export const chatSend = (conversation: number, body: string) => ({
  name: "chat_send",
  arguments: { timeline: { conversation }, body },
});

/** The notices (pending-chat hints) among the user texts of a request. */
export function notices(request: ScriptedRequestBody): string[] {
  return request.userTexts().filter((text) => text.startsWith("截至 "));
}

/** The matching text of a tool output, failing the step with a message the lane's `assertComplete` reports. */
export function output(request: ScriptedRequest, callId: string | undefined): string {
  const text = request.toolOutput(callId ?? "");
  if (text === undefined) throw new Error(`no tool output for call ${callId}`);
  return text;
}

export type System = Awaited<ReturnType<typeof startSystem>>;

/**
 * The whole system as real processes: the control plane (main.ts) on a temporary data directory, one node
 * (`mate node run`) paired with it over HTTP, and a scripted model provider in this process that the owner's provider
 * credentials point at. With `proxied`, the node reaches the control plane through a proxy the test can cut. Everything
 * is stopped, and its output printed if the test failed, when the test ends.
 */
export async function startSystem(options: { proxied?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-system-")));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const passwordFile = join(root, "initial-password");
  writeFileSync(passwordFile, `${PASSWORD}\n`, { mode: 0o600 });

  const provider = await ScriptedProvider.start();
  onTestFinished(() => provider.close());

  const plane = new ControlPlaneProcess(join(root, "data"), passwordFile);
  onTestFinished(() => plane.close());
  await plane.start();

  const proxy =
    options.proxied === true
      ? new NetworkProxy({ host: "127.0.0.1", port: plane.port })
      : undefined;
  if (proxy !== undefined) {
    await proxy.start();
    onTestFinished(() => proxy.close());
  }

  const owner = new HumanBrowser(plane.url);
  const api = async <T = any>(method: string, path: string, body?: unknown, status = 200) => {
    const answer = await owner.request(method, path, body);
    if (answer.status !== status)
      throw new Error(`${method} ${path} answered ${answer.status}: ${answer.text}`);
    return answer.json as T;
  };
  const login = await owner.logIn("admin", PASSWORD);
  if (login.status !== 200) throw new Error(`login answered ${login.status}: ${login.text}`);
  await api(
    "PUT",
    "/api/admin/providers/openai/credentials",
    {
      apiKey: "sk-system-00000001",
      baseUrl: provider.baseUrl,
    },
    204,
  );

  const nodes = () => api<{ nodeId: string; online: boolean }[]>("GET", "/api/admin/nodes");
  const runningNodes: NodeProcess[] = [];
  async function addNode(name?: string) {
    const known = new Set((await nodes()).map((node) => node.nodeId));
    const { pairingToken } = await api<{ pairingToken: string }>(
      "POST",
      "/api/admin/pairing-tokens",
    );
    const home = join(root, `node-home-${runningNodes.length + 1}`);
    const node = new NodeProcess(
      home,
      proxy === undefined ? plane.url : `http://127.0.0.1:${proxy.port}`,
      pairingToken,
    );
    runningNodes.push(node);
    onTestFinished(() => node.close());
    const connected = await until(async () => {
      const online = (await nodes()).find((each) => !known.has(each.nodeId) && each.online);
      if (online === undefined) throw new Error("the new node is not online yet");
      return online;
    });
    if (name !== undefined) await api("PUT", `/api/admin/nodes/${connected.nodeId}`, { name }, 204);
    return { node, nodeId: connected.nodeId };
  }

  onTestFailed(() => {
    const answered = provider.requests.map((each) => `${each.lane}/${each.step}`).join(", ");
    const nodeLogs = runningNodes
      .map((node, index) => `--- node ${index + 1} ---\n${node.output()}`)
      .join("\n");
    console.log(
      `--- model requests ---\n${answered}\n--- control plane ---\n${plane.output()}\n${nodeLogs}`,
    );
  });
  const { node, nodeId } = await addNode();

  let requests = 0;
  const requestId = () => `system:${++requests}`;
  const snapshot = () =>
    api<{ accounts: { accountId: number; handle: string }[] }>("GET", "/api/chat/snapshot");

  const system = {
    provider,
    plane,
    proxy,
    owner,
    nodeId,
    api,
    node,
    addNode,
    /** Wait until the node is online (again). */
    async nodeOnline(): Promise<void> {
      await until(async () => {
        if (!(await nodes()).some((each) => each.nodeId === nodeId && each.online))
          throw new Error("the node is offline");
      });
    },
    /** Create an Agent on the node. */
    async hire(handle: string, displayName: string): Promise<Hired> {
      const { agentId } = await api<{ agentId: string }>("POST", "/api/admin/agents", {
        nodeId,
        displayName,
        handle,
        settings,
      });
      const account = (await snapshot()).accounts.find((each) => each.handle === handle);
      if (account === undefined) throw new Error(`${handle} has no chat account`);
      return { agentId, account: account.accountId, workspace: join(node.workspacesRoot, agentId) };
    },
    /** A public channel the owner created, with the given accounts invited. */
    async channel(name: string, invitees: readonly number[]): Promise<number> {
      const { conversationId } = await api<{ conversationId: number }>(
        "POST",
        "/api/chat/channels",
        {
          requestId: requestId(),
          name,
          visibility: "public",
        },
      );
      for (const invitee of invitees)
        await api("POST", `/api/chat/conversations/${conversationId}/invite`, {
          requestId: requestId(),
          invitee,
        });
      return conversationId;
    },
    /** The owner posts in a conversation, as the web page does. */
    post(conversation: number, body: string, mentions: readonly number[] = []) {
      return api("POST", "/api/chat/messages", {
        timeline: { conversation },
        requestId: requestId(),
        body,
        mentions,
      });
    },
    /** The messages of a conversation, oldest first. */
    async messages(conversation: number): Promise<{ author: number; body: string }[]> {
      const entries = await api<{ kind: string; author: number; body: string }[]>(
        "GET",
        `/api/chat/history?conversation=${conversation}`,
      );
      return entries
        .filter((entry) => entry.kind === "message")
        .map(({ author, body }) => ({ author, body }))
        .reverse();
    },
    /** Wait until `conversation` holds a message from `author` with `body`. */
    async messageFrom(conversation: number, author: number, body: string): Promise<void> {
      await until(async () => {
        const found = (await system.messages(conversation)).some(
          (message) => message.author === author && message.body === body,
        );
        if (!found) throw new Error(`no ${JSON.stringify(body)} from ${author} yet`);
      });
    },
    /** Let a `longCommand` in `workspace` finish. */
    release(workspace: string): void {
      writeFileSync(join(workspace, "release"), "");
    },
    /** Wait until a file (a command's signal to the test) exists. */
    async fileExists(path: string): Promise<void> {
      await until(() => {
        if (!existsSync(path)) throw new Error(`${path} does not exist yet`);
      });
    },
  };
  return system;
}

/** Wait until no process has the ID `pid`, which a command recorded about itself. */
export async function processGone(pid: number): Promise<void> {
  await until(() => {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    throw new Error(`process ${pid} still runs`);
  });
}

/** A shell command that announces it runs, then runs until the test creates `release` in the workspace. It records its runs in `runs.log` and its process ID in `pid`. */
export function longCommand(): string {
  return `echo run >> runs.log; echo $$ > pid; touch started; until [ -f release ]; do sleep 0.05; done; echo finished`;
}
