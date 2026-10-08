import { toolTestApp, bindToolSocket, toolTestInput, type TestRun } from "./tool-run.js";

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { createControlPlane } from "../../../src/application.js";

import type { NodeSocket } from "../../../src/nodes/directory.js";

export const password = "agent-direct-message-owner-password";
export type OwnerMessageLike = { id: string; text: string };
export const fixtures: Array<{
  app: ReturnType<typeof createControlPlane>;
  directory: string;
  db: InstanceType<typeof Database>;
}> = [];
export function cleanupFixture() {
  for (const { app, directory, db } of fixtures.splice(0)) {
    db.close();
    app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
export class FakeNodeSocket implements NodeSocket {
  sent: string[] = [];
  dropToolCallId: string | undefined;
  onWorkspaceOperation?: (message: Record<string, unknown>) => void | Promise<void>;
  send(data: string) {
    const message = JSON.parse(data) as { type?: string; toolCallId?: string };
    if (message.type === "tools.result" && message.toolCallId === this.dropToolCallId) {
      this.dropToolCallId = undefined;
      return;
    }
    this.sent.push(data);
    if (message.type === "control.workspace.operation")
      void this.onWorkspaceOperation?.(message as Record<string, unknown>);
  }
  close() {}
  terminate() {}
}
export async function setup(options: { nodeOperationTimeoutMs?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-direct-message-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  const app = toolTestApp({
    dataDir: join(directory, "control-plane"),
    passwordFile,
    ...(options.nodeOperationTimeoutMs !== undefined
      ? { nodeOperationTimeoutMs: options.nodeOperationTimeoutMs }
      : {}),
  });
  const db = new Database(join(directory, "control-plane", "control-plane.sqlite"));
  fixtures.push({ app, directory, db });
  const login = await app.http.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
  const token = await app.http.request("/api/owner/nodes/pairing-tokens", {
    method: "POST",
    headers: { cookie },
  });
  const pairingToken = ((await token.json()) as { pairingToken: string }).pairingToken;
  const socket = new FakeNodeSocket();
  app.nodes.open(socket);
  const challenge = JSON.parse(socket.sent[0]!) as { nonce: string };
  const keyPair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const nodeId = randomUUID();
  bindToolSocket(app, nodeId, socket);
  await toolTestInput(
    app,
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
  return {
    app,
    cookie,
    db,
    directory,
    nodeId,
    socket,
    keyPair,
    nodePrivateKey: keyPair.privateKey,
  };
}
export async function pairAnotherNode(
  app: ReturnType<typeof createControlPlane>,
  cookie: string,
): Promise<{ nodeId: string; socket: FakeNodeSocket }> {
  const token = await app.http.request("/api/owner/nodes/pairing-tokens", {
    method: "POST",
    headers: { cookie },
  });
  const pairingToken = ((await token.json()) as { pairingToken: string }).pairingToken,
    socket = new FakeNodeSocket();
  app.nodes.open(socket);
  const challenge = JSON.parse(socket.sent[0]!) as { nonce: string };
  const keyPair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const nodeId = randomUUID();
  bindToolSocket(app, nodeId, socket);
  await toolTestInput(
    app,
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
  return { nodeId, socket };
}
export async function reconnectNode(
  app: ReturnType<typeof createControlPlane>,
  nodeId: string,
  privateKey: string,
): Promise<FakeNodeSocket> {
  const socket = new FakeNodeSocket();
  bindToolSocket(app, nodeId, socket);
  app.nodes.open(socket);
  const challenge = JSON.parse(socket.sent[0]!) as { nonce: string };
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "node.authenticate",
      requestId: randomUUID(),
      nodeId,
      signature: sign(null, Buffer.from(challenge.nonce), privateKey).toString("base64url"),
    }),
  );
  expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual(
    expect.objectContaining({ type: "control.authenticated", nodeId }),
  );
  return socket;
}
/**
 * One ordinary account runs every Agent on a node, so these fixtures deliberately share one
 * username, UID and GID and differ only in Agent ID, workspace and session.
 */
export async function prepareVerifiedAgent(
  app: ReturnType<typeof createControlPlane>,
  nodeId: string,
  name: string,
) {
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name,
    role: "Uses explicitly authorized conversations",
    description: "Synthetic ACL fixture.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: "mate-node-account",
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${agentId}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  return agentId;
}
export async function finishRun(
  app: ReturnType<typeof createControlPlane>,
  socket: FakeNodeSocket,
  run: { runId: string; agentId: string },
) {
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "run.complete",
      requestId: randomUUID(),
      runId: run.runId,
      agentId: run.agentId,
      ok: true,
    }),
  );
}
export async function waitForRun(socket: FakeNodeSocket, fromIndex: number): Promise<TestRun> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    for (const text of socket.sent.slice(fromIndex)) {
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message.type === "test.run.started") return message as unknown as TestRun;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The queued Agent input did not start a run");
}
export async function callAgentTool(
  app: ReturnType<typeof createControlPlane>,
  socket: FakeNodeSocket,
  run: { runId: string; agentId: string },
  toolCallId: string,
  operation: string,
  input: Record<string, unknown>,
  identity: { agentId?: string } = {},
) {
  const fromIndex = socket.sent.length,
    requestId = randomUUID();
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "tools.execute",
      requestId,
      runId: run.runId,
      agentId: identity.agentId ?? run.agentId,
      toolCallId,
      operation,
      input,
    }),
  );
  const deadline = Date.now() + 4000;
  let response: string | undefined;
  while (Date.now() < deadline) {
    response = socket.sent.slice(fromIndex).findLast((text) => {
      const message = JSON.parse(text) as {
        type?: string;
        requestId?: string;
        toolCallId?: string;
      };
      return (
        (message.type === "tools.result" && message.toolCallId === toolCallId) ||
        (message.type === "control.error" && message.requestId === requestId)
      );
    });
    if (response) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!response) throw new Error(`Agent tool ${toolCallId} did not return a result`);
  return JSON.parse(response) as {
    type: string;
    runId?: string;
    toolCallId?: string;
    ok?: boolean;
    error?: string;
    result?: unknown;
    code?: string;
    message?: string;
  };
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}
export function stableToolActionId(
  actionScopeId: string,
  input: Record<string, unknown>,
  occurrence = 1,
): string {
  const signature = createHash("sha256")
    .update(canonicalJson({ operation: "tools.call", input }))
    .digest("hex");
  return `mate:${actionScopeId}:${signature}:${occurrence}`;
}
export async function startReminderFixture(fixture: Awaited<ReturnType<typeof setup>>) {
  const { app, cookie, nodeId, socket } = fixture;
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Reminder partner",
    role: "Remembers work",
    description: "Synthetic reminder fixture",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: "mate-node-account",
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${agentId}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  const dm = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
  await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-reminder-key" }),
  });
  const from = socket.sent.length;
  app.chat.messages.createMessage({ channelId: dm.id, text: "Set a follow-up reminder" });
  const initialRun = await waitForRun(socket, from);
  const create = await callAgentTool(app, socket, initialRun, "create-followup", "tools.call", {
    name: "reminders.create",
    input: { conversationId: dm.id, text: "Check deployment", dueAt: Date.now() + 250 },
  });
  expect(create).toMatchObject({ ok: true });
  const reminderId = (create.result as { id: string }).id;
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "run.complete",
      requestId: initialRun.runId,
      runId: initialRun.runId,
      agentId,
      ok: true,
    }),
  );
  return { agentId, dm, reminderId };
}
