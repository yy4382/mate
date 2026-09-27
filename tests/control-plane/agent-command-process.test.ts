import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

const ownerPassword = "agent-command-process-owner-password";
const commandTimeoutMs = 700;

/** Real subprocess output, so the test waits on what the services really printed. */
class ProcessOutput {
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

async function stopProcess(output: ProcessOutput | undefined): Promise<void> {
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

async function eventually<T>(
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

async function login(origin: string): Promise<string> {
  const response = await fetch(new URL("/api/auth/login", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: ownerPassword }),
  });
  expect(response.status).toBe(204);
  return response.headers.get("set-cookie")!.split(";", 1)[0]!;
}

function startControlPlane(directory: string): ProcessOutput {
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
  return new ProcessOutput(child);
}

/**
 * The deployment node entry, with the real workspace provisioning and the real ordinary-command
 * ledger, and one scripted model worker instead of a provider stream. Only the command time bound
 * is shortened so a timeout can be observed inside one test.
 */
function startNode(options: {
  origin: string;
  nodeData: string;
  workspaceRoot: string;
  pairingToken?: string;
  modelWorkerEntry: string;
}): ProcessOutput {
  const clientModule = pathToFileURL(resolve("dist/src/nodes/client.js")).href,
    runtimeModule = pathToFileURL(resolve("dist/src/nodes/process-operation-runtime.js")).href,
    runner = `
      const { runLinuxNodeWithTestDependencies } = await import(${JSON.stringify(clientModule)});
      const { openNodeProcessOperations } = await import(${JSON.stringify(runtimeModule)});
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
        MATE_COMMAND_TIMEOUT_MS: String(commandTimeoutMs),
        ...(options.pairingToken ? { MATE_NODE_PAIRING_TOKEN: options.pairingToken } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function controlPlaneDatabase(directory: string): Database.Database {
  return new Database(join(directory, "control-plane-data", "control-plane.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
}

/** The newest plain assistant turn of one run: this is what the Agent recorded for itself. */
function sessionTurnText(directory: string, runId: string): string | undefined {
  const db = controlPlaneDatabase(directory);
  try {
    const row = db
      .prepare(
        `SELECT text FROM owner_agent_session_journal
         WHERE run_id=? AND role='assistant' AND tool_action_id IS NULL
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(runId) as { text: string } | undefined;
    return row?.text;
  } finally {
    db.close();
  }
}

