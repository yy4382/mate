import Database from "better-sqlite3";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { expect, it } from "vitest";
import { NodeRequestError } from "../../src/nodes/pending-requests.js";
import { NodeDirectory } from "../../src/nodes/directory.js";
import type { NodeSocket } from "../../src/nodes/transport.js";

class TestNodeSocket implements NodeSocket {
  readonly messages: Record<string, unknown>[] = [];
  send(data: string): void {
    this.messages.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {}
  terminate(): void {}
}

async function authenticatedNode() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE nodes(id TEXT PRIMARY KEY,public_key TEXT NOT NULL,paired_at INTEGER NOT NULL,last_connected_at INTEGER);
    CREATE TABLE node_pairing_tokens(token_hash TEXT PRIMARY KEY,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,used_at INTEGER);
    CREATE TABLE owner_agent_process_operations(operation_id TEXT PRIMARY KEY,agent_id TEXT,node_id TEXT,state TEXT,request_json TEXT);
    CREATE TABLE owner_agent_stop_intents(operation_id TEXT PRIMARY KEY,agent_id TEXT,node_id TEXT,state TEXT);
    CREATE TABLE owner_agent_activity(seq INTEGER PRIMARY KEY,agent_id TEXT,node_id TEXT,kind TEXT,reference_id TEXT,summary TEXT,detail_json TEXT,created_at INTEGER);
  `);
  const nodeId = randomUUID(),
    { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }),
    socket = new TestNodeSocket(),
    directory = new NodeDirectory(database, { processOperationTimeoutMs: 100 });
  database.prepare("INSERT INTO nodes VALUES(?,?,?,?)").run(nodeId, publicKey, Date.now(), null);
  directory.open(socket);
  const challenge = socket.messages[0];
  await directory.receive(
    socket,
    JSON.stringify({
      type: "node.authenticate",
      requestId: randomUUID(),
      nodeId,
      signature: sign(null, Buffer.from(String(challenge?.nonce)), privateKey).toString(
        "base64url",
      ),
    }),
  );
  return { database, directory, nodeId, socket };
}

it("routes a node receipt back to the matching ordinary operation request", async () => {
  const context = await authenticatedNode(),
    operationId = randomUUID(),
    agentId = randomUUID();
  try {
    const pending = context.directory.operations.executeAgentProcessOperation(context.nodeId, {
      operationId,
      agentId,
      operation: { kind: "exec", command: "printf hello", cwd: "." },
    });
    const control = context.socket.messages.find(
      (message) => message.type === "control.process.operation",
    );
    expect(control).toMatchObject({ operationId, agentId });
    await context.directory.receive(
      context.socket,
      JSON.stringify({
        type: "node.process.operation.result",
        requestId: control!.requestId,
        operationId,
        agentId,
        state: "succeeded",
        receipt: { code: 0, stdout: "hello" },
      }),
    );
    await expect(pending).resolves.toEqual({
      operationId,
      agentId,
      state: "succeeded",
      receipt: { code: 0, stdout: "hello" },
    });
  } finally {
    context.directory.closeAll();
    context.database.close();
  }
});

it("does not claim an operation completed when its node disconnects", async () => {
  const context = await authenticatedNode();
  try {
    const pending = context.directory.operations.executeAgentProcessOperation(context.nodeId, {
      operationId: randomUUID(),
      agentId: randomUUID(),
      operation: { kind: "process.list" },
    });
    context.directory.close(context.socket);
    await expect(pending).rejects.toMatchObject({ name: "NodeRequestError", code: "disconnected" });
  } finally {
    context.directory.closeAll();
    context.database.close();
  }
});

it("periodic receipt recovery skips a current command wait and still queries other missing receipts", async () => {
  const context = await authenticatedNode(),
    operationId = randomUUID(),
    recoveryId = randomUUID(),
    agentId = randomUUID(),
    receipts: unknown[] = [];
  try {
    context.directory.setProcessReceiptHandler(
      (_nodeId, receipt) => receipts.push(receipt),
      () => {},
    );
    const insert = context.database.prepare(
      "INSERT INTO owner_agent_process_operations VALUES(?,?,?,'executing',?)",
    );
    for (const id of [operationId, recoveryId])
      insert.run(
        id,
        agentId,
        context.nodeId,
        JSON.stringify({ operation: { kind: "process.list" } }),
      );
    const pending = context.directory.operations.executeAgentProcessOperation(context.nodeId, {
      operationId,
      agentId,
      operation: { kind: "process.list" },
    });
    // Observe rejection immediately; finally closes the connection even if an assertion fails.
    void pending.catch(() => {});
    await context.directory.receive(
      context.socket,
      JSON.stringify({
        type: "node.ping",
        requestId: randomUUID(),
        sentAt: Date.now(),
      }),
    );
    const reconciliation = context.socket.messages.find(
      (message) => message.type === "control.process.reconcile",
    );
    expect(reconciliation).toMatchObject({
      operations: [{ operationId: recoveryId, agentId, requestHash: expect.any(String) }],
    });
    await context.directory.receive(
      context.socket,
      JSON.stringify({
        type: "node.process.reconcile.result",
        requestId: reconciliation!.requestId,
        receipts: [],
      }),
    );
    expect(receipts).toEqual([
      {
        operationId: recoveryId,
        agentId,
        state: "unknown",
        receipt: { reason: "no_durable_node_receipt" },
      },
    ]);
    await expect(pending).rejects.toBeInstanceOf(NodeRequestError);
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    context.socket.messages.length = 0;
    await context.directory.receive(
      context.socket,
      JSON.stringify({
        type: "node.ping",
        requestId: randomUUID(),
        sentAt: Date.now(),
      }),
    );
    expect(
      context.socket.messages.find((message) => message.type === "control.process.reconcile"),
    ).toMatchObject({
      operations: expect.arrayContaining([
        { operationId, agentId, requestHash: expect.any(String) },
      ]),
    });
  } finally {
    context.directory.closeAll();
    context.database.close();
  }
});
