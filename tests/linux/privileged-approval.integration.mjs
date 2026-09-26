import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { PrivilegedApprovals } from "../../dist/src/control-plane/privileged-approvals.js";
import { PrivilegedNodeOperations } from "../../dist/src/nodes/privileged-operations.js";

if (process.platform !== "linux") throw new Error("This check requires Linux");

if (process.argv[2] === "control") {
  assert.notEqual(process.getuid(), 0, "control plane must be nonroot");
  const db = new Database(process.argv[3]);
  let now = 1000;
  const pending = new Map();
  const approvals = new PrivilegedApprovals(
    db,
    {
      execute: (_nodeId, grant, onStarted) =>
        new Promise((resolve, reject) => {
          pending.set(grant.command.requestId, { resolve, reject, onStarted });
          process.send({ kind: "dispatch", grant });
        }),
    },
    () => now,
  );
  process.on("message", (message) => {
    if (message.action === "shutdown") process.exit(0);
    if (message.kind === "node-result" || message.kind === "node-error") {
      const waiting = pending.get(message.requestId);
      if (!waiting) return;
      pending.delete(message.requestId);
      if (message.kind === "node-error") waiting.reject(new Error(message.error));
      else {
        waiting.onStarted?.(message.result.startedAt);
        waiting.resolve(message.result);
      }
      return;
    }
    try {
      let result;
      switch (message.action) {
        case "publicKey":
          result = approvals.publicKey;
          break;
        case "clock":
          now = message.now;
          result = now;
          break;
        case "request":
          result = approvals.request(message.request);
          break;
        case "decide":
          result = approvals.decide(message.requestId, message.decision);
          break;
        case "status":
          result = approvals.status(message.requestId);
          break;
        default:
          throw new Error("Unknown control action");
      }
      process.send({ rpcId: message.rpcId, result });
    } catch (error) {
      process.send({ rpcId: message.rpcId, error: String(error) });
    }
  });
  process.send({ kind: "ready", uid: process.getuid() });
} else if (process.argv[2] === "node") {
  assert.equal(process.getuid(), 0, "node must run as root inside the disposable container");
  const db = new Database(process.argv[3]);
  const nodeId = process.argv[4];
  const publicKey = process.argv[5];
  let now = 1000;
  const node = new PrivilegedNodeOperations(
    db,
    nodeId,
    publicKey,
    async (command) => {
      const result = spawnSync(command.program, command.args, {
        cwd: command.cwd,
        encoding: "utf8",
        shell: false,
        timeout: 5000,
      });
      if (result.error) throw result.error;
      return {
        code: result.status ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: false,
        uid: process.getuid(),
      };
    },
    () => now,
  );
  process.on("message", async (message) => {
    if (message.action === "shutdown") process.exit(0);
    try {
      let result;
      if (message.action === "clock") {
        now = message.now;
        result = now;
      } else if (message.action === "execute") result = await node.execute(message.grant);
      else if (message.action === "status") result = node.status(message.requestId);
      else throw new Error("Unknown node action");
      process.send({ rpcId: message.rpcId, result });
    } catch (error) {
      process.send({ rpcId: message.rpcId, error: String(error) });
    }
  });
  process.send({ kind: "ready", uid: process.getuid() });
} else {
  assert.equal(process.getuid(), 0, "run this check as container root");
  const root = mkdtempSync(join(tmpdir(), "mate-privileged-linux-"));
  chmodSync(root, 0o711);
  const controlDir = join(root, "control"),
    nodeDir = join(root, "node");
  mkdirSync(controlDir, { mode: 0o777 });
  chmodSync(controlDir, 0o777);
  mkdirSync(nodeDir, { mode: 0o700 });
  const nodeId = randomUUID(),
    agentId = randomUUID(),
    channelId = randomUUID();
  const children = [];
  function child(role, args, uid) {
    const processChild = spawn(
      process.execPath,
      [new URL(import.meta.url).pathname, role, ...args],
      {
        uid,
        gid: uid,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    children.push(processChild);
    let stderr = "";
    processChild.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    const pending = new Map();
    let next = 0;
    const ready = new Promise((resolve, reject) => {
      processChild.once("error", reject);
      processChild.on("message", (message) => {
        if (message.kind === "ready") {
          resolve(message);
          return;
        }
        if (message.kind === "dispatch") {
          processChild.emit("dispatch", message.grant);
          return;
        }
        const waiter = pending.get(message.rpcId);
        if (!waiter) return;
        pending.delete(message.rpcId);
        message.error ? waiter.reject(new Error(message.error)) : waiter.resolve(message.result);
      });
      processChild.once("exit", (code) => reject(new Error(`${role} exited ${code}: ${stderr}`)));
    });
    const rpc = (action, extras = {}) =>
      new Promise((resolve, reject) => {
        const rpcId = ++next;
        pending.set(rpcId, { resolve, reject });
        processChild.send({ rpcId, action, ...extras });
      });
    return { processChild, ready, rpc };
  }
  try {
    const cp = child("control", [join(controlDir, "approvals.sqlite")], 65534);
    assert.equal((await cp.ready).uid, 65534);
    const publicKey = await cp.rpc("publicKey");
    const node = child("node", [join(nodeDir, "receipts.sqlite"), nodeId, publicKey], 0);
    assert.equal((await node.ready).uid, 0);
    let dispatches = 0;
    cp.processChild.on("dispatch", async (grant) => {
      dispatches++;
      try {
        const result = await node.rpc("execute", { grant });
        cp.processChild.send({ kind: "node-result", requestId: grant.command.requestId, result });
      } catch (error) {
        cp.processChild.send({
          kind: "node-error",
          requestId: grant.command.requestId,
          error: String(error),
        });
      }
    });
    const request = (suffix) =>
      cp.rpc("request", {
        request: {
          requestId: randomUUID(),
          agentId,
          nodeId,
          channelId,
          program: "/usr/bin/touch",
          args: [join(root, suffix)],
          cwd: "/tmp",
        },
      });
    const pending = await request("unapproved");
    assert.equal((await cp.rpc("status", { requestId: pending.requestId })).state, "pending");
    assert.equal(dispatches, 0);
    assert.equal(existsSync(join(root, "unapproved")), false);

    const rejected = await request("rejected");
    assert.equal(
      (await cp.rpc("decide", { requestId: rejected.requestId, decision: "reject" })).state,
      "rejected",
    );
    assert.equal(dispatches, 0);
    assert.equal(existsSync(join(root, "rejected")), false);

    const expired = await request("expired");
    await cp.rpc("clock", { now: expired.expiresAt });
    assert.equal(
      (await cp.rpc("decide", { requestId: expired.requestId, decision: "approve" })).state,
      "expired",
    );
    assert.equal(dispatches, 0);
    assert.equal(existsSync(join(root, "expired")), false);

    await cp.rpc("clock", { now: 1000 });
    const late = await request("late");
    await node.rpc("clock", { now: late.expiresAt });
    await cp.rpc("decide", { requestId: late.requestId, decision: "approve" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(join(root, "late")), false);
    await cp.rpc("clock", { now: late.expiresAt });
    assert.equal((await cp.rpc("status", { requestId: late.requestId })).state, "expired");

    await cp.rpc("clock", { now: 1000 });
    await node.rpc("clock", { now: 1000 });
    const approved = await request("approved");
    await cp.rpc("decide", { requestId: approved.requestId, decision: "approve" });
    const deadline = Date.now() + 5000;
    while ((await cp.rpc("status", { requestId: approved.requestId })).state !== "succeeded") {
      if (Date.now() > deadline) throw new Error("Approved root command did not finish");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(join(root, "approved")), true);
    assert.equal((await node.rpc("status", { requestId: approved.requestId })).receipt.uid, 0);
    assert.equal(dispatches, 2);
    process.stdout.write(
      "Linux dual-process privileged approval: passed (control UID 65534, node UID 0).\n",
    );
  } finally {
    for (const entry of children) entry.send({ action: "shutdown" });
    rmSync(root, { recursive: true, force: true });
  }
}