function processOperation(directory: string, agentId: string): Record<string, unknown> | undefined {
  const db = controlPlaneDatabase(directory);
  try {
    return db
      .prepare(
        `SELECT operation_id,state,receipt_json FROM owner_agent_process_operations
         WHERE agent_id=? ORDER BY created_at LIMIT 1`,
      )
      .get(agentId) as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}

interface AgentPayload {
  id: string;
  name: string;
  role: string;
  description: string;
  model: { provider: string; id: string };
}

async function createAgent(
  origin: string,
  cookie: string,
  nodeId: string,
): Promise<AgentPayload & { linuxIdentity: { workspace: string } }> {
  const payload: AgentPayload = {
    id: randomUUID(),
    name: "命令执行同事",
    role: "运行普通命令",
    description: "Synthetic ordinary command fixture.",
    model: { provider: "openai", id: "gpt-4o-mini" },
  };
  const response = await fetch(new URL("/api/owner/agents", origin), {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ...payload, nodeId }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    agent: AgentPayload & { linuxIdentity: { workspace: string }; status: string };
  };
  return body.agent;
}

async function startAgentRun(
  origin: string,
  cookie: string,
  agentId: string,
  apiKey: string,
): Promise<string> {
  const credential = await fetch(new URL("/api/owner/model-credentials/openai", origin), {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  expect(credential.status).toBe(204);
  const channel = (await (
    await fetch(new URL(`/api/owner/agents/${agentId}/direct-channel`, origin), {
      method: "POST",
      headers: { cookie },
    })
  ).json()) as { channel: { id: string } };
  const message = await fetch(
    new URL(`/api/owner/channels/${channel.channel.id}/messages`, origin),
    {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "按脚本执行普通命令。" }),
    },
  );
  expect(message.ok).toBe(true);
  return channel.channel.id;
}

function firstRunId(directory: string, agentId: string, state: string): string | undefined {
  const db = controlPlaneDatabase(directory);
  try {
    const row = db
      .prepare(
        "SELECT id FROM owner_agent_runs WHERE agent_id=? AND state=? ORDER BY started_at LIMIT 1",
      )
      .get(agentId, state) as { id: string } | undefined;
    return row?.id;
  } finally {
    db.close();
  }
}

it("runs an Agent's ordinary commands as the launching account and reports every real result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-command-process-")),
    nodeData = join(directory, "node-data"),
    workspaceRoot = join(directory, "agent-workspaces");
  chmodSync(directory, 0o700);
  writeFileSync(join(directory, "owner-password"), `${ownerPassword}\n`, { mode: 0o600 });
  let control: ProcessOutput | undefined, node: ProcessOutput | undefined;
  try {
    control = startControlPlane(directory);
    const origin = `http://127.0.0.1:${(await control.waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/))[1]}`,
      cookie = await login(origin);
    const pairing = (await (
      await fetch(new URL("/api/owner/nodes/pairing-tokens", origin), {
        method: "POST",
        headers: { cookie },
      })
    ).json()) as { pairingToken: string };
    node = startNode({
      origin,
      nodeData,
      workspaceRoot,
      pairingToken: pairing.pairingToken,
      modelWorkerEntry: resolve("tests/fixtures/direct-message-model-worker.mjs"),
    });
    const nodeId = (await node.waitFor(/MATE_NODE_PAIRED ([0-9a-f-]+)/i))[1]!;
    const agent = await createAgent(origin, cookie, nodeId),
      workspace = agent.linuxIdentity.workspace;
    await startAgentRun(origin, cookie, agent.id, "synthetic-key-ordinary-commands");
    const runId = await eventually(
      () => firstRunId(directory, agent.id, "completed"),
      "the Agent run to finish",
    ).catch((error: unknown) => {
      // A failed run leaves its reason in the control plane, not in the node's standard output.
      const db = controlPlaneDatabase(directory);
      let runs: unknown;
      try {
        runs = db
          .prepare("SELECT state,error_code FROM owner_agent_runs WHERE agent_id=?")
          .all(agent.id);
      } finally {
        db.close();
      }
      throw new Error(
        `${String(error)} runs=${JSON.stringify(runs)} node=${node!.text.replace(/^MATE_NODE_(HEARTBEAT_ACK|CONNECTED).*$/gm, "").slice(0, 400)}`,
      );
    });
    const reported = JSON.parse(
      (await eventually(
        () => sessionTurnText(directory, runId),
        "the Agent's own record of the command results",
      ))!,
    ) as {
      results: Array<{
        state: string;
        code: number | null;
        signal: string | null;
        timedOut: boolean | null;
        truncated: boolean | null;
        cwd: string | undefined;
        stdoutHead: string | null;
        stdoutLength: number | null;
        stderr: string | null;
      }>;
    };

    // The state-changing command ran once, in the Agent's own workspace, as this account.
    expect(readFileSync(join(workspace, "ledger.txt"), "utf8")).toBe("once\n");
    const uid = typeof process.getuid === "function" ? process.getuid() : 0,
      success = reported.results[0]!;
    expect(success.state).toBe("succeeded");
    expect(success.cwd).toBe(workspace);
    expect(success.stdoutHead).toBe(`hello${uid}\n`);
    expect(success.stdoutLength).toBe(`hello${uid}\n`.length);

    // A failing command keeps its own exit code and stderr.
    expect(reported.results[1]).toMatchObject({
      state: "failed",
      code: 9,
      stderr: "boom",
      timedOut: false,
    });

    // Output past Mate's capture limit is reported as truncated, never as the whole result.
    expect(reported.results[2]).toMatchObject({
      state: "succeeded",
      truncated: true,
      stdoutLength: 65_536,
    });

    // A command past its time bound is reported as a timeout with the signal that ended it.
    expect(reported.results[3]).toMatchObject({
      state: "failed",
      code: null,
      signal: "SIGKILL",
      timedOut: true,
    });

    // The owner's activity record carries the same receipts, not a rosier summary.
    const activity = (await (
      await fetch(new URL(`/api/owner/agents/${agent.id}/activity?detail=1`, origin), {
        headers: { cookie },
      })
    ).json()) as {
      events: Array<{ kind: string; detail?: { state?: string; receipt?: unknown } }>;
    };
    const finished = activity.events.filter((event) => event.kind === "operation.finished");
    expect(finished).toHaveLength(4);
    expect(
      finished.some(
        (event) =>
          (event.detail?.receipt as { timedOut?: boolean } | undefined)?.timedOut === true &&
          event.detail?.state === "failed",
      ),
    ).toBe(true);
    expect(
      finished.some(
        (event) =>
          (event.detail?.receipt as { truncated?: boolean } | undefined)?.truncated === true,
      ),
    ).toBe(true);
  } finally {
    await stopProcess(node);
    await stopProcess(control);
    rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);

