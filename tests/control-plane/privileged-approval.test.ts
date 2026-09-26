import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { PrivilegedApprovals } from "../../src/control-plane/privileged-approvals.js";

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
