import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/control-plane/http.js";
import type { NodeSocket } from "../../src/control-plane/nodes/directory.js";
import type { NodeControlMessage } from "../../src/nodes/protocol.js";

const password = "agent-process-tool-test-owner-password";
const fixtures: Array<{
  app: ReturnType<typeof createControlPlaneApp>;
  directory: string;
  db: InstanceType<typeof Database>;
}> = [];

afterEach(() => {
  for (const { app, directory, db } of fixtures.splice(0)) {
    db.close();
    app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakeNodeSocket implements NodeSocket {
  sent: string[] = [];
  onSend?: (message: Record<string, unknown>) => void;
  send(data: string) {
    this.sent.push(data);
    this.onSend?.(JSON.parse(data) as Record<string, unknown>);
  }
  close() {}
  terminate() {}
}

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-process-tool-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  const app = createControlPlaneApp({ dataDir: join(directory, "control-plane"), passwordFile });
  const db = new Database(join(directory, "control-plane", "control-plane.sqlite"));
  fixtures.push({ app, directory, db });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
  const tokenResponse = await app.request("/api/owner/nodes/pairing-tokens", {
    method: "POST",
    headers: { cookie },
  });
  const pairingToken = ((await tokenResponse.json()) as { pairingToken: string }).pairingToken;
  const socket = new FakeNodeSocket();
  app.nodes.open(socket);
  const challenge = JSON.parse(socket.sent[0]!) as { nonce: string };
  const keyPair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const nodeId = randomUUID();
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.pair",
      requestId: randomUUID(),
      nodeId,
      pairingToken,
      publicKey: keyPair.publicKey,
      signature: sign(null, Buffer.from(challenge.nonce), keyPair.privateKey).toString("base64url"),
    }),
  );
  return { app, cookie, db, nodeId, socket };
}

async function waitForRun(
  socket: FakeNodeSocket,
  startAt: number,
): Promise<Extract<NodeControlMessage, { type: "control.agent.run" }>> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const message = socket.sent
      .slice(startAt)
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find((candidate) => candidate.type === "control.agent.run");
    if (message)
      return message as unknown as Extract<NodeControlMessage, { type: "control.agent.run" }>;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The Agent process tool test did not start a run");
}

async function sendTool(
  app: ReturnType<typeof createControlPlaneApp>,
  socket: FakeNodeSocket,
  run: { runId: string; agentId: string },
  toolCallId: string,
  operation: string,
  input: Record<string, unknown>,
): Promise<void> {
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.tool",
      requestId: randomUUID(),
      runId: run.runId,
      agentId: run.agentId,
      toolCallId,
      operation,
      input,
    }),
  );
}

it("dispatches ordinary commands from a durable intent without privileged approval", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Process operator",
    role: "Runs ordinary commands",
    description: "Synthetic process tool fixture.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: `mate_${agentId.replaceAll("-", "").slice(0, 27)}`,
      uid: 23001,
      gid: 23001,
      home: `/var/lib/mate/agents/${agentId}`,
    },
    app.chat,
  );
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-process-tool-key" }),
  });
  const startAt = socket.sent.length;
  app.chat.createMessage(direct.id, "Use the ordinary process tools.");
  const run = await waitForRun(socket, startAt);

  await sendTool(app, socket, run, "list-process-tools", "tools.list", {});
  const listed = JSON.parse(socket.sent.at(-1)!) as {
    result?: { tools?: Array<{ name: string }> };
  };
  expect(listed.result?.tools?.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["process.exec", "process.list", "process.inspect", "process.stop"]),
  );
  await sendTool(app, socket, run, "describe-process-exec", "tools.describe", {
    name: "process.exec",
  });
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
    ok: true,
    result: {
      name: "process.exec",
      inputSchema: { properties: { command: { type: "string" } } },
    },
  });

  const scope = run.actionScopeId,
    toolCallId = `mate:${scope}:${"a".repeat(64)}:1`;
  let intentWasCommittedBeforeDispatch = false;
  socket.onSend = (message) => {
    if (message.type !== "control.process.operation") return;
    intentWasCommittedBeforeDispatch = Boolean(
      db
        .prepare(
          `SELECT 1 FROM owner_agent_process_operations
           WHERE operation_id=? AND agent_id=? AND state='executing'`,
        )
        .get(message.operationId, agentId),
    );
  };
  const toolResultPromise = sendTool(app, socket, run, toolCallId, "tools.call", {
    name: "process.exec",
    input: { command: "printf command-ran" },
  });
  const deadline = Date.now() + 4000;
  let processRequest: Record<string, unknown> | undefined;
  while (Date.now() < deadline && !processRequest) {
    processRequest = socket.sent
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find((message) => message.type === "control.process.operation");
    if (!processRequest) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(processRequest).toMatchObject({
    type: "control.process.operation",
    agentId,
    operation: { kind: "exec", command: "printf command-ran", cwd: "." },
  });
  expect(intentWasCommittedBeforeDispatch).toBe(true);
  expect(
    db
      .prepare("SELECT state FROM owner_agent_process_operations WHERE operation_id=?")
      .get(processRequest!.operationId),
  ).toEqual({ state: "executing" });

  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.process.operation.result",
      requestId: processRequest!.requestId,
      operationId: processRequest!.operationId,
      agentId,
      state: "succeeded",
      receipt: { code: 0, stdout: "command-ran", stderr: "", truncated: false },
    }),
  );
  await toolResultPromise;
  const reply = JSON.parse(socket.sent.at(-1)!) as {
    type: string;
    ok: boolean;
    result?: { operationId: string; state: string; receipt: { stdout: string } };
  };
  expect(reply).toMatchObject({
    type: "control.agent.run.tool_result",
    ok: true,
    result: {
      operationId: processRequest!.operationId,
      state: "succeeded",
      receipt: { stdout: "command-ran" },
    },
  });
  expect(
    db
      .prepare("SELECT state FROM owner_agent_process_operations WHERE operation_id=?")
      .get(processRequest!.operationId),
  ).toEqual({ state: "succeeded" });
  expect(socket.sent.some((text) => text.includes("approval"))).toBe(false);
});
