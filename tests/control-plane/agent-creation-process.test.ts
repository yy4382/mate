import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { WebSocket, WebSocketServer, type RawData } from "ws";

const ownerPassword = "agent-creation-process-owner-password";
/** This worker reports the account and runtime the node really started it with. */
const probeWorker = resolve("tests/fixtures/account-probe-model-worker.mjs");

interface ModelWorkerAccount {
  pid: number;
  uid: number | null;
  gid: number | null;
  execPath: string;
  argv: string[];
  groups: number[] | null;
}

class ProcessOutput {
  text = "";
  exitStatus: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private readonly changes = new Set<() => void>();
  readonly exited: Promise<void>;

  constructor(readonly child: ChildProcess) {
    if (!child.stdout || !child.stderr)
      throw new Error("Test child process output was unavailable");
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

  waitFor(pattern: RegExp, timeoutMs = 10_000): Promise<RegExpMatchArray> {
    const current = this.text.match(pattern);
    if (current) return Promise.resolve(current);
    return new Promise((resolveMatch, reject) => {
      const finish = (match?: RegExpMatchArray) => {
        clearTimeout(timeout);
        this.changes.delete(check);
        if (match) resolveMatch(match);
        else reject(new Error(`Test process did not produce ${pattern}`));
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

async function stopProcess(output: ProcessOutput): Promise<void> {
  if (output.exitStatus) return;
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

/** Wait until the restarted control plane sees the still-running node re-authenticate by itself. */
async function waitForNodeOnline(
  origin: string,
  cookie: string,
  nodeId: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(new URL("/api/owner/nodes", origin), { headers: { cookie } });
    if (response.ok) {
      const { nodes } = (await response.json()) as {
        nodes: Array<{ id: string; online: boolean }>;
      };
      if (nodes.some((entry) => entry.id === nodeId && entry.online)) return;
    }
    await delay(50);
  }
  throw new Error("The node never re-authenticated with the restarted control plane");
}

async function login(origin: string): Promise<string> {
  const response = await fetch(new URL("/api/auth/login", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: ownerPassword }),
  });
  expect(response.status).toBe(204);
  return response.headers.get("set-cookie")!.split(";", 1)[0]!;
}

async function startControlPlane(directory: string): Promise<{
  process: ProcessOutput;
  origin: string;
}> {
  const child = spawn(process.execPath, [resolve("dist/src/control-plane/main.js")], {
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
  const output = new ProcessOutput(child);
  const port = await output
    .waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/)
    .then((match) => match[1]!);
  return { process: output, origin: `http://127.0.0.1:${port}` };
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

/**
 * A transparent WebSocket relay in front of the control plane. It changes nothing; it only records
 * the `control.agent.run` messages the control plane really sent, so the test can assert which
 * logical session the node was authorized to run instead of reaching into a private function.
 */
function startRunObserver() {
  const starts: Array<{ agentId: string; sessionId: string; runId: string }> = [],
    http = createServer(),
    server = new WebSocketServer({ noServer: true }),
    nodeSockets = new Set<WebSocket>(),
    controlSockets = new Set<WebSocket>();
  let origin = "";
  http.on("upgrade", (request, socket, head) => {
    server.handleUpgrade(request, socket, head, (nodeSocket) => {
      nodeSockets.add(nodeSocket);
      const upstream = new WebSocket(`${origin.replace(/^http/, "ws")}/api/nodes/connect`);
      controlSockets.add(upstream);
      upstream.once("error", () => nodeSocket.terminate());
      nodeSocket.on("message", (data, binary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      });
      upstream.on("message", (data, binary) => {
        try {
          const message = JSON.parse(rawText(data)) as Record<string, string>;
          if (message.type === "control.agent.run" && message.agentId && message.sessionId)
            starts.push({
              agentId: message.agentId,
              sessionId: message.sessionId,
              runId: message.runId!,
            });
        } catch {
          /* The relay only observes well-formed protocol frames. */
        }
        if (nodeSocket.readyState === WebSocket.OPEN) nodeSocket.send(data, { binary });
      });
      const close = () => {
        nodeSockets.delete(nodeSocket);
        controlSockets.delete(upstream);
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)
          upstream.close();
        if (
          nodeSocket.readyState === WebSocket.OPEN ||
          nodeSocket.readyState === WebSocket.CONNECTING
        )
          nodeSocket.close();
      };
      nodeSocket.on("close", close);
      upstream.on("close", close);
      nodeSocket.on("error", close);
      upstream.on("error", close);
    });
  });
  return {
    starts,
    setOrigin(value: string) {
      origin = value;
    },
    listen(): Promise<string> {
      return new Promise((resolveListen, rejectListen) => {
        http.once("error", rejectListen);
        http.listen(0, "127.0.0.1", () => {
          http.removeListener("error", rejectListen);
          const address = http.address();
          if (!address || typeof address === "string")
            return rejectListen(new Error("Run observer failed to bind"));
          resolveListen(`http://127.0.0.1:${address.port}`);
        });
      });
    },
    async close() {
      for (const socket of [...nodeSockets, ...controlSockets]) socket.terminate();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
    },
  };
}

/** The node entry the deployment path uses, plus one scripted model worker substitution. */
function startNode(options: {
  origin: string;
  nodeData: string;
  workspaceRoot: string;
  pairingToken?: string;
  modelWorkerEntry: string;
}): ProcessOutput {
  const clientModule = pathToFileURL(resolve("dist/src/nodes/client.js")).href,
    runner = `
      const { runLinuxNodeWithTestDependencies } = await import(${JSON.stringify(clientModule)});
      const controller = new AbortController();
      process.on("SIGTERM", () => controller.abort());
      await runLinuxNodeWithTestDependencies({
        controlPlaneUrl: process.env.MATE_CONTROL_PLANE_URL,
        dataDirectory: process.env.MATE_NODE_DATA_DIR,
        agentWorkspaceRoot: process.env.MATE_NODE_AGENT_WORKSPACE_ROOT,
        pairingToken: process.env.MATE_NODE_PAIRING_TOKEN,
        heartbeatIntervalMs: 100,
        heartbeatTimeoutMs: 2000,
      }, controller.signal, {
        modelWorkerEntry: ${JSON.stringify(options.modelWorkerEntry)},
      });
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
        ...(options.pairingToken ? { MATE_NODE_PAIRING_TOKEN: options.pairingToken } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

interface AgentPayload {
  id: string;
  name: string;
  role: string;
  description: string;
  model: { provider: string; id: string };
}

function agentPayload(overrides: Partial<AgentPayload> = {}): AgentPayload {
  return {
    id: randomUUID(),
    name: "研究与写作同事",
    role: "处理被指派的私信任务",
    description: "Synthetic single-account Agent creation fixture.",
    model: { provider: "openai", id: "gpt-4o-mini" },
    ...overrides,
  };
}

function createAgent(
  origin: string,
  cookie: string,
  nodeId: string,
  payload: AgentPayload,
): Promise<Response> {
  return fetch(new URL("/api/owner/agents", origin), {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ...payload, nodeId }),
  });
}

/** Read the Agent's own session record for one run, which is where a plain turn is written. */
function sessionTurnText(directory: string, runId: string): string | undefined {
  const db = new Database(join(directory, "control-plane-data", "control-plane.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const row = db
      .prepare(
        `SELECT text FROM owner_agent_session_journal j
         JOIN owner_agent_sessions s ON s.id=j.session_id
         WHERE j.run_id=? AND j.role='assistant' AND j.tool_action_id IS NULL
           AND j.session_id=s.id AND j.agent_id=s.agent_id`,
      )
      .get(runId) as { text: string } | undefined;
    return row?.text;
  } finally {
    db.close();
  }
}

interface RunRow {
  id: string;
  state: string;
}

function agentRuns(directory: string, agentId: string): RunRow[] {
  const db = new Database(join(directory, "control-plane-data", "control-plane.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return db
      .prepare("SELECT id,state FROM owner_agent_runs WHERE agent_id=? ORDER BY started_at")
      .all(agentId) as RunRow[];
  } finally {
    db.close();
  }
}

/** The Agent's one logical session row. A run must never add a second one. */
function agentSessions(directory: string, agentId: string): string[] {
  const db = new Database(join(directory, "control-plane-data", "control-plane.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return (
      db.prepare("SELECT id FROM owner_agent_sessions WHERE agent_id=?").all(agentId) as {
        id: string;
      }[]
    ).map((row) => row.id);
  } finally {
    db.close();
  }
}

async function waitForSessionTurn(
  directory: string,
  runId: string,
  timeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = sessionTurnText(directory, runId);
    if (text !== undefined) return text;
    await delay(25);
  }
  throw new Error("The Agent run never recorded a turn in its own session record");
}

/** Read the account report the model subprocess wrote into the Agent's own session record. */
function modelWorkerAccount(directory: string, runId: string): ModelWorkerAccount {
  const text = sessionTurnText(directory, runId);
  if (text === undefined) throw new Error("The model subprocess recorded no account report");
  return JSON.parse(text) as ModelWorkerAccount;
}

async function waitForRunStatus(
  directory: string,
  runId: string,
  status: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const db = new Database(join(directory, "control-plane-data", "control-plane.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const row = db.prepare("SELECT state FROM owner_agent_runs WHERE id=?").get(runId) as
        { state: string } | undefined;
      if (row?.state === status) return;
    } finally {
      db.close();
    }
    await delay(25);
  }
  throw new Error(`Agent run never reached ${status}`);
}

async function waitForRun(directory: string, agentId: string, count: number): Promise<RunRow[]> {
  const deadline = Date.now() + 20_000;
  let runs: RunRow[] = [];
  while (Date.now() < deadline) {
    runs = agentRuns(directory, agentId);
    if (runs.length >= count) return runs;
    await delay(25);
  }
  throw new Error(`Expected ${count} authorized run(s) for the Agent, saw ${runs.length}`);
}

it("shows a diagnosable failure on the web when the node cannot prepare the workspace", async () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-creation-failure-")),
    nodeData = join(directory, "node-data"),
    readonlyRoot = join(directory, "read-only-workspaces");
  chmodSync(directory, 0o700);
  mkdirSync(readonlyRoot, { mode: 0o500 });
  chmodSync(readonlyRoot, 0o500);
  writeFileSync(join(directory, "owner-password"), `${ownerPassword}\n`, { mode: 0o600 });

  let control: ProcessOutput | undefined, node: ProcessOutput | undefined;
  try {
    const controlPlane = await startControlPlane(directory);
    control = controlPlane.process;
    const origin = controlPlane.origin,
      cookie = await login(origin),
      pairing = await fetch(new URL("/api/owner/nodes/pairing-tokens", origin), {
        method: "POST",
        headers: { cookie },
      }),
      { pairingToken } = (await pairing.json()) as { pairingToken: string };

    node = startNode({
      origin,
      nodeData,
      workspaceRoot: readonlyRoot,
      pairingToken,
      modelWorkerEntry: resolve("tests/fixtures/direct-message-model-worker.mjs"),
    });
    const paired = await node.waitFor(/MATE_NODE_PAIRED ([0-9a-f-]+)/i);

    const payload = agentPayload(),
      response = await createAgent(origin, cookie, paired[1]!, payload);
    expect(response.status).toBe(502);
    const failed = (await response.json()) as {
      error: string;
      agent: { id: string; status: string; error: string | null };
    };
    expect(failed.agent.id).toBe(payload.id);
    expect(failed.agent.status).toBe("failed");
    // The owner sees what to fix, and the banner text stays ordinary language.
    expect(failed.error).toContain("工作区");
    expect(failed.error).not.toContain("root");
    // Nothing was half-created: no workspace directory and no other Agent.
    const listed = (await (
      await fetch(new URL("/api/owner/agents", origin), { headers: { cookie } })
    ).json()) as { agents: Array<{ id: string; status: string; error: string | null }> };
    expect(listed.agents).toHaveLength(1);
    expect(listed.agents[0]).toMatchObject({ id: payload.id, status: "failed" });
    expect(listed.agents[0]!.error).toContain("工作区");
    expect(existsSync(join(readonlyRoot, payload.id))).toBe(false);
  } finally {
    if (node) await stopProcess(node);
    if (control) await stopProcess(control);
    chmodSync(readonlyRoot, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

it("creates an Agent from the web on one ordinary account and runs its first direct message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-creation-")),
    nodeData = join(directory, "node-data"),
    workspaceRoot = join(directory, "agent-workspaces");
  chmodSync(directory, 0o700);
  mkdirSync(workspaceRoot, { mode: 0o700 });
  const ownerPasswordFile = join(directory, "owner-password");
  writeFileSync(ownerPasswordFile, `${ownerPassword}\n`, { mode: 0o600 });

  let control: ProcessOutput | undefined, node: ProcessOutput | undefined;
  const observer = startRunObserver(),
    startedAt = Date.now();
  try {
    const controlPlane = await startControlPlane(directory);
    control = controlPlane.process;
    const origin = controlPlane.origin,
      nodeOrigin = await observer.listen(),
      cookie = await login(origin);
    observer.setOrigin(origin);
    const pairing = await fetch(new URL("/api/owner/nodes/pairing-tokens", origin), {
      method: "POST",
      headers: { cookie },
    });
    expect(pairing.status).toBe(201);
    const { pairingToken } = (await pairing.json()) as { pairingToken: string };

    node = startNode({
      origin: nodeOrigin,
      nodeData,
      workspaceRoot,
      pairingToken,
      modelWorkerEntry: probeWorker,
    });
    const paired = await node.waitFor(/MATE_NODE_PAIRED ([0-9a-f-]+)/i);

    // One web request creates the Agent. No root, no Linux account, no service manager.
    const first = agentPayload(),
      firstResponse = await createAgent(origin, cookie, paired[1]!, first);
    expect(firstResponse.status).toBe(201);
    const created = (await firstResponse.json()) as {
      agent: {
        id: string;
        status: string;
        stage: string;
        sessionId: string;
        linuxIdentity: { username: string; uid: number; gid: number; workspace: string } | null;
      };
    };
    expect(created.agent.id).toBe(first.id);
    expect(created.agent.linuxIdentity).not.toBeNull();
    // The web reaches a runnable state without credentials configured yet, so the owner sees the
    // Agent as created and only owed a provider key.
    expect(["waiting_credentials", "ready"]).toContain(created.agent.status);
    expect(created.agent.stage).toBe("complete");
    const firstIdentity = created.agent.linuxIdentity!,
      firstWorkspace = join(workspaceRoot, first.id);
    expect(firstIdentity.workspace).toBe(firstWorkspace);
    expect(lstatSync(firstWorkspace).isDirectory()).toBe(true);
    expect((lstatSync(firstWorkspace).mode & 0o777).toString(8)).toBe("700");
    const firstMemory = join(firstWorkspace, "MEMORY.md");
    expect(readFileSync(firstMemory, "utf8")).toContain("memory");
    expect((lstatSync(firstMemory).mode & 0o777).toString(8)).toBe("600");
    // The account is the process account: Mate never created a per-Agent user.
    expect(firstIdentity.username.length).toBeGreaterThan(0);
    if (typeof process.getuid === "function") expect(firstIdentity.uid).toBe(process.getuid());
    if (typeof process.getgid === "function") expect(firstIdentity.gid).toBe(process.getgid());

    // A retried creation request is idempotent: same Agent, session, workspace and marker.
    const retriedResponse = await createAgent(origin, cookie, paired[1]!, first);
    expect(retriedResponse.status).toBe(200);
    const retried = (await retriedResponse.json()) as typeof created;
    expect(retried.agent.sessionId).toBe(created.agent.sessionId);
    expect(retried.agent.linuxIdentity).toEqual(firstIdentity);
    writeFileSync(join(firstWorkspace, "notes.md"), "kept across a retry\n");
    const afterRetry = await createAgent(origin, cookie, paired[1]!, first);
    expect(afterRetry.status).toBe(200);
    expect(readFileSync(join(firstWorkspace, "notes.md"), "utf8")).toBe("kept across a retry\n");

    // A second Agent gets its own ID, workspace and session under the same account.
    const second = agentPayload({ name: "第二名同事" }),
      secondResponse = await createAgent(origin, cookie, paired[1]!, second);
    expect(secondResponse.status).toBe(201);
    const secondCreated = (await secondResponse.json()) as typeof created;
    expect(secondCreated.agent.id).toBe(second.id);
    expect(secondCreated.agent.sessionId).not.toBe(created.agent.sessionId);
    const secondIdentity = secondCreated.agent.linuxIdentity!;
    expect(secondIdentity.workspace).toBe(join(workspaceRoot, second.id));
    expect(secondIdentity.workspace).not.toBe(firstIdentity.workspace);
    // Same Linux account for the control plane, the node and both Agents' work.
    expect({
      username: secondIdentity.username,
      uid: secondIdentity.uid,
      gid: secondIdentity.gid,
    }).toEqual({
      username: firstIdentity.username,
      uid: firstIdentity.uid,
      gid: firstIdentity.gid,
    });

    // The owner's first direct message to the new Agent must produce one authorized model run.
    const direct = await fetch(new URL(`/api/owner/agents/${first.id}/direct-channel`, origin), {
      method: "POST",
      headers: { cookie },
    });
    expect(direct.status).toBe(200);
    const channelId = ((await direct.json()) as { channel: { id: string } }).channel.id;
    const credential = await fetch(new URL("/api/owner/model-credentials/openai", origin), {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "synthetic-key-version-a" }),
    });
    expect(credential.status).toBe(204);

    const sent = await fetch(new URL(`/api/owner/channels/${channelId}/messages`, origin), {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "请处理这条私信并说明结论。" }),
    });
    expect(sent.status).toBe(201);
    const firstRuns = await waitForRun(directory, first.id, 1);
    // The node was authorized to run this Agent's one logical session, as the protocol shows.
    const firstStart = observer.starts.find((start) => start.agentId === first.id);
    expect(firstStart?.sessionId).toBe(created.agent.sessionId);
    expect(firstStart?.runId).toBe(firstRuns[0]!.id);
    await waitForRunStatus(directory, firstRuns[0]!.id, "completed");
    // The model subprocess reports the account it really ran under, recorded in this Agent's own
    // session record: the same ordinary account as the control plane and the node, with no root.
    const workerAccount = modelWorkerAccount(directory, firstRuns[0]!.id);
    if (typeof process.getuid === "function") expect(workerAccount.uid).toBe(process.getuid());
    if (typeof process.getgid === "function") expect(workerAccount.gid).toBe(process.getgid());
    expect(workerAccount.uid).toBe(firstIdentity.uid);
    expect(workerAccount.gid).toBe(firstIdentity.gid);
    expect(workerAccount.execPath).toBe(process.execPath);
    expect(workerAccount.pid).toBeGreaterThan(0);
    const messages = (await (
      await fetch(new URL(`/api/owner/channels/${channelId}/messages`, origin), {
        headers: { cookie },
      })
    ).json()) as { messages: Array<{ author: { kind: string } }> };
    expect(messages.messages.filter((message) => message.author.kind === "agent")).toHaveLength(0);
    // The second Agent has no run at all: one Agent's DM never starts another Agent's run.
    expect(agentRuns(directory, second.id)).toHaveLength(0);

    // Restarting the control plane keeps this Agent's identity, workspace and one logical session.
    const priorControl = control;
    await stopProcess(priorControl);
    control = undefined;
    const restarted = await startControlPlane(directory);
    control = restarted.process;
    const restartedOrigin = restarted.origin,
      restartedCookie = await login(restartedOrigin);
    // The relay keeps its address; it now forwards the still-running node to the new process.
    observer.setOrigin(restartedOrigin);
    await waitForNodeOnline(restartedOrigin, restartedCookie, paired[1]!);

    // Now restart the node too. It must re-authenticate with its stored identity, adopt the same
    // workspaces from disk, and continue the same logical session instead of creating new ones.
    await stopProcess(node);
    node = startNode({
      origin: nodeOrigin,
      nodeData,
      workspaceRoot,
      modelWorkerEntry: probeWorker,
    });
    const reconnected = await node.waitFor(/MATE_NODE_CONNECTED ([0-9a-f-]+)/i);
    expect(reconnected[1]).toBe(paired[1]);
    await waitForNodeOnline(restartedOrigin, restartedCookie, paired[1]!);
    const listed = (await (
      await fetch(new URL("/api/owner/agents", restartedOrigin), {
        headers: { cookie: restartedCookie },
      })
    ).json()) as { agents: Array<{ id: string; sessionId: string; linuxIdentity: unknown }> };
    const afterRestart = listed.agents.find((agent) => agent.id === first.id);
    expect(afterRestart?.sessionId).toBe(created.agent.sessionId);
    expect(afterRestart?.linuxIdentity).toEqual(firstIdentity);
    const runsAfterRestart = agentRuns(directory, first.id);
    expect(runsAfterRestart).toHaveLength(1);
    expect(runsAfterRestart[0]!.id).toBe(firstRuns[0]!.id);
    // The same Agent still owns exactly one session record after both restarts, and no extra run
    // was authorized: reconnecting is not a second run.
    expect(agentSessions(directory, first.id)).toEqual([created.agent.sessionId]);
    expect(observer.starts).toHaveLength(1);
    // Exactly one Agent was created; the restart neither re-created nor duplicated either Agent.
    expect(listed.agents.map((agent) => agent.id).sort()).toEqual([first.id, second.id].sort());

    // The next message after both restarts resumes the same logical session.
    const resumed = await fetch(
      new URL(`/api/owner/channels/${channelId}/messages`, restartedOrigin),
      {
        method: "POST",
        headers: { cookie: restartedCookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "重启后继续处理这条私信。" }),
      },
    );
    expect(resumed.status).toBe(201);
    const secondRun = (await waitForRun(directory, first.id, 2)).find(
      (run) => run.id !== firstRuns[0]!.id,
    )!;
    const resumedStart = observer.starts.find((start) => start.runId === secondRun.id);
    expect(resumedStart?.sessionId).toBe(created.agent.sessionId);
    await waitForRunStatus(directory, secondRun.id, "completed");
    const resumedWorker = modelWorkerAccount(directory, secondRun.id);
    expect(resumedWorker.uid).toBe(workerAccount.uid);
    expect(resumedWorker.gid).toBe(workerAccount.gid);
    expect(resumedWorker.pid).not.toBe(workerAccount.pid);
    expect(agentSessions(directory, first.id)).toEqual([created.agent.sessionId]);
    expect(Date.now() - startedAt).toBeLessThan(60_000);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : "unknown failure"}\nControl plane log tail: ${control?.text.slice(-1500) ?? "unavailable"}\nNode log tail: ${node?.text.slice(-1500) ?? "unavailable"}\nObserver starts: ${JSON.stringify(observer.starts)}`,
    );
  } finally {
    if (node) await stopProcess(node);
    if (control) await stopProcess(control);
    await observer.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);
