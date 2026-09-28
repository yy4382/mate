import { spawn, type ChildProcess } from "node:child_process";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";

const ownerPassword = "agent-run-process-owner-password";

interface StartedAgentRun {
  runId: string;
  channelId: string;
  sessionId: string;
}

interface InspectedPiMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

interface InspectedPiContext {
  systemPrompt: string;
  messages: InspectedPiMessage[];
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

  waitFor(pattern: RegExp, timeoutMs = 8000): Promise<RegExpMatchArray> {
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

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 8000): Promise<T> {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => {
      throw new Error(`Timed out waiting for ${label}`);
    }),
  ]);
}

async function waitForStartedRun(
  runs: StartedAgentRun[],
  channelId: string,
  fromIndex: number,
): Promise<StartedAgentRun> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const run = runs.slice(fromIndex).find((candidate) => candidate.channelId === channelId);
    if (run) return run;
    await delay(10);
  }
  throw new Error("Expected an Agent run for the selected source channel");
}

function inspectedContent(message: InspectedPiMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
      MATE_CONTROL_PLANE_DATA_DIR: joinPath(directory, "control-plane-data"),
      MATE_OWNER_PASSWORD_FILE: joinPath(directory, "owner-password"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = new ProcessOutput(child);
  const port = await output
    .waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/)
    .then((match) => match[1]!);
  return { process: output, origin: `http://127.0.0.1:${port}` };
}

function joinPath(...parts: string[]): string {
  return resolve(...parts);
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

async function putCredential(origin: string, cookie: string, key: string): Promise<number> {
  const response = await fetch(new URL("/api/owner/model-credentials/openai", origin), {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: key }),
  });
  return response.status;
}

async function deleteCredential(origin: string, cookie: string): Promise<number> {
  return (
    await fetch(new URL("/api/owner/model-credentials/openai", origin), {
      method: "DELETE",
      headers: { cookie },
    })
  ).status;
}

async function getMessages(origin: string, cookie: string, channelId: string) {
  const response = await fetch(new URL(`/api/owner/channels/${channelId}/messages`, origin), {
    headers: { cookie },
  });
  if (!response.ok) throw new Error("Could not read the test owner DM");
  return (await response.json()) as {
    messages: Array<{ author: { kind: string; id: string }; text: string }>;
  };
}

/**
 * Read the private turn a run recorded in its own Agent session record. A run's plain model output
 * never becomes an owner-visible message, so this is the only place its text can be observed.
 */
async function waitForTranscript(directory: string, runId: string): Promise<string> {
  const deadline = Date.now() + 8000,
    dbPath = joinPath(directory, "control-plane-data", "control-plane.sqlite");
  while (Date.now() < deadline) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare(
          "SELECT json_extract(payload_json,'$.message.content[0].text') AS text FROM owner_agent_session_records WHERE run_id=? AND json_extract(payload_json,'$.message.role')='assistant'",
        )
        .get(runId) as { text: string } | undefined;
      if (row) return row.text;
    } finally {
      db.close();
    }
    await delay(25);
  }
  throw new Error("The model run did not record a private transcript");
}

function agentMessages(
  messages: Array<{ author: { kind: string; id: string }; text: string }>,
): Array<{ author: { kind: string; id: string }; text: string }> {
  return messages.filter((message) => message.author.kind === "agent");
}

async function waitForMessageCount(
  origin: string,
  cookie: string,
  channelId: string,
  count: number,
): Promise<Array<{ author: { kind: string; id: string }; text: string }>> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const messages = (await getMessages(origin, cookie, channelId)).messages;
    if (messages.length >= count) return messages;
    await delay(25);
  }
  throw new Error("Expected owner DM and Agent reply count was not reached");
}

