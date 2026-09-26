import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { PrivilegedApprovals } from "../../src/control-plane/privileged-approvals.js";
import {
  holdAgentsForRecovery,
  releaseRecoveredAgent,
} from "../../src/control-plane/recovery-holds.js";

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

it("does not send a privileged command to the node until the owner approves it", async () => {
  const db = new Database(":memory:");
  databases.push(db);
  const sent: unknown[] = [];
  const approvals = new PrivilegedApprovals(
    db,
    {
      execute: async (nodeId, grant) => {
        sent.push({ nodeId, grant });
        return { state: "succeeded", startedAt: 1000, receipt: { code: 0 } };
      },
    },
    () => 1000,
  );
  db.exec("ALTER TABLE owner_privileged_approvals ADD COLUMN node_receipt_revision INTEGER;");
  const request = approvals.request({
    requestId: randomUUID(),
    agentId: randomUUID(),
    nodeId: randomUUID(),
    channelId: randomUUID(),
    program: "/usr/bin/id",
    args: ["-u"],
    cwd: "/tmp",
  });
  expect(request.state).toBe("pending");
  expect(sent).toEqual([]);
  expect(approvals.decide(request.requestId, "reject").state).toBe("rejected");
  expect(sent).toEqual([]);
});

it("corrects an expired card only when a late node receipt proves a pre-expiry durable start", async () => {
  const db = new Database(":memory:");
  databases.push(db);
  let now = 1000;
  const events: string[] = [];
  const approvals = new PrivilegedApprovals(
    db,
    {
      execute: async () => {
        throw new Error("node reply lost");
      },
    },
    () => now,
    (event) => events.push(event.kind),
  );
  db.exec("ALTER TABLE owner_privileged_approvals ADD COLUMN node_receipt_revision INTEGER;");
  const request = approvals.request({
    requestId: randomUUID(),
    agentId: randomUUID(),
    nodeId: randomUUID(),
    channelId: randomUUID(),
    program: "/usr/bin/id",
    args: [],
    cwd: "/tmp",
  });
  approvals.decide(request.requestId, "approve");
  await Promise.resolve();
  now = request.expiresAt;
  expect(approvals.status(request.requestId)?.state).toBe("expired");
  expect(
    approvals.reconcile(request.nodeId, request.requestId, {
      state: "succeeded",
      startedAt: request.expiresAt,
      receipt: { code: 0 },
    }),
  ).toBe(false);
  expect(approvals.status(request.requestId)?.state).toBe("expired");
  expect(
    approvals.reconcile(request.nodeId, request.requestId, {
      state: "succeeded",
      startedAt: request.expiresAt - 1,
      receipt: { code: 0 },
    }),
  ).toBe(true);
  expect(approvals.status(request.requestId)?.state).toBe("succeeded");
  expect(events).toContain("receipt.corrected");
});

it("keeps approval pending when the node is offline, then expires without executing", async () => {
  const db = new Database(":memory:");
  databases.push(db);
  let now = 1000;
  let sends = 0;
  const approvals = new PrivilegedApprovals(
    db,
    {
      execute: async () => {
        sends++;
        throw new Error("node offline");
      },
    },
    () => now,
  );
  const request = approvals.request({
    requestId: randomUUID(),
    agentId: randomUUID(),
    nodeId: randomUUID(),
    channelId: randomUUID(),
    program: "/usr/bin/id",
    args: [],
    cwd: "/tmp",
  });
  approvals.decide(request.requestId, "approve");
  await Promise.resolve();
  expect(sends).toBe(1);
  expect(approvals.status(request.requestId)?.state).toBe("approved");
  now = request.expiresAt;
  approvals.resume();
  expect(approvals.status(request.requestId)?.state).toBe("expired");
  expect(sends).toBe(1);
});


it("keeps an approved privileged command queued while the Agent has a recovery hold", async () => {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE owner_agents(id TEXT PRIMARY KEY);");
  db.exec(`CREATE TABLE owner_agent_recovery_holds(
    agent_id TEXT PRIMARY KEY REFERENCES owner_agents(id), reason TEXT NOT NULL, updated_at INTEGER NOT NULL
  );`);
  const agentId = randomUUID();
  db.prepare("INSERT INTO owner_agents(id) VALUES(?)").run(agentId);
  const sent: string[] = [];
  const approvals = new PrivilegedApprovals(
    db,
    {
      execute: async (_nodeId, grant) => {
        sent.push(grant.command.requestId);
        return { state: "succeeded", startedAt: 1000, receipt: { code: 0 } };
      },
    },
    () => 1000,
  );
  db.exec("ALTER TABLE owner_privileged_approvals ADD COLUMN node_receipt_revision INTEGER;");
  const request = approvals.request({
    requestId: randomUUID(),
    agentId,
    nodeId: randomUUID(),
    channelId: randomUUID(),
    program: "/usr/bin/id",
    args: [],
    cwd: "/tmp",
  });
  holdAgentsForRecovery(db, [agentId], "node_identity_unproven", 1000);
  expect(approvals.decide(request.requestId, "approve").state).toBe("approved");
  await new Promise((resolve) => setImmediate(resolve));
  expect(sent).toEqual([]);

  releaseRecoveredAgent(db, agentId);
  approvals.resume();
  await new Promise((resolve) => setImmediate(resolve));
  expect(sent).toEqual([request.requestId]);
  expect(approvals.status(request.requestId)?.state).toBe("succeeded");
});


it("accepts a terminal node receipt for an old privileged operation while its Agent remains held", () => {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE owner_agents(id TEXT PRIMARY KEY);");
  db.exec(`CREATE TABLE owner_agent_recovery_holds(
    agent_id TEXT PRIMARY KEY REFERENCES owner_agents(id), reason TEXT NOT NULL, updated_at INTEGER NOT NULL
  );`);
  const agentId = randomUUID();
  db.prepare("INSERT INTO owner_agents(id) VALUES(?)").run(agentId);
  const approvals = new PrivilegedApprovals(db, { execute: async () => {
    throw new Error("held approval must not dispatch");
  } }, () => 1000);
  db.exec("ALTER TABLE owner_privileged_approvals ADD COLUMN node_receipt_revision INTEGER;");
  const request = approvals.request({
    requestId: randomUUID(),
    agentId,
    nodeId: randomUUID(),
    channelId: randomUUID(),
    program: "/usr/bin/id",
    args: [],
    cwd: "/tmp",
  });
  holdAgentsForRecovery(db, [agentId], "node_identity_unproven", 1000);
  approvals.decide(request.requestId, "approve");
  expect(
    approvals.reconcile(request.nodeId, request.requestId, {
      state: "succeeded",
      startedAt: request.createdAt,
      receipt: { code: 0 },
      revision: 5,
    }),
  ).toBe(true);
  expect(db.prepare("SELECT state,node_receipt_revision,receipt_json FROM owner_privileged_approvals WHERE request_id=?")
    .get(request.requestId)).toEqual({
      state: "succeeded",
      node_receipt_revision: 5,
      receipt_json: JSON.stringify({ code: 0 }),
    });
  expect(db.prepare("SELECT agent_id FROM owner_agent_recovery_holds").all()).toEqual([{ agent_id: agentId }]);
});
