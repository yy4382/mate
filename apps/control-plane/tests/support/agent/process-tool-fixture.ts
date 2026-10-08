import { toolTestApp, toolTestInput, type TestRun } from "./tool-run.js";

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createControlPlane } from "../../../src/application.js";

import type { NodeSocket } from "../../../src/nodes/transport.js";

export const password = "agent-process-tool-test-owner-password";
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
  onSend?: (message: Record<string, unknown>) => void;
  send(data: string) {
    this.sent.push(data);
    this.onSend?.(JSON.parse(data) as Record<string, unknown>);
  }
  close() {}
  terminate() {}
}
export async function createProcessToolFixture() {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-process-tool-"));
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
  const tokenResponse = await app.http.request("/api/owner/nodes/pairing-tokens", {
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
  return { app, cookie, db, nodeId, socket, keyPair };
}
export async function waitForRun(socket: FakeNodeSocket, startAt: number): Promise<TestRun> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const message = socket.sent
      .slice(startAt)
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find((candidate) => candidate.type === "test.run.started");
    if (message) return message as unknown as TestRun;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The Agent process tool test did not start a run");
}
export async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The Agent process recovery condition did not settle");
}
export async function sendTool(
  app: ReturnType<typeof createControlPlane>,
  socket: FakeNodeSocket,
  run: { runId: string; agentId: string },
  toolCallId: string,
  operation: string,
  input: Record<string, unknown>,
): Promise<void> {
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "tools.execute",
      requestId: randomUUID(),
      runId: run.runId,
      agentId: run.agentId,
      toolCallId,
      operation,
      input,
    }),
  );
}
