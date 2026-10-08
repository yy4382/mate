import { toolTestApp, bindToolSocket, toolTestInput, type TestRun } from "./tool-run.js";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect } from "vitest";
import { createControlPlane } from "../../../src/application.js";
import type { NodeSocket } from "../../../src/nodes/transport.js";
import type { NodeControlMessage } from "@mate/protocol";

const password = "agent-tool-fixture-owner-password";
const fixtures: Array<{
  app: ReturnType<typeof createControlPlane>;
  directory: string;
  db: InstanceType<typeof Database>;
}> = [];

export function cleanupAgentToolFixture() {
  for (const { app, directory, db } of fixtures.splice(0)) {
    db.close();
    app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

export class FakeNodeSocket implements NodeSocket {
  sent: string[] = [];
  onSend?: (message: NodeControlMessage) => void;
  send(data: string) {
    this.sent.push(data);
    this.onSend?.(JSON.parse(data) as NodeControlMessage);
  }
  close() {}
  terminate() {}
}

export async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-tool-fixture-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  const app = toolTestApp({ dataDir: join(directory, "control-plane"), passwordFile });
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
  return { app, cookie, db, directory, nodeId, socket };
}

export async function authorizeModel(
  app: ReturnType<typeof createControlPlane>,
  cookie: string,
): Promise<void> {
  const response = await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-direct-claim-key" }),
  });
  expect(response.status).toBe(204);
}

/** Every Agent on one node runs under that node's single ordinary account. */
export function addAgent(
  app: ReturnType<typeof createControlPlane>,
  nodeId: string,
  name: string,
): string {
  const id = randomUUID();
  app.agents.prepare({
    id,
    nodeId,
    name,
    role: "Collaborates directly",
    description: "Synthetic fixture",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    id,
    {
      username: "mate-node-account",
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${id}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  return id;
}

export async function waitForRuns(
  socket: FakeNodeSocket,
  fromIndex: number,
  agentIds: string[],
): Promise<Map<string, TestRun>> {
  const deadline = Date.now() + 5000;
  let runs: Array<TestRun> = [];
  while (Date.now() < deadline) {
    runs = socket.sent
      .slice(fromIndex)
      .map((text) => JSON.parse(text) as TestRun)
      .filter((message) => message.type === "test.run.started");
    if (agentIds.every((id) => runs.some((run) => run.agentId === id))) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return new Map(
    agentIds.map((id) => {
      const run = runs.find((candidate) => candidate.agentId === id);
      if (!run) throw new Error(`Agent ${id} did not start a run`);
      return [id, run];
    }),
  );
}