it("runs Pi conversation tools through the authenticated Node and commits one explicit Agent message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-tools-process-"));
  chmodSync(directory, 0o700);
  const passwordFile = joinPath(directory, "owner-password"),
    nodeData = joinPath(directory, "node-data"),
    agentHomeRoot = joinPath(directory, "agent-home");
  writeFileSync(passwordFile, `${ownerPassword}\n`, { mode: 0o600 });
  mkdirSync(agentHomeRoot, { mode: 0o700 });
  let control: ProcessOutput | undefined, node: ProcessOutput | undefined;
  try {
    control = (await startControlPlane(directory)).process;
    const currentOrigin = await control
        .waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/)
        .then((match) => `http://127.0.0.1:${match[1]}`),
      cookie = await login(currentOrigin),
      pairingResponse = await fetch(new URL("/api/owner/nodes/pairing-tokens", currentOrigin), {
        method: "POST",
        headers: { cookie },
      });
    expect(pairingResponse.status).toBe(201);
    const pairing = (await pairingResponse.json()) as { pairingToken: string },
      nodeModule = pathToFileURL(resolve("dist/src/nodes/client.js")).href,
      fixture = resolve("tests/fixtures/direct-message-model-worker.mjs"),
      nodeRunner = `
        const { runLinuxNodeWithTestDependencies } = await import(${JSON.stringify(nodeModule)});
        const controller = new AbortController();
        await runLinuxNodeWithTestDependencies({
          controlPlaneUrl: process.env.MATE_CONTROL_PLANE_URL,
          dataDirectory: process.env.MATE_NODE_DATA_DIR,
          agentWorkspaceRoot: process.env.MATE_AGENT_HOME_ROOT,
          pairingToken: process.env.MATE_NODE_PAIRING_TOKEN,
          heartbeatIntervalMs: 100,
          heartbeatTimeoutMs: 2000,
        }, controller.signal, {
          modelWorkerEntry: ${JSON.stringify(fixture)},
          prepareAgentWorkspace: async (agentId) => ({
            username: 'mate-node-account',
            uid: 24001,
            gid: 24001,
            workspace: ${JSON.stringify(agentHomeRoot)} + '/' + agentId,
            workspaceMarker: 'a'.repeat(64),
          }),
        });
      `;
    node = new ProcessOutput(
      spawn(process.execPath, ["--input-type=module", "--eval", nodeRunner], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: "C.UTF-8",
          MATE_CONTROL_PLANE_URL: currentOrigin,
          MATE_NODE_DATA_DIR: nodeData,
          MATE_AGENT_HOME_ROOT: agentHomeRoot,
          MATE_NODE_PAIRING_TOKEN: pairing.pairingToken,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    const paired = await node.waitFor(/MATE_NODE_PAIRED ([0-9a-f-]+)/i),
      agentResponse = await fetch(new URL("/api/owner/agents", currentOrigin), {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          id: randomUUID(),
          nodeId: paired[1],
          name: "工具回环同事",
          role: "使用对话工具",
          description: "Synthetic end-to-end tool test.",
          model: { provider: "openai", id: "gpt-4o-mini" },
        }),
      });
    expect(agentResponse.status).toBe(201);
    const created = (await agentResponse.json()) as { agent: { id: string } },
      agentId = created.agent.id,
      directResponse = await fetch(
        new URL(`/api/owner/agents/${agentId}/direct-channel`, currentOrigin),
        { method: "POST", headers: { cookie } },
      );
    expect(directResponse.status).toBe(200);
    const direct = (await directResponse.json()) as { channel: { id: string } };
    expect(await putCredential(currentOrigin, cookie, "synthetic-key-conversation-tools")).toBe(
      204,
    );
    const input = await fetch(
      new URL(`/api/owner/channels/${direct.channel.id}/messages`, currentOrigin),
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "发现工具，发送一条消息，再完成本次回复。" }),
      },
    );
    expect(input.status).toBe(201);
    const messages = await waitForMessageCount(currentOrigin, cookie, direct.channel.id, 2);
    // Only the explicit messages.send call publishes; the final plain turn stays private.
    expect(messages).toMatchObject([
      { author: { kind: "human" }, text: "发现工具，发送一条消息，再完成本次回复。" },
      { author: { kind: "agent", id: agentId }, text: "Pi 工具经控制面发送的消息。" },
    ]);

    const deadline = Date.now() + 5000;
    let runState: string | undefined;
    const dbPath = joinPath(directory, "control-plane-data", "control-plane.sqlite");
    while (Date.now() < deadline && runState !== "completed") {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const run = db
          .prepare(
            "SELECT state FROM owner_agent_runs WHERE agent_id=? ORDER BY started_at DESC LIMIT 1",
          )
          .get(agentId) as { state: string } | undefined;
        runState = run?.state;
      } finally {
        db.close();
      }
      if (runState !== "completed") await delay(25);
    }
    expect(runState).toBe("completed");
    const finalTurn = databaseTranscriptEntries(directory, agentId).find(
      (entry) => entry.role === "assistant" && entry.text === "工具调用完成后生成的最终回复。",
    );
    expect(finalTurn?.role).toBe("assistant");
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const actions = db
        .prepare(
          `SELECT tool.action_id,tool.operation,tool.agent_id,delivery.id AS delivery_id
           FROM owner_agent_tool_actions tool
           JOIN owner_agent_runs run ON run.agent_id=tool.agent_id AND run.state='completed'
           JOIN owner_message_deliveries delivery ON delivery.id=run.delivery_id
           WHERE tool.agent_id=?`,
        )
        .all(agentId) as Array<{
        action_id: string;
        operation: string;
        agent_id: string;
        delivery_id: string;
      }>;
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ operation: "messages.send", agent_id: agentId });
      expect(actions[0]?.action_id).toMatch(
        new RegExp(`^mate:${actions[0]?.delivery_id}:[0-9a-f]{64}:1$`),
      );
    } finally {
      db.close();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown test failure";
    const debugDb = new Database(
      joinPath(directory, "control-plane-data", "control-plane.sqlite"),
      {
        readonly: true,
        fileMustExist: true,
      },
    );
    let databaseDebug: unknown;
    try {
      databaseDebug = {
        runs: debugDb
          .prepare("SELECT id,state,error_code FROM owner_agent_runs ORDER BY started_at DESC")
          .all(),
        deliveries: debugDb
          .prepare(
            "SELECT recipient_id,channel_id,state FROM owner_message_deliveries WHERE recipient_kind='agent' ORDER BY seq",
          )
          .all(),
      };
    } finally {
      debugDb.close();
    }
    throw new Error(
      `Pi conversation-tool process test failed: ${detail}; db=${JSON.stringify(databaseDebug)}; control=${(control?.text ?? "").slice(-500)}; worker=${(
        node?.text ?? ""
      )
        .split("\n")
        .filter((line) => /Pi model worker failed|Error|Error:/i.test(line))
        .slice(-10)
        .join("\\n")}; node=${(node?.text ?? "").slice(-500)}`.replace(
        /synthetic-key-[\w-]+/g,
        "[redacted]",
      ),
    );
  } finally {
    if (node) await stopProcess(node);
    if (control) await stopProcess(control);
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);

