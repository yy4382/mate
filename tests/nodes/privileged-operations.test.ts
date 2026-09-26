import Database from "better-sqlite3";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { PrivilegedNodeOperations } from "../../src/nodes/privileged-operations.js";

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

it("verifies the exact signed command, node and deadline before crossing the root boundary once", async () => {
  const db = new Database(":memory:");
  databases.push(db);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const nodeId = randomUUID();
  const command = {
    requestId: randomUUID(),
    operationId: randomUUID(),
    agentId: randomUUID(),
    nodeId,
    program: "/usr/bin/id",
    args: ["-u"],
    cwd: "/tmp",
    expiresAt: 2000,
  };
  const grant = {
    command,
    signature: sign(null, Buffer.from(JSON.stringify(command)), privateKey).toString("base64url"),
  };
  let starts = 0;
  const node = new PrivilegedNodeOperations(
    db,
    nodeId,
    publicKey,
    async () => {
      starts++;
      return { code: 0, stdout: "0", stderr: "", truncated: false };
    },
    () => 1000,
  );
  expect(() => node.execute({ ...grant, command: { ...command, args: ["-G"] } })).toThrow();
  expect(starts).toBe(0);
  expect((await node.execute(grant)).state).toBe("succeeded");
  expect((await node.execute(grant)).state).toBe("succeeded");
  expect(starts).toBe(1);
});

it("does not create a root start record for a grant that arrives at its deadline", () => {
  const db = new Database(":memory:");
  databases.push(db);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const nodeId = randomUUID();
  const command = {
    requestId: randomUUID(),
    operationId: randomUUID(),
    agentId: randomUUID(),
    nodeId,
    program: "/usr/bin/id",
    args: [],
    cwd: "/tmp",
    expiresAt: 2000,
  };
  const grant = {
    command,
    signature: sign(null, Buffer.from(JSON.stringify(command)), privateKey).toString("base64url"),
  };
  let starts = 0;
  const node = new PrivilegedNodeOperations(
    db,
    nodeId,
    publicKey,
    async () => {
      starts++;
      return { code: 0 };
    },
    () => 2000,
  );
  expect(() => node.execute(grant)).toThrow("expired");
  expect(node.status(command.requestId)).toBeUndefined();
  expect(starts).toBe(0);
});

it("never replays an uncertain root command after node restart", async () => {
  const db = new Database(":memory:");
  databases.push(db);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const nodeId = randomUUID();
  const command = {
    requestId: randomUUID(),
    operationId: randomUUID(),
    agentId: randomUUID(),
    nodeId,
    program: "/usr/bin/id",
    args: [],
    cwd: "/tmp",
    expiresAt: 2000,
  };
  const grant = {
    command,
    signature: sign(null, Buffer.from(JSON.stringify(command)), privateKey).toString("base64url"),
  };
  let starts = 0;
  let finish!: (value: { code: number }) => void;
  const first = new PrivilegedNodeOperations(
    db,
    nodeId,
    publicKey,
    () => {
      starts++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    () => 1000,
  );
  const result = first.execute(grant);
  await Promise.resolve();
  expect(starts).toBe(1);
  const restarted = new PrivilegedNodeOperations(
    db,
    nodeId,
    publicKey,
    async () => {
      starts++;
      return { code: 0 };
    },
    () => 1200,
  );
  expect((await restarted.execute(grant)).state).toBe("unknown");
  expect(starts).toBe(1);
  finish({ code: 0 });
  expect((await result).state).toBe("unknown");
});
