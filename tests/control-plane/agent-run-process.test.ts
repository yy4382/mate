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

async function waitForAssistant(
  origin: string,
  cookie: string,
  channelId: string,
): Promise<Array<{ author: { kind: string; id: string }; text: string }>> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const messages = (await getMessages(origin, cookie, channelId)).messages;
    if (messages.some((message) => message.author.kind === "agent")) return messages;
    await delay(25);
  }
  throw new Error("Agent did not publish a private DM reply");
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

async function readAgentReplyEvent(
  response: Response,
  agentId: string,
): Promise<{ author: { kind: string; id: string }; text: string }> {
  const reader = response.body!.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  try {
    return await Promise.race([
      (async () => {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("SSE stream closed before Agent reply event");
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const eventName = frame.match(/^event: (.+)$/m)?.[1],
              payloadText = frame.match(/^data: (.+)$/m)?.[1];
            if (eventName === "message.created" && payloadText) {
              const event = JSON.parse(payloadText) as {
                payload?: {
                  author?: { kind?: string; id?: string };
                  text?: string;
                };
              };
              const payload = event.payload;
              if (
                payload?.author?.kind === "agent" &&
                payload.author.id === agentId &&
                typeof payload.text === "string"
              )
                return {
                  author: { kind: payload.author.kind, id: payload.author.id },
                  text: payload.text,
                };
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
      })(),
      delay(20_000).then(() => {
        throw new Error("SSE did not deliver Agent reply event");
      }),
    ]);
  } finally {
    await reader.cancel();
  }
}

it("queues an owner DM, recovers it after node and control-plane restart, and waits for journal ACK", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-run-process-"));
  chmodSync(directory, 0o700);
  const passwordFile = joinPath(directory, "owner-password");
  writeFileSync(passwordFile, `${ownerPassword}\n`, { mode: 0o600 });
  const nodeData = joinPath(directory, "node-data"),
    agentHomeRoot = joinPath(directory, "agent-home");
  mkdirSync(agentHomeRoot, { mode: 0o700 });

  let currentOrigin = "",
    proxyConnections = 0,
    authenticatedConnections = 0,
    firstRunId = "",
    secondRunId = "",
    thirdRunId = "",
    fourthRunId = "",
    fifthRunId = "",
    sixthRunId = "",
    seventhRunId = "",
    eighthRunId = "",
    ninthRunId = "",
    tenthRunId = "",
    agentId = "",
    sharedChannelId = "",
    runSessionIds: string[] = [],
    oldJournal: string | undefined,
    secondJournal: string | undefined,
    secondJournalRequestId = "",
    variantRequestId = "",
    injectedStaleJournal = false,
    duplicatedJournal = false,
    heldSecondAck = false,
    releaseAck = false,
    secondAcknowledgements = 0,
    nodeResults = 0,
    credentialCancelCount = 0,
    recoveryChannelId = "",
    droppedRecoveryContext = false,
    storedAck: string | undefined;
  const runStarts: StartedAgentRun[] = [];
  const firstJournalDropped = deferred<void>(),
    secondRunStarted = deferred<void>(),
    duplicateJournalAcked = deferred<void>(),
    staleJournalRejected = deferred<void>(),
    variantJournalRejected = deferred<void>(),
    reconnectAuthenticated = deferred<void>(),
    secondNodeResult = deferred<void>(),
    completedReplayAcked = deferred<void>(),
    completedReplayAfterReconnectAcked = deferred<void>(),
    completedReplayVariantRejected = deferred<void>(),
    thirdRunStarted = deferred<void>(),
    credentialCancelSent = deferred<void>(),
    fourthRunStarted = deferred<void>();
  const recoveryContextDropped = deferred<void>(),
    recoveryRunIds: string[] = [],
    recoveryContextResponses: string[] = [];
  const fifthRunStarted = deferred<void>();
  const sixthRunStarted = deferred<void>();
  const seventhRunStarted = deferred<void>();
  const eighthRunStarted = deferred<void>();
  const ninthRunStarted = deferred<void>();
  const tenthRunStarted = deferred<void>();
  let completedReplaySent = false,
    completedReplayAckCount = 0,
    completedReplayAccepted: boolean | undefined,
    completedReplayVariantRequestId = "";
  const proxyHttp = createServer(),
    proxyServer = new WebSocketServer({ noServer: true }),
    nodeSockets = new Set<WebSocket>(),
    controlSockets = new Set<WebSocket>();
  proxyHttp.on("upgrade", (request, networkSocket, head) => {
    proxyServer.handleUpgrade(request, networkSocket, head, (nodeSocket) => {
      proxyConnections++;
      nodeSockets.add(nodeSocket);
      const upstream = new WebSocket(currentOrigin.replace(/^http/, "ws") + "/api/nodes/connect");
      controlSockets.add(upstream);
      let staleResultSent = false;
      nodeSocket.on("message", (data, binary) => {
        const text = rawText(data);
        let message: {
          type?: string;
          runId?: string;
          agentId?: string;
          channelId?: string;
          sessionId?: string;
          requestId?: string;
          [key: string]: unknown;
        };
        try {
          message = JSON.parse(text) as typeof message;
        } catch {
          return;
        }
        if (
          message.type === "node.agent.run.journal" &&
          message.runId === firstRunId &&
          !oldJournal
        ) {
          oldJournal = text;
          firstJournalDropped.resolve();
          nodeSocket.terminate();
          upstream.terminate();
          return;
        }
        if (message.type === "node.agent.run.journal" && message.runId === secondRunId) {
          secondJournal = text;
          secondJournalRequestId = String(message.requestId);
        }
        if (message.type === "node.agent.run.result" && message.runId === secondRunId) {
          nodeResults++;
          if (nodeResults === 1) secondNodeResult.resolve();
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(data, { binary });
            if (nodeResults === 1 && secondJournal) {
              // The completed run's exact journal is replayed after its result removed the
              // in-memory pending entry. This must be checked against the durable row.
              completedReplaySent = true;
              upstream.send(secondJournal);
            }
            if (!staleResultSent && firstRunId && agentId) {
              staleResultSent = true;
              upstream.send(text);
              upstream.send(
                JSON.stringify({
                  type: "node.agent.run.result",
                  requestId: randomUUID(),
                  runId: firstRunId,
                  agentId,
                  ok: true,
                }),
              );
            }
          }
          return;
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      });
      upstream.on("message", (data, binary) => {
        const text = rawText(data);
        let message: {
          type?: string;
          runId?: string;
          channelId?: string;
          sessionId?: string;
          requestId?: string;
          accepted?: boolean;
          reason?: string;
        };
        try {
          message = JSON.parse(text) as typeof message;
        } catch {
          return;
        }
        if (
          message.type === "control.agent.run.context" &&
          recoveryRunIds.includes(String(message.runId))
        ) {
          recoveryContextResponses.push(text);
          if (!droppedRecoveryContext) {
            droppedRecoveryContext = true;
            recoveryContextDropped.resolve();
            nodeSocket.terminate();
            upstream.terminate();
            return;
          }
        }
        if (message.type === "control.authenticated" || message.type === "control.paired") {
          authenticatedConnections++;
          if (authenticatedConnections >= 2) reconnectAuthenticated.resolve();
          if (message.type === "control.authenticated" && authenticatedConnections >= 4) {
            const latestNode = [...nodeSockets].find(
              (candidate) => candidate.readyState === WebSocket.OPEN,
            );
            if (secondJournal && latestNode && upstream.readyState === WebSocket.OPEN) {
              completedReplaySent = true;
              upstream.send(secondJournal);
            }
          }
        }
        if (message.type === "control.agent.run") {
          if (message.runId && message.channelId && message.sessionId)
            runStarts.push({
              runId: message.runId,
              channelId: message.channelId,
              sessionId: message.sessionId,
            });
          if (recoveryChannelId && message.channelId === recoveryChannelId && message.runId)
            recoveryRunIds.push(message.runId);
          if (message.sessionId) runSessionIds.push(message.sessionId);
          if (!firstRunId) firstRunId = String(message.runId);
          else if (!secondRunId) {
            secondRunId = String(message.runId);
            secondRunStarted.resolve();
            if (oldJournal && !injectedStaleJournal && upstream.readyState === WebSocket.OPEN) {
              injectedStaleJournal = true;
              upstream.send(oldJournal);
            }
          } else if (!thirdRunId) {
            thirdRunId = String(message.runId);
            thirdRunStarted.resolve();
          } else if (!fourthRunId) {
            fourthRunId = String(message.runId);
            fourthRunStarted.resolve();
          } else if (!fifthRunId) {
            fifthRunId = String(message.runId);
            fifthRunStarted.resolve();
          } else if (!sixthRunId) {
            sixthRunId = String(message.runId);
            sixthRunStarted.resolve();
          } else if (!seventhRunId) {
            seventhRunId = String(message.runId);
            seventhRunStarted.resolve();
          } else if (!eighthRunId) {
            eighthRunId = String(message.runId);
            eighthRunStarted.resolve();
          } else if (!ninthRunId) {
            ninthRunId = String(message.runId);
            ninthRunStarted.resolve();
          } else if (!tenthRunId) {
            tenthRunId = String(message.runId);
            tenthRunStarted.resolve();
          }
        }
        if (
          message.type === "control.agent.run.cancel" &&
          message.runId === thirdRunId &&
          message.reason === "credentials_changed"
        ) {
          credentialCancelCount++;
          credentialCancelSent.resolve();
        }
        if (
          message.type === "control.agent.run.journal_ack" &&
          message.runId === firstRunId &&
          message.accepted === false
        )
          staleJournalRejected.resolve();
        if (
          message.type === "control.agent.run.journal_ack" &&
          message.runId === secondRunId &&
          message.requestId === variantRequestId &&
          message.accepted === false
        )
          variantJournalRejected.resolve();
        if (
          message.type === "control.agent.run.journal_ack" &&
          message.runId === secondRunId &&
          message.requestId === secondJournalRequestId &&
          message.accepted
        ) {
          if (completedReplaySent && nodeResults > 0) {
            completedReplayAccepted = completedReplayAccepted ?? true;
            completedReplayAckCount++;
            if (completedReplayAckCount === 1) completedReplayAcked.resolve();
            else completedReplayAfterReconnectAcked.resolve();
            return;
          }
          secondAcknowledgements++;
          if (!duplicatedJournal && secondJournal && upstream.readyState === WebSocket.OPEN) {
            duplicatedJournal = true;
            upstream.send(secondJournal);
            return;
          }
          if (secondAcknowledgements >= 2) {
            duplicateJournalAcked.resolve();
            if (!variantRequestId && secondJournal && upstream.readyState === WebSocket.OPEN) {
              const variant = JSON.parse(secondJournal) as Record<string, unknown>;
              variantRequestId = randomUUID();
              upstream.send(
                JSON.stringify({
                  ...variant,
                  requestId: variantRequestId,
                  text: "变体内容不应获得已完成 run 的重放 ACK。",
                }),
              );
            }
            if (!releaseAck) {
              storedAck ??= text;
              heldSecondAck = true;
              return;
            }
          }
          if (heldSecondAck && releaseAck) {
            heldSecondAck = false;
            storedAck = undefined;
          }
        }
        if (
          message.type === "control.agent.run.journal_ack" &&
          message.runId === secondRunId &&
          message.requestId === completedReplayVariantRequestId &&
          message.accepted === false
        )
          completedReplayVariantRejected.resolve();
        if (heldSecondAck && !releaseAck && message.runId === secondRunId) {
          if (message.type === "control.agent.run.journal_ack" && message.accepted) {
            storedAck ??= text;
            return;
          }
        }
        if (nodeSocket.readyState === WebSocket.OPEN) {
          nodeSocket.send(data, { binary });
          if (message.type === "control.agent.run" && message.runId === fourthRunId && thirdRunId) {
            const lateCancel = JSON.stringify({
              type: "control.agent.run.cancel",
              requestId: randomUUID(),
              runId: thirdRunId,
              agentId,
              reason: "credentials_changed",
            });
            // A duplicate, delayed cancel for the previous run must not touch this one.
            nodeSocket.send(lateCancel);
            nodeSocket.send(lateCancel);
          }
        }
      });
      nodeSocket.on("close", () => {
        nodeSockets.delete(nodeSocket);
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)
          upstream.close();
      });
      upstream.on("close", () => {
        controlSockets.delete(upstream);
        if (
          nodeSocket.readyState === WebSocket.OPEN ||
          nodeSocket.readyState === WebSocket.CONNECTING
        )
          nodeSocket.close();
      });
      nodeSocket.on("error", () => upstream.close());
      upstream.on("error", () => nodeSocket.close());
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    proxyHttp.once("error", rejectListen);
    proxyHttp.listen(0, "127.0.0.1", () => {
      proxyHttp.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const proxyAddress = proxyHttp.address();
  if (!proxyAddress || typeof proxyAddress === "string")
    throw new Error("Test WebSocket proxy failed to bind");
  const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
  let control: ProcessOutput | undefined,
    node: ProcessOutput | undefined,
    cookie = "",
    channelId = "",
    stage = "starting control plane";

  try {
    control = (await startControlPlane(directory)).process;
    stage = "owner login and node pairing";
    currentOrigin = await control
      .waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/)
      .then((match) => `http://127.0.0.1:${match[1]}`);
    cookie = await login(currentOrigin);
    const sharedChannelResponse = await fetch(new URL("/api/owner/channels", currentOrigin), {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Research room",
        description: "Shared Agent context check",
        visibility: "private",
      }),
    });
    expect(sharedChannelResponse.status).toBe(201);
    sharedChannelId = ((await sharedChannelResponse.json()) as { id: string }).id;
    const pairingResponse = await fetch(new URL("/api/owner/nodes/pairing-tokens", currentOrigin), {
      method: "POST",
      headers: { cookie },
    });
    expect(pairingResponse.status).toBe(201);
    const pairing = (await pairingResponse.json()) as { pairingToken: string };
    const nodeModule = pathToFileURL(resolve("dist/src/nodes/client.js")).href,
      fixture = resolve("tests/fixtures/direct-message-model-worker.mjs"),
      homeRoot = agentHomeRoot;
    const nodeRunner = `
      const { runLinuxNodeWithTestDependencies } = await import(${JSON.stringify(nodeModule)});
      const controller = new AbortController();
      await runLinuxNodeWithTestDependencies({
        controlPlaneUrl: process.env.MATE_CONTROL_PLANE_URL,
        dataDirectory: process.env.MATE_NODE_DATA_DIR,
        agentHomeRoot: process.env.MATE_AGENT_HOME_ROOT,
        pairingToken: process.env.MATE_NODE_PAIRING_TOKEN,
        heartbeatIntervalMs: 100,
        heartbeatTimeoutMs: 2000,
      }, controller.signal, {
        modelWorkerEntry: ${JSON.stringify(fixture)},
        provisionAgent: async (agentId) => ({
          username: 'mate_' + agentId.replaceAll('-', '').slice(0, 27),
          uid: 24001,
          gid: 24001,
          home: ${JSON.stringify(homeRoot)} + '/' + agentId,
        }),
      });
    `;
    node = new ProcessOutput(
      spawn(process.execPath, ["--input-type=module", "--eval", nodeRunner], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: "C.UTF-8",
          MATE_CONTROL_PLANE_URL: proxyUrl,
          MATE_NODE_DATA_DIR: nodeData,
          MATE_AGENT_HOME_ROOT: agentHomeRoot,
          MATE_NODE_PAIRING_TOKEN: pairing.pairingToken,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    const paired = await node.waitFor(/MATE_NODE_PAIRED ([0-9a-f-]+)/i);
    stage = "Agent provisioning and owner DM creation";
    const createAgent = await fetch(new URL("/api/owner/agents", currentOrigin), {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        id: randomUUID(),
        nodeId: paired[1],
        name: "测试同事",
        role: "回复私信",
        description: "Synthetic process test Agent",
        model: { provider: "openai", id: "gpt-4o-mini" },
        initialChannelId: sharedChannelId,
      }),
    });
    expect(createAgent.status).toBe(201);
    const created = (await createAgent.json()) as { agent: { id: string; status: string } };
    agentId = created.agent.id;
    expect(created.agent.status).toBe("waiting_credentials");

    const directResponse = await fetch(
      new URL(`/api/owner/agents/${agentId}/direct-channel`, currentOrigin),
      { method: "POST", headers: { cookie } },
    );
    expect(directResponse.status).toBe(200);
    const direct = (await directResponse.json()) as { channel: { id: string; visibility: string } };
    expect(direct.channel.visibility).toBe("private");
    channelId = direct.channel.id;
    const sent = await fetch(new URL(`/api/owner/channels/${channelId}/messages`, currentOrigin), {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "请检查待办私信并给我回复。" }),
    });
    expect(sent.status).toBe(201);
    await delay(500);
    expect(firstRunId).toBe("");
    expect((await getMessages(currentOrigin, cookie, channelId)).messages).toHaveLength(1);

    expect(await putCredential(currentOrigin, cookie, "synthetic-key-version-a")).toBe(204);
    stage = "first worker journal and forced disconnect";
    await within(firstJournalDropped.promise, "first journal request");
    expect(oldJournal).toContain("这是首次测试回复。");
    expect((await getMessages(currentOrigin, cookie, channelId)).messages).toHaveLength(1);
    await waitForDatabaseState(directory, (state) => state.pending === 1 && state.failedRuns === 1);
    expect(await deleteCredential(currentOrigin, cookie)).toBe(204);

    stage = "node reconnection and credential revocation";
    await within(reconnectAuthenticated.promise, "node reconnect");
    await delay(1800);
    expect(secondRunId).toBe("");
    const priorControl = control;
    await stopProcess(priorControl!);
    control = undefined;
    // Restart against the same owner database; the node reconnects through the proxy.
    const restarted = await startControlPlane(directory);
    control = restarted.process;
    currentOrigin = restarted.origin;
    cookie = await login(currentOrigin);
    stage = "control-plane restart and node reconnection";
    await waitForAuthenticatedConnections(3, () => authenticatedConnections);

    // A restarted process must keep this already-provisioned Agent and its logical session.
    const afterRestart = await fetch(new URL("/api/owner/agents", currentOrigin), {
      headers: { cookie },
    });
    const agents = (await afterRestart.json()) as { agents: Array<{ id: string; status: string }> };
    expect(agents.agents.find((agent) => agent.id === agentId)?.status).toBe("waiting_credentials");
    const snapshotResponse = await fetch(new URL("/api/owner/snapshot", currentOrigin), {
      headers: { cookie },
    });
    const snapshot = (await snapshotResponse.json()) as { cursor: number };
    const eventStream = await fetch(
      new URL(`/api/owner/events?cursor=${snapshot.cursor}`, currentOrigin),
      { headers: { cookie } },
    );
    expect(eventStream.headers.get("content-type")).toContain("text/event-stream");
    const assistantEventPromise = readAgentReplyEvent(eventStream, agentId);
    expect(await putCredential(currentOrigin, cookie, "synthetic-key-version-b")).toBe(204);
    stage = "recovered model run and stale journal rejection";
    await within(secondRunStarted.promise, "second model run");
    await within(staleJournalRejected.promise, "old run journal rejection");

    // The first run's delayed journal is stale after disconnect/restart and must not commit.
    await delay(50);
    expect((await getMessages(currentOrigin, cookie, channelId)).messages).toHaveLength(1);
    expect(injectedStaleJournal).toBe(true);
    const secondRunReply = await waitForAssistant(currentOrigin, cookie, channelId);
    expect(await within(assistantEventPromise, "assistant reply SSE event", 25_000)).toMatchObject({
      author: { kind: "agent", id: agentId },
      text: "这是密钥更新后的测试回复。",
    });
    expect(secondRunReply.filter((message) => message.author.kind === "agent")).toMatchObject([
      { text: "这是密钥更新后的测试回复。" },
    ]);
    stage = "duplicate journal ACK barrier";
    await within(duplicateJournalAcked.promise, "duplicate journal ACK");
    await within(variantJournalRejected.promise, "changed journal rejection");
    expect(nodeResults).toBe(0);
    expect(secondRunReply).toHaveLength(2);
    expect(databaseState(directory).pending).toBe(0);
    expect(databaseState(directory).handled).toBe(1);

    releaseAck = true;
    if (storedAck && nodeSockets.size) {
      const ack = [...controlSockets].find((socket) => socket.readyState === WebSocket.OPEN);
      const nodeSocket = [...nodeSockets].find((socket) => socket.readyState === WebSocket.OPEN);
      if (ack && nodeSocket) {
        nodeSocket.send(storedAck);
        heldSecondAck = false;
        storedAck = undefined;
      }
    }
    await Promise.race([
      secondNodeResult.promise,
      delay(5000).then(() => {
        throw new Error("Node did not report its run result after journal ACK");
      }),
    ]);
    stage = "completed run exact journal replay after result";
    await within(completedReplayAcked.promise, "completed run exact journal replay ACK");
    expect(completedReplayAccepted).toBe(true);
    // Force a real node WebSocket reconnect, then replay the durable completed journal again.
    for (const socket of [...nodeSockets]) socket.terminate();
    for (const socket of [...controlSockets]) socket.terminate();
    await waitForAuthenticatedConnections(4, () => authenticatedConnections);
    await within(
      completedReplayAfterReconnectAcked.promise,
      "completed run replay after reconnect ACK",
    );
    await delay(50);
    const latest = [...controlSockets].find((socket) => socket.readyState === WebSocket.OPEN);
    if (latest && secondJournal) {
      const variant = JSON.parse(secondJournal) as Record<string, unknown>;
      completedReplayVariantRequestId = randomUUID();
      latest.send(
        JSON.stringify({
          ...variant,
          requestId: completedReplayVariantRequestId,
          text: "完成态重放的内容变体必须拒绝。",
        }),
      );
    }
    await within(completedReplayVariantRejected.promise, "completed run variant rejection");
    stage = "credential rotation cancels the held worker and retries the pending DM";
    stage = "configure a held worker credential before queuing its delivery";
    expect(await putCredential(currentOrigin, cookie, "synthetic-key-hold")).toBe(204);
    const secondOwnerMessage = await fetch(
      new URL(`/api/owner/channels/${channelId}/messages`, currentOrigin),
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "再检查一条需要继续处理的私信。" }),
      },
    );
    stage = "queue a second owner DM";
    expect(secondOwnerMessage.status).toBe(201);
    await within(thirdRunStarted.promise, "held model run start");
    await delay(100);
    stage = "held run preserves unacknowledged delivery";
    expect((await getMessages(currentOrigin, cookie, channelId)).messages).toHaveLength(3);
    expect(databaseState(directory)).toMatchObject({ pending: 1, handled: 1 });
    stage = "same credential value leaves run active";
    expect(await putCredential(currentOrigin, cookie, "synthetic-key-hold")).toBe(204);
    await delay(50);
    expect(credentialCancelCount).toBe(0);
    stage = "changed credential cancels prior run";
    expect(await putCredential(currentOrigin, cookie, "synthetic-key-version-c")).toBe(204);
    await within(credentialCancelSent.promise, "credential-change cancellation");
    expect(credentialCancelCount).toBe(1);
    stage = "new key starts replacement run";
    await within(fourthRunStarted.promise, "retry after canceled model run", 12000);
    stage = "replacement run sends visible reply";
    const allReplies = await waitForMessageCount(currentOrigin, cookie, channelId, 4);
    expect(allReplies.filter((message) => message.author.kind === "agent")).toMatchObject([
      { text: "这是密钥更新后的测试回复。" },
      { text: "这是取消旧 run 后的新凭据回复。" },
    ]);
    expect(fourthRunId).not.toBe(thirdRunId);
    expect(databaseState(directory)).toMatchObject({ pending: 0, handled: 2 });
    await delay(100);
    const finalMessages = (await getMessages(currentOrigin, cookie, channelId)).messages;
    expect(finalMessages).toHaveLength(4);
    expect(finalMessages.filter((message) => message.author.kind === "agent")).toHaveLength(2);
    expect(node?.text.includes("synthetic-key-version-a")).toBe(false);
    expect(node?.text.includes("synthetic-key-version-b")).toBe(false);
    expect(node?.text.includes("synthetic-key-hold")).toBe(false);
    expect(node?.text.includes("synthetic-key-version-c")).toBe(false);
    expect(
      filesContain(nodeData, [
        "synthetic-key-version-a",
        "synthetic-key-version-b",
        "synthetic-key-hold",
        "synthetic-key-version-c",
      ]) ||
        filesContain(agentHomeRoot, [
          "synthetic-key-version-a",
          "synthetic-key-version-b",
          "synthetic-key-hold",
          "synthetic-key-version-c",
        ]),
    ).toBe(false);

    stage = "channel input uses the existing Agent session and receives its reply there";
    const sharedInput = await fetch(
      new URL(`/api/owner/channels/${sharedChannelId}/messages`, currentOrigin),
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "频道输入必须进入同一个 Agent 会话。" }),
      },
    );
    expect(sharedInput.status).toBe(201);
    await within(fifthRunStarted.promise, "channel-triggered model run");
    const sharedReplies = await waitForAssistant(currentOrigin, cookie, sharedChannelId);
    expect(sharedReplies.filter((message) => message.author.kind === "agent")).toHaveLength(1);
    expect(sharedReplies.at(-1)).toMatchObject({
      author: { kind: "agent", id: agentId },
      text: "这是取消旧 run 后的新凭据回复。",
    });
    expect((await getMessages(currentOrigin, cookie, channelId)).messages).toHaveLength(4);
    expect(new Set(runSessionIds).size).toBe(1);

    stage = "a successful silent model turn handles its input without posting a reply";
    expect(await putCredential(currentOrigin, cookie, "synthetic-key-silent")).toBe(204);
    const silentInput = await fetch(
      new URL(`/api/owner/channels/${channelId}/messages`, currentOrigin),
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "这条输入允许模型选择保持沉默。" }),
      },
    );
    expect(silentInput.status).toBe(201);
    await within(sixthRunStarted.promise, "silent worker run start");
    await waitForRunState(directory, sixthRunId, "completed");
    expect((await getMessages(currentOrigin, cookie, channelId)).messages).toHaveLength(5);
    expect(databaseState(directory)).toMatchObject({ pending: 0, handled: 4 });
    expect(node?.text.includes("synthetic-key-silent")).toBe(false);
    expect(
      filesContain(nodeData, ["synthetic-key-silent"]) ||
        filesContain(agentHomeRoot, ["synthetic-key-silent"]),
    ).toBe(false);

    stage = "provider error preserves its input and retries after key replacement";
    expect(await putCredential(currentOrigin, cookie, "synthetic-key-error-text")).toBe(204);
    const erroredOwnerInput = await fetch(
      new URL(`/api/owner/channels/${channelId}/messages`, currentOrigin),
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "发生 provider 错误后仍需保留这条输入。" }),
      },
    );
    expect(erroredOwnerInput.status).toBe(201);
    await within(seventhRunStarted.promise, "provider-error model run start");
    await waitForRunState(directory, seventhRunId, "failed");
    expect(databaseRunErrorCode(directory, seventhRunId)).toBe("model_failed");
    expect(databaseState(directory)).toMatchObject({ pending: 1, handled: 4 });
    expect((await getMessages(currentOrigin, cookie, channelId)).messages).toHaveLength(6);

    expect(await putCredential(currentOrigin, cookie, "synthetic-key-version-c")).toBe(204);
    await within(eighthRunStarted.promise, "retry after the provider error");
    const recoveredMessages = await waitForMessageCount(currentOrigin, cookie, channelId, 7);
    expect(recoveredMessages.at(-1)).toMatchObject({
      author: { kind: "agent", id: agentId },
      text: "这是取消旧 run 后的新凭据回复。",
    });
    await waitForRunState(directory, eighthRunId, "completed");
    expect(databaseState(directory)).toMatchObject({ pending: 0, handled: 5 });

    stage = "an archived channel rejects an active reply and keeps its delivery recoverable";
    expect(await putCredential(currentOrigin, cookie, "synthetic-key-delayed-reply")).toBe(204);
    const archiveRaceInput = await fetch(
      new URL(`/api/owner/channels/${channelId}/messages`, currentOrigin),
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "回复生成期间归档的私信输入。" }),
      },
    );
    expect(archiveRaceInput.status).toBe(201);
    await within(ninthRunStarted.promise, "run before channel archival");
    const archiveResponse = await fetch(
      new URL(`/api/owner/channels/${channelId}`, currentOrigin),
      {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      },
    );
    expect(archiveResponse.status).toBe(200);
    await waitForRunState(directory, ninthRunId, "failed");
    expect(databaseRunErrorCode(directory, ninthRunId)).toBe("channel_archived");
    expect(databaseState(directory)).toMatchObject({ pending: 1, handled: 5 });
    expect((await getMessages(currentOrigin, cookie, channelId)).messages).toHaveLength(8);
    await delay(1800);
    expect(databaseState(directory)).toMatchObject({ pending: 1, handled: 5 });

    const unarchiveResponse = await fetch(
      new URL(`/api/owner/channels/${channelId}`, currentOrigin),
      {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ archived: false }),
      },
    );
    expect(unarchiveResponse.status).toBe(200);
    await within(tenthRunStarted.promise, "recovered run after channel unarchive");
    expect(tenthRunId).not.toBe(ninthRunId);
    const afterUnarchive = await waitForMessageCount(currentOrigin, cookie, channelId, 9);
    expect(afterUnarchive.at(-1)).toMatchObject({
      author: { kind: "agent", id: agentId },
      text: "频道解除归档后的回复。",
    });
    await waitForRunState(directory, tenthRunId, "completed");
    expect(databaseState(directory)).toMatchObject({ pending: 0, handled: 6 });

    stage = "archive earlier and unrelated pending sources before a later handled turn";
    expect(await deleteCredential(currentOrigin, cookie)).toBe(204);
    const archivedSourceInput = await fetch(
      new URL(`/api/owner/channels/${channelId}/messages`, currentOrigin),
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "恢复私信来源 A 的待处理输入。" }),
      },
    );
    expect(archivedSourceInput.status).toBe(201);
    const archiveSource = await fetch(new URL(`/api/owner/channels/${channelId}`, currentOrigin), {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(archiveSource.status).toBe(200);

    const otherChannelResponse = await fetch(new URL("/api/owner/channels", currentOrigin), {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Another pending source",
        description: "Synthetic run-context boundary fixture.",
        visibility: "private",
      }),
    });
    expect(otherChannelResponse.status).toBe(201);
    const otherChannelId = ((await otherChannelResponse.json()) as { id: string }).id;
    const membershipDb = new Database(
      joinPath(directory, "control-plane-data", "control-plane.sqlite"),
    );
    try {
      membershipDb
        .prepare(
          "INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at) VALUES(?,'agent',?,1,?)",
        )
        .run(otherChannelId, agentId, Date.now());
    } finally {
      membershipDb.close();
    }
    const otherInput = await fetch(
      new URL(`/api/owner/channels/${otherChannelId}/messages`, currentOrigin),
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "另一个未处理来源 C 不得混进恢复上下文。" }),
      },
    );
    expect(otherInput.status).toBe(201);
    const archiveOther = await fetch(
      new URL(`/api/owner/channels/${otherChannelId}`, currentOrigin),
      {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      },
    );
    expect(archiveOther.status).toBe(200);

    const laterInputText = "较晚来源 B 已完成的用户输入。";
    const sharedCountBeforeLaterInput = (await getMessages(currentOrigin, cookie, sharedChannelId))
      .messages.length;
    const laterInput = await fetch(
      new URL(`/api/owner/channels/${sharedChannelId}/messages`, currentOrigin),
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: laterInputText }),
      },
    );
    expect(laterInput.status).toBe(201);
    const laterRunStart = runStarts.length;
    expect(await putCredential(currentOrigin, cookie, "synthetic-key-inspect-context")).toBe(204);
    const laterRun = await waitForStartedRun(runStarts, sharedChannelId, laterRunStart);
    const laterMessages = await waitForMessageCount(
      currentOrigin,
      cookie,
      sharedChannelId,
      sharedCountBeforeLaterInput + 2,
    );
    await waitForRunState(directory, laterRun.runId, "completed");
    const laterReply = laterMessages.at(-1)!;
    expect(laterReply.author).toMatchObject({ kind: "agent", id: agentId });
    const laterPiContext = JSON.parse(laterReply.text) as InspectedPiContext;
    const laterPiTranscript = laterPiContext.messages.map(inspectedContent).join("\n");
    expect(laterPiContext.messages.at(-1)).toMatchObject({ role: "user" });
    expect(inspectedContent(laterPiContext.messages.at(-1)!)).toContain(laterInputText);
    expect(laterPiTranscript).not.toContain("恢复私信来源 A 的待处理输入。");
    expect(laterPiTranscript).not.toContain("另一个未处理来源 C 不得混进恢复上下文。");

    stage = "unarchived source A resumes after handled source B in the same Pi session";
    const directCountBeforeRecovery = (await getMessages(currentOrigin, cookie, channelId)).messages
      .length;
    recoveryChannelId = channelId;
    const authenticatedBeforeRecovery = authenticatedConnections,
      recoveryRunStart = runStarts.length;
    const unarchiveSource = await fetch(
      new URL(`/api/owner/channels/${channelId}`, currentOrigin),
      {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ archived: false }),
      },
    );
    expect(unarchiveSource.status).toBe(200);
    const interruptedRecoveryRun = await waitForStartedRun(runStarts, channelId, recoveryRunStart);
    await within(recoveryContextDropped.promise, "forced disconnect during recovery context");
    await waitForRunState(directory, interruptedRecoveryRun.runId, "failed");
    expect(databaseState(directory)).toMatchObject({ pending: 2 });
    await waitForAuthenticatedConnections(
      authenticatedBeforeRecovery + 1,
      () => authenticatedConnections,
    );
    const recoveryRun = await waitForStartedRun(runStarts, channelId, recoveryRunStart + 1);
    expect(recoveryRun.runId).not.toBe(interruptedRecoveryRun.runId);
    expect(recoveryRun.sessionId).toBe(laterRun.sessionId);
    const archiveRecoveryMessages = await waitForMessageCount(
      currentOrigin,
      cookie,
      channelId,
      directCountBeforeRecovery + 1,
    );
    await waitForRunState(directory, recoveryRun.runId, "completed");
    const recoveredReply = archiveRecoveryMessages.at(-1)!;
    expect(recoveredReply.author).toMatchObject({ kind: "agent", id: agentId });
    const recoveryPiContext = JSON.parse(recoveredReply.text) as InspectedPiContext;
    const recoveryEntries = recoveryPiContext.messages.map((message) => ({
      role: message.role,
      content: inspectedContent(message),
    }));
    const recoveryTranscript = recoveryEntries.map((entry) => entry.content).join("\n"),
      laterUserIndex = recoveryEntries.findIndex(
        (entry) => entry.role === "user" && entry.content.includes(laterInputText),
      ),
      laterAssistantIndex = recoveryEntries.findIndex(
        (entry) => entry.role === "assistant" && entry.content.includes(laterReply.text),
      ),
      laterUserEntry = recoveryEntries[laterUserIndex],
      laterAssistantEntry = recoveryEntries[laterAssistantIndex],
      currentInput = recoveryEntries.at(-1);
    expect(laterUserIndex).toBeGreaterThanOrEqual(0);
    expect(laterAssistantIndex).toBeGreaterThan(laterUserIndex);
    expect(laterUserEntry?.content).toContain(
      `[消息来源：频道 ${sharedChannelId}；可见范围：私密；历史记录]`,
    );
    expect(laterAssistantEntry?.content).toContain(
      `[消息来源：频道 ${sharedChannelId}；可见范围：私密；历史记录]`,
    );
    expect(currentInput?.role).toBe("user");
    expect(currentInput?.content).toContain(
      `[消息来源：频道 ${channelId}；可见范围：私密；本次输入]`,
    );
    expect(currentInput?.content).toContain("恢复私信来源 A 的待处理输入。");
    expect(recoveryTranscript).not.toContain("另一个未处理来源 C 不得混进恢复上下文。");
    expect(recoveryContextResponses).toHaveLength(2);
    expect((JSON.parse(recoveryContextResponses[1]!) as { messages: unknown[] }).messages).toEqual(
      (JSON.parse(recoveryContextResponses[0]!) as { messages: unknown[] }).messages,
    );
    expect(databaseState(directory)).toMatchObject({ pending: 1 });
    const journal = databaseJournalEntries(directory, agentId),
      earlierUser = journal.find((entry) => entry.text === "恢复私信来源 A 的待处理输入。"),
      laterUser = journal.find((entry) => entry.text === laterInputText),
      laterAssistant = journal.find((entry) => entry.text === laterReply.text),
      recoveredAssistant = journal.find((entry) => entry.text === recoveredReply.text);
    expect(earlierUser?.channel_id).toBe(channelId);
    expect(laterUser?.channel_id).toBe(sharedChannelId);
    expect(laterAssistant?.channel_id).toBe(sharedChannelId);
    expect(recoveredAssistant?.channel_id).toBe(channelId);
    expect(earlierUser!.sequence).toBeLessThan(laterUser!.sequence);
    expect(laterUser!.sequence).toBeLessThan(laterAssistant!.sequence);
    expect(laterAssistant!.sequence).toBeLessThan(recoveredAssistant!.sequence);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown test failure";
    throw new Error(
      `Control-plane/Node process test failed during: ${stage}: ${detail.replace(/synthetic-key-[\w-]+/g, "[redacted]")}`,
    );
  } finally {
    if (node) await stopProcess(node);
    for (const socket of nodeSockets) socket.terminate();
    for (const socket of controlSockets) socket.terminate();
    await new Promise<void>((resolveClose) => proxyServer.close(() => resolveClose()));
    await new Promise<void>((resolveClose) => proxyHttp.close(() => resolveClose()));
    if (control) await stopProcess(control);
    rmSync(directory, { recursive: true, force: true });
  }
}, 60000);

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
          agentHomeRoot: process.env.MATE_AGENT_HOME_ROOT,
          pairingToken: process.env.MATE_NODE_PAIRING_TOKEN,
          heartbeatIntervalMs: 100,
          heartbeatTimeoutMs: 2000,
        }, controller.signal, {
          modelWorkerEntry: ${JSON.stringify(fixture)},
          provisionAgent: async (agentId) => ({
            username: 'mate_' + agentId.replaceAll('-', '').slice(0, 27),
            uid: 24001,
            gid: 24001,
            home: ${JSON.stringify(agentHomeRoot)} + '/' + agentId,
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
    const messages = await waitForMessageCount(currentOrigin, cookie, direct.channel.id, 3);
    expect(messages).toMatchObject([
      { author: { kind: "human" }, text: "发现工具，发送一条消息，再完成本次回复。" },
      { author: { kind: "agent", id: agentId }, text: "Pi 工具经控制面发送的消息。" },
      { author: { kind: "agent", id: agentId }, text: "工具调用完成后生成的最终回复。" },
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
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      expect(
        db.prepare("SELECT action_id,operation,agent_id FROM owner_agent_tool_actions").all(),
      ).toEqual([
        {
          action_id: "conversation-tools-send",
          operation: "messages.send",
          agent_id: agentId,
        },
      ]);
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

function databaseJournalEntries(
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
        "SELECT seq AS sequence,role,text,channel_id FROM owner_agent_session_journal WHERE agent_id=? ORDER BY seq",
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