function databaseState(directory: string): {
  pending: number;
  handled: number;
  failedRuns: number;
} {
  const db = new Database(joinPath(directory, "control-plane-data", "control-plane.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const delivery = db
        .prepare(
          "SELECT SUM(state='pending') AS pending,SUM(state='handled') AS handled FROM owner_message_deliveries WHERE recipient_kind='agent'",
        )
        .get() as { pending: number; handled: number } | undefined,
      runs = db
        .prepare("SELECT COUNT(*) AS count FROM owner_agent_runs WHERE state='failed'")
        .get() as { count: number };
    return {
      pending: delivery?.pending ?? 0,
      handled: delivery?.handled ?? 0,
      failedRuns: runs.count,
    };
  } finally {
    db.close();
  }
}

function databaseTranscriptEntries(
  directory: string,
  agentId: string,
): Array<{ sequence: number; role: string; text: string; channel_id: string }> {
  const db = new Database(joinPath(directory, "control-plane-data", "control-plane.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return db
      .prepare(
        "SELECT seq AS sequence,json_extract(payload_json,'$.message.role') AS role,json_extract(payload_json,'$.message.content[0].text') AS text,'' AS channel_id FROM owner_agent_session_records WHERE agent_id=? ORDER BY seq",
      )
      .all(agentId) as Array<{ sequence: number; role: string; text: string; channel_id: string }>;
  } finally {
    db.close();
  }
}

function databaseRunState(directory: string, runId: string): string | undefined {
  const db = new Database(joinPath(directory, "control-plane-data", "control-plane.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return (
      db.prepare("SELECT state FROM owner_agent_runs WHERE id=?").get(runId) as
        { state: string } | undefined
    )?.state;
  } finally {
    db.close();
  }
}

function databaseRunErrorCode(directory: string, runId: string): string | null | undefined {
  const db = new Database(joinPath(directory, "control-plane-data", "control-plane.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return (
      db.prepare("SELECT error_code FROM owner_agent_runs WHERE id=?").get(runId) as
        { error_code: string | null } | undefined
    )?.error_code;
  } finally {
    db.close();
  }
}

async function waitForRunState(directory: string, runId: string, state: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (databaseRunState(directory, runId) === state) return;
    await delay(25);
  }
  throw new Error("The model run did not reach the expected durable state");
}

async function waitForDatabaseState(
  directory: string,
  matches: (state: ReturnType<typeof databaseState>) => boolean,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (matches(databaseState(directory))) return;
    await delay(25);
  }
  throw new Error("The control-plane run state did not reach the expected recovery point");
}

async function waitForAuthenticatedConnections(
  expected: number,
  observed: () => number,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (observed() < expected && Date.now() < deadline) await delay(20);
  if (observed() < expected)
    throw new Error("Node did not reconnect after the control-plane restart");
}

function filesContain(directory: string, secrets: string[]): boolean {
  const walk = (path: string): boolean => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = joinPath(path, entry.name);
      if (entry.isDirectory()) {
        if (walk(child)) return true;
      } else if (entry.isFile()) {
        const content = readFileSync(child);
        if (secrets.some((secret) => content.includes(Buffer.from(secret)))) return true;
      }
    }
    return false;
  };
  return walk(directory);
}
