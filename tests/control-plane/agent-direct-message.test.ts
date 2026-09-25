import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/control-plane/http.js";
import type { NodeSocket } from "../../src/control-plane/nodes/directory.js";

const password = "agent-direct-message-owner-password";
const fixtures: Array<{ app: ReturnType<typeof createControlPlaneApp>; directory: string }> = [];

afterEach(() => {
  for (const { app, directory } of fixtures.splice(0)) {
    app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakeNodeSocket implements NodeSocket {
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  terminate() {}
}

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-direct-message-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  const app = createControlPlaneApp({ dataDir: join(directory, "control-plane"), passwordFile });
  fixtures.push({ app, directory });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
  const token = await app.request("/api/owner/nodes/pairing-tokens", {
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
  return { app, cookie, nodeId, socket };
}

it("creates one private owner DM and keeps its input queued while the Agent awaits credentials", async () => {
  const { app, cookie, nodeId } = await setup();
  const agentId = randomUUID();
  const prepared = app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Research partner",
    role: "Answers private messages",
    description: "A private colleague.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: "mate_" + agentId.replaceAll("-", "").slice(0, 27),
      uid: 23001,
      gid: 23001,
      home: `/var/lib/mate/agents/${agentId}`,
    },
    app.chat,
  );
  expect(prepared.agent.sessionId).toBe(app.agents.get(agentId)?.sessionId);

  const direct = await app.request(`/api/owner/agents/${agentId}/direct-channel`, {
    method: "POST",
    headers: { cookie },
  });
  expect(direct.status).toBe(200);
  const { channel } = (await direct.json()) as { channel: { id: string; visibility: string } };
  expect(channel.visibility).toBe("private");
  const repeated = await app.request(`/api/owner/agents/${agentId}/direct-channel`, {
    method: "POST",
    headers: { cookie },
  });
  expect(((await repeated.json()) as { channel: { id: string } }).channel.id).toBe(channel.id);

  const post = await app.request(`/api/owner/channels/${channel.id}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "请给我一个简短研究计划。" }),
  });
  expect(post.status).toBe(201);
  expect(app.chat.listPendingDeliveries("agent", agentId).deliveries).toHaveLength(1);
  expect(app.chat.listAgentSessionJournal(agentId, 0, 10).messages).toMatchObject([
    { role: "user", text: "请给我一个简短研究计划。" },
  ]);
  expect(app.agents.get(agentId)?.status).toBe("waiting_credentials");
});
