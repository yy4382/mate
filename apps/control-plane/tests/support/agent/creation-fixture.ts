import { toolTestApp, toolTestInput } from "./tool-run.js";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { createControlPlane } from "../../../src/application.js";

import type { NodeSocket } from "../../../src/nodes/directory.js";
export const ownerPassword = "agent-creation-owner-password";
export const fixtures: Array<{ app: ReturnType<typeof createControlPlane>; directory: string }> =
  [];
export function cleanupFixture() {
  for (const { app, directory } of fixtures.splice(0)) {
    app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
export function setup() {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-creation-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${ownerPassword}\n`, { mode: 0o600 });
  const app = toolTestApp({
    dataDir: join(directory, "control-plane"),
    passwordFile,
  });
  fixtures.push({ app, directory });
  return app;
}
/** A second connection to the fixture's own database, for asserting stored rows directly. */
export function databaseFor(app: ReturnType<typeof createControlPlane>): Database.Database {
  const fixture = fixtures.find((entry) => entry.app === app);
  if (!fixture) throw new Error("The fixture was already cleaned up");
  return new Database(join(fixture.directory, "control-plane", "control-plane.sqlite"));
}
export async function login(app: ReturnType<typeof createControlPlane>): Promise<string> {
  const response = await app.http.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: ownerPassword }),
  });
  expect(response.status).toBe(204);
  return response.headers.get("set-cookie")!.split(";", 1)[0]!;
}
export class FakeNodeSocket implements NodeSocket {
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  terminate(): void {
    this.closed = true;
  }
}
export async function pairNode(
  app: ReturnType<typeof createControlPlane>,
  cookie: string,
): Promise<{ id: string; socket: FakeNodeSocket }> {
  const tokenResponse = await app.http.request("/api/owner/nodes/pairing-tokens", {
    method: "POST",
    headers: { cookie },
  });
  const { pairingToken } = (await tokenResponse.json()) as { pairingToken: string };
  const socket = new FakeNodeSocket();
  app.nodes.open(socket);
  const challenge = JSON.parse(socket.sent[0]!) as { nonce: string };
  const id = randomUUID();
  const keyPair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await toolTestInput(
    app,
    socket,
    JSON.stringify({
      type: "node.pair",
      requestId: randomUUID(),
      nodeId: id,
      pairingToken,
      publicKey: keyPair.publicKey,
      signature: sign(null, Buffer.from(challenge.nonce), keyPair.privateKey).toString("base64url"),
    }),
  );
  return { id, socket };
}