it("does not run a state-changing command twice when its lost receipt is retried", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-command-recovery-")),
    nodeData = join(directory, "node-data"),
    workspaceRoot = join(directory, "agent-workspaces");
  chmodSync(directory, 0o700);
  writeFileSync(join(directory, "owner-password"), `${ownerPassword}\n`, { mode: 0o600 });
  let control: ProcessOutput | undefined, node: ProcessOutput | undefined;
  let origin = "",
    dropped = false;
  const proxyHttp = createServer(),
    proxyWs = new WebSocketServer({ noServer: true }),
    sockets = new Set<WebSocket>();
  // The proxy exists for one reason: the node's receipt for the command must never reach the
  // control plane, so the command's result is genuinely lost and only the node's durable record
  // can settle it.
  proxyHttp.on("upgrade", (request, network, head) => {
    proxyWs.handleUpgrade(request, network, head, (downstream) => {
      const upstream = new WebSocket(origin.replace(/^http/, "ws") + "/api/nodes/connect");
      sockets.add(downstream);
      sockets.add(upstream);
      downstream.on("message", (data, binary) => {
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type === "node.process.operation.result" && !dropped) {
          dropped = true;
          downstream.terminate();
          upstream.terminate();
          return;
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      });
      upstream.on("message", (data, binary) => {
        if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary });
      });
      downstream.on("close", () => {
        sockets.delete(downstream);
        upstream.terminate();
      });
      upstream.on("close", () => {
        sockets.delete(upstream);
        downstream.terminate();
      });
      upstream.on("error", () => upstream.terminate());
    });
  });
  await new Promise<void>((done) => proxyHttp.listen(0, "127.0.0.1", () => done()));
  const proxyPort = (proxyHttp.address() as { port: number }).port;
  try {
    control = startControlPlane(directory);
    origin = `http://127.0.0.1:${(await control.waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/))[1]}`;
    let cookie = await login(origin);
    const pairing = (await (
      await fetch(new URL("/api/owner/nodes/pairing-tokens", origin), {
        method: "POST",
        headers: { cookie },
      })
    ).json()) as { pairingToken: string };
    node = startNode({
      origin: `http://127.0.0.1:${proxyPort}`,
      nodeData,
      workspaceRoot,
      pairingToken: pairing.pairingToken,
      modelWorkerEntry: resolve("tests/fixtures/direct-message-model-worker.mjs"),
    });
    const nodeId = (await node.waitFor(/MATE_NODE_PAIRED ([0-9a-f-]+)/i))[1]!;
    const agent = await createAgent(origin, cookie, nodeId),
      workspace = agent.linuxIdentity.workspace,
      ledger = join(workspace, "ledger.txt");
    await startAgentRun(origin, cookie, agent.id, "synthetic-key-ordinary-command-recovery");

    // The command really ran on the host before its receipt was lost.
    await eventually(() => {
      try {
        return readFileSync(ledger, "utf8").includes("executed") ? true : undefined;
      } catch {
        return undefined;
      }
    }, "the host side effect");
    await eventually(() => (dropped ? true : undefined), "the dropped node receipt");
    await eventually(
      () => (processOperation(directory, agent.id)?.state === "unknown" ? true : undefined),
      "the control plane's unknown result",
    );

    // Restart the control plane. The node keeps running with its durable operation record and
    // must settle the same operation ID from that record when it reconnects.
    await stopProcess(control);
    control = startControlPlane(directory);
    origin = `http://127.0.0.1:${(await control.waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/))[1]}`;
    cookie = await login(origin);
    await eventually(
      () => (processOperation(directory, agent.id)?.state === "succeeded" ? true : undefined),
      "the reconciled node receipt",
    );
    const operation = processOperation(directory, agent.id)!;
    expect(JSON.parse(String(operation.receipt_json))).toMatchObject({ code: 0 });
    await eventually(
      () => (firstRunId(directory, agent.id, "completed") ? true : undefined),
      "the recovered Agent run",
    );
    // The recovered run asks for the same durable action again; the reused receipt means exactly
    // one line ever reached the ledger, and the Agent received that receipt rather than a re-run.
    expect(readFileSync(ledger, "utf8").trimEnd().split("\n")).toEqual(["executed"]);
    const db = controlPlaneDatabase(directory);
    let operationRows: Array<{ operation_id: string }>,
      agentReceipts: Array<{ tool_action_id: string }>;
    try {
      operationRows = db
        .prepare("SELECT operation_id FROM owner_agent_process_operations WHERE agent_id=?")
        .all(agent.id) as Array<{ operation_id: string }>;
      agentReceipts = db
        .prepare(
          `SELECT tool_action_id FROM owner_agent_session_journal
           WHERE agent_id=? AND process_operation_id=? ORDER BY rowid`,
        )
        .all(agent.id, operation.operation_id) as Array<{ tool_action_id: string }>;
    } finally {
      db.close();
    }
    expect(operationRows).toEqual([{ operation_id: operation.operation_id }]);
    expect(agentReceipts.map((row) => row.tool_action_id)).toContain(
      `${String(operation.operation_id)}:succeeded`,
    );
    const activity = (await (
      await fetch(new URL(`/api/owner/agents/${agent.id}/activity?detail=1`, origin), {
        headers: { cookie },
      })
    ).json()) as { events: Array<{ kind: string; detail?: { receipt?: unknown } }> };
    expect(activity.events.some((event) => event.kind === "operation.started")).toBe(true);
    expect(readFileSync(ledger, "utf8").trimEnd().split("\n")).toEqual(["executed"]);
  } finally {
    await stopProcess(node);
    await stopProcess(control);
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((done) => proxyWs.close(() => done()));
    await new Promise<void>((done) => proxyHttp.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);
