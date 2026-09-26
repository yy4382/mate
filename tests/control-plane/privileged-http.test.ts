import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/control-plane/http.js";
import { PrivilegedNodeOperations } from "../../src/nodes/privileged-operations.js";
import type { NodeSocket } from "../../src/control-plane/nodes/directory.js";

const fixtures: Array<{ app: ReturnType<typeof createControlPlaneApp>; dir: string }> = [];
afterEach(() =>
  fixtures.splice(0).forEach(({ app, dir }) => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }),
);

it("shows a complete pending card only to the signed-in owner and keeps duplicate decisions idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mate-privileged-http-"));
  chmodSync(dir, 0o700);
  const passwordFile = join(dir, "owner-password");
  writeFileSync(passwordFile, "synthetic-owner-password\n", { mode: 0o600 });
  const app = createControlPlaneApp({ dataDir: dir, passwordFile, now: () => 1000 });
  fixtures.push({ app, dir });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "synthetic-owner-password" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
  const channelResponse = await app.request("/api/owner/channels", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "审批测试", description: "", visibility: "private" }),
  });
  const channel = (await channelResponse.json()) as { id: string };
  const nodeId = randomUUID(),
    agentId = randomUUID();
  app.nodes["database"]
    .prepare("INSERT INTO nodes(id,public_key,paired_at) VALUES(?,?,?)")
    .run(nodeId, "synthetic-node-public-key", 1000);
  app.nodes["database"]
    .prepare(
      `INSERT INTO owner_agents(
    id,node_id,name,role,description,provider,model_id,request_json,request_hash,
    provision_request_id,status,stage,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,'waiting_credentials','complete',?,?)`,
    )
    .run(
      agentId,
      nodeId,
      "助手甲",
      "测试",
      "",
      "provider",
      "model",
      "{}",
      "a".repeat(64),
      randomUUID(),
      1000,
      1000,
    );
  const request = app.approvals.request({
    requestId: randomUUID(),
    agentId,
    nodeId,
    channelId: channel.id,
    program: "/usr/bin/id",
    args: ["-u"],
    cwd: "/tmp",
  });
  expect((await app.request(`/api/owner/channels/${channel.id}/approvals`)).status).toBe(401);
  const listed = await app.request(`/api/owner/channels/${channel.id}/approvals`, {
    headers: { cookie },
  });
  expect((await listed.json()).approvals[0]).toMatchObject({
    requestId: request.requestId,
    program: "/usr/bin/id",
    args: ["-u"],
    cwd: "/tmp",
    state: "pending",
  });
  const path = `/api/owner/approvals/${request.requestId}/decision`;
  expect(
    (
      await app.request(path, {
        method: "POST",
        headers: {
          cookie,
          host: "localhost",
          origin: "https://other.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ decision: "approve" }),
      })
    ).status,
  ).toBe(403);
  expect(app.approvals.status(request.requestId)?.state).toBe("pending");
  const reject = () =>
    app.request(path, {
      method: "POST",
      headers: {
        cookie,
        host: "localhost",
        origin: "http://localhost",
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: "reject" }),
    });
  expect((await (await reject()).json()).approval.state).toBe("rejected");
  expect((await (await reject()).json()).approval.state).toBe("rejected");
  expect(app.approvals.status(request.requestId)?.state).toBe("rejected");
});

it("sends a signed grant only after approval and accepts the node's exact operation receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mate-privileged-wire-"));
  chmodSync(dir, 0o700);
  const passwordFile = join(dir, "owner-password");
  writeFileSync(passwordFile, "synthetic-owner-password\n", { mode: 0o600 });
  const app = createControlPlaneApp({ dataDir: dir, passwordFile });
  fixtures.push({ app, dir });
  const nodeId = randomUUID(),
    agentId = randomUUID(),
    channelId = randomUUID();
  const pair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const token = app.nodes.createPairingToken();
  const sent: Record<string, unknown>[] = [];
  const socket: NodeSocket = {
    send: (data) => {
      sent.push(JSON.parse(data));
    },
    close() {},
    terminate() {},
  };
  app.nodes.open(socket);
  const nonce = sent[0]!.nonce as string;
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.pair",
      requestId: randomUUID(),
      nodeId,
      pairingToken: token.pairingToken,
      publicKey: pair.publicKey,
      signature: sign(null, Buffer.from(nonce), pair.privateKey).toString("base64url"),
    }),
  );
  const publicKey = sent.find((message) => message.type === "control.paired")
    ?.privilegedPublicKey as string;
  expect(publicKey).toContain("BEGIN PUBLIC KEY");
  app.nodes["database"]
    .prepare(
      `INSERT INTO owner_agents(
    id,node_id,name,role,description,provider,model_id,request_json,request_hash,
    provision_request_id,status,stage,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,'waiting_credentials','complete',?,?)`,
    )
    .run(
      agentId,
      nodeId,
      "助手甲",
      "测试",
      "",
      "provider",
      "model",
      "{}",
      "a".repeat(64),
      randomUUID(),
      Date.now(),
      Date.now(),
    );
  const request = app.approvals.request({
    requestId: randomUUID(),
    agentId,
    nodeId,
    channelId,
    program: "/usr/bin/id",
    args: ["-u"],
    cwd: "/tmp",
  });
  expect(sent.some((message) => message.type === "control.privileged.operation")).toBe(false);
  const nodeDb = new Database(":memory:");
  let starts = 0;
  const node = new PrivilegedNodeOperations(nodeDb, nodeId, publicKey, async () => {
    starts++;
    return { code: 0, stdout: "0", stderr: "", truncated: false };
  });
  app.approvals.decide(request.requestId, "approve");
  const dispatched = sent.find((message) => message.type === "control.privileged.operation")!;
  expect(dispatched).toBeTruthy();
  const command = dispatched.command as typeof request;
  const result = await node.execute(
    { command, signature: dispatched.signature as string },
    (startedAt) => {
      void app.nodes.receive(
        socket,
        JSON.stringify({
          type: "node.privileged.started",
          requestId: request.requestId,
          operationId: request.operationId,
          agentId,
          startedAt,
        }),
      );
    },
  );
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.privileged.result",
      requestId: request.requestId,
      operationId: request.operationId,
      agentId,
      startedAt: result.startedAt,
      state: result.state,
      receipt: result.receipt,
    }),
  );
  expect(app.approvals.status(request.requestId)?.state).toBe("succeeded");
  expect(starts).toBe(1);
  nodeDb.close();
});
