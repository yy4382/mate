import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { createControlPlaneApp } from "../../dist/src/control-plane/http.js";
import { runLinuxNodeWithTestDependencies } from "../../dist/src/nodes/client.js";
import { loadOrCreateNodeIdentity } from "../../dist/src/nodes/identity.js";
import { PrivilegedNodeOperations } from "../../dist/src/nodes/privileged-operations.js";

if (process.platform !== "linux") throw new Error("Linux required");

if (process.argv[2] === "control") {
  assert.notEqual(process.getuid(), 0);
  const dataDir = process.argv[3];
  mkdirSync(dataDir, { mode: 0o700 });
  const passwordFile = join(dataDir, "password");
  writeFileSync(passwordFile, "synthetic-owner-password\n", { mode: 0o600 });
  let now = 1000;
  const app = createControlPlaneApp({ dataDir, passwordFile, now: () => now });
  const websockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const server = serve({
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port: 0,
    websocket: { server: websockets },
  });
  server.once("listening", () =>
    process.send({ kind: "ready", uid: process.getuid(), port: server.address().port }),
  );
  process.on("message", (message) => {
    if (message.action === "shutdown") {
      app.close();
      websockets.close();
      server.close(() => {
        rmSync(dataDir, { recursive: true, force: true });
        process.exit(0);
      });
      return;
    }
    try {
      let result;
      if (message.action === "pairToken") result = app.nodes.createPairingToken();
      else if (message.action === "registerAgent") {
        app.nodes["database"]
          .prepare(
            `INSERT INTO owner_agents(
          id,node_id,name,role,description,provider,model_id,request_json,request_hash,
          provision_request_id,status,stage,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,'waiting_credentials','complete',?,?)`,
          )
          .run(
            message.agentId,
            message.nodeId,
            "测试 Agent",
            "测试",
            "",
            "provider",
            "model",
            "{}",
            "a".repeat(64),
            randomUUID(),
            now,
            now,
          );
        result = true;
      } else if (message.action === "request") result = app.approvals.request(message.request);
      else if (message.action === "status") result = app.approvals.status(message.requestId);
      else if (message.action === "diagnose")
        result = {
          approval: app.approvals.status(message.requestId),
          inFlight: [...app.approvals["inFlight"].keys()],
          pendingPrivileged: [...app.nodes["pendingPrivileged"].keys()],
          nodes: app.nodes.list(),
        };
      else if (message.action === "clock") {
        now = message.now;
        result = now;
      } else if (message.action === "nodes") result = app.nodes.list();
      else throw new Error("Unknown control action");
      process.send({ rpcId: message.rpcId, result });
    } catch (error) {
      process.send({ rpcId: message.rpcId, error: String(error) });
    }
  });
} else if (process.argv[2] === "node") {
  assert.equal(process.getuid(), 0);
  const dataDir = process.argv[3];
  const { identity } = loadOrCreateNodeIdentity(dataDir);
  const database = new Database(join(dataDir, "privileged.sqlite"));
  let now = 1000;
  const operations = new PrivilegedNodeOperations(
    database,
    identity.id,
    "",
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
  let controller;
  let running;
  process.on("message", async (message) => {
    if (message.action === "shutdown") {
      controller?.abort();
      database.close();
      process.exit(0);
    }
    try {
      let result;
      if (message.action === "connect") {
        controller = new AbortController();
        running = runLinuxNodeWithTestDependencies(
          {
            controlPlaneUrl: message.url,
            dataDirectory: dataDir,
            pairingToken: message.token,
            heartbeatIntervalMs: 100,
            heartbeatTimeoutMs: 1000,
          },
          controller.signal,
          {
            processOperations: { allowAgent() {} },
            privilegedOperations: operations,
            workspaceExecutor: {},
            prepareAgentWorkspace: async () => {
              throw new Error("unexpected workspace preparation");
            },
          },
        ).catch((error) => process.send({ kind: "node-error", error: String(error) }));
        result = true;
      } else if (message.action === "disconnect") {
        controller?.abort();
        await running;
        result = true;
      } else if (message.action === "clock") {
        now = message.now;
        result = now;
      } else if (message.action === "status") result = operations.status(message.requestId);
      else throw new Error("Unknown node action");
      process.send({ rpcId: message.rpcId, result });
    } catch (error) {
      process.send({ rpcId: message.rpcId, error: String(error) });
    }
  });
  process.send({ kind: "ready", uid: process.getuid(), nodeId: identity.id });
} else {
  assert.equal(process.getuid(), 0);
  const root = mkdtempSync(join(tmpdir(), "mate-privileged-transport-"));
  chmodSync(root, 0o711);
  const controlDir = join(root, "control"),
    nodeDir = join(root, "node");
  mkdirSync(controlDir, { mode: 0o777 });
  chmodSync(controlDir, 0o777);
  mkdirSync(nodeDir, { mode: 0o700 });
  const children = [];
  function child(role, directory, uid) {
    const processChild = spawn(
      process.execPath,
      [new URL(import.meta.url).pathname, role, directory],
      { uid, gid: uid, stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    children.push(processChild);
    let stderr = "",
      stdout = "",
      next = 0;
    processChild.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    processChild.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    const pending = new Map();
    const ready = new Promise((resolve, reject) => {
      processChild.on("message", (message) => {
        if (message.kind === "ready") return resolve(message);
        if (message.kind === "node-error") return reject(new Error(message.error));
        const waiter = pending.get(message.rpcId);
        if (!waiter) return;
        pending.delete(message.rpcId);
        message.error ? waiter.reject(new Error(message.error)) : waiter.resolve(message.result);
      });
      processChild.once("error", reject);
      processChild.once("exit", (code) => reject(new Error(`${role} exited ${code}: ${stderr}`)));
    });
    return {
      processChild,
      logs: () => ({ stderr, stdout }),
      ready,
      rpc: (action, extras = {}) =>
        new Promise((resolve, reject) => {
          const rpcId = ++next;
          pending.set(rpcId, { resolve, reject });
          processChild.send({ rpcId, action, ...extras });
        }),
    };
  }
  const waitFor = async (read, predicate) => {
    const deadline = Date.now() + 5000;
    let last;
    while (Date.now() < deadline) {
      const value = await read();
      last = value;
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for production transport result: ${JSON.stringify(last)}`);
  };
  try {
    const cp = child("control", join(controlDir, "data"), 65534);
    const { port, uid } = await cp.ready;
    assert.equal(uid, 65534);
    const base = `http://127.0.0.1:${port}`;
    const node = child("node", nodeDir, 0);
    const { nodeId } = await node.ready;
    const token = (await cp.rpc("pairToken")).pairingToken;
    await node.rpc("connect", { url: base, token });
    await waitFor(
      () => cp.rpc("nodes"),
      (nodes) => nodes.some((n) => n.id === nodeId && n.online),
    );
    await node.rpc("disconnect");
    await waitFor(
      () => cp.rpc("nodes"),
      (nodes) => nodes.some((n) => n.id === nodeId && !n.online),
    );
    const login = async () => {
      const response = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "synthetic-owner-password" }),
      });
      assert.equal(response.status, 204);
      return response.headers.get("set-cookie").split(";", 1)[0];
    };
    let cookie = await login();
    const channelResponse = await fetch(`${base}/api/owner/channels`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "审批故障验证", description: "", visibility: "private" }),
    });
    assert.equal(channelResponse.status, 201);
    const channelId = (await channelResponse.json()).id;
    const agentId = randomUUID();
    await cp.rpc("registerAgent", { agentId, nodeId });
    const request = (name) =>
      cp.rpc("request", {
        request: {
          requestId: randomUUID(),
          agentId,
          nodeId,
          channelId,
          program: "/usr/bin/touch",
          args: [join(root, name)],
          cwd: "/tmp",
        },
      });
    const decide = async (id, decision, session = cookie) =>
      fetch(`${base}/api/owner/approvals/${id}/decision`, {
        method: "POST",
        headers: {
          cookie: session,
          host: `127.0.0.1:${port}`,
          origin: base,
          "content-type": "application/json",
        },
        body: JSON.stringify({ decision }),
      });
    const pending = await request("pending");
    assert.equal(existsSync(join(root, "pending")), false);
    const logout = await fetch(`${base}/api/auth/logout`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(logout.status, 204);
    assert.equal((await decide(pending.requestId, "approve")).status, 401);
    assert.equal((await cp.rpc("status", { requestId: pending.requestId })).state, "pending");
    cookie = await login();
    assert.equal((await decide(pending.requestId, "reject")).status, 200);
    assert.equal((await cp.rpc("status", { requestId: pending.requestId })).state, "rejected");
    assert.equal(existsSync(join(root, "pending")), false);

    const approved = await request("approved");
    assert.equal((await decide(approved.requestId, "approve")).status, 200);
    assert.equal((await cp.rpc("status", { requestId: approved.requestId })).state, "approved");
    assert.equal(
      (
        await fetch(`${base}/api/auth/logout`, {
          method: "POST",
          headers: { cookie },
        })
      ).status,
      204,
    );
    assert.equal((await decide(approved.requestId, "approve")).status, 401);
    await node.rpc("connect", { url: base });
    await waitFor(
      () => cp.rpc("nodes"),
      (nodes) => nodes.some((n) => n.id === nodeId && n.online),
    );
    try {
      await waitFor(
        () => cp.rpc("status", { requestId: approved.requestId }),
        (card) => card.state === "succeeded",
      );
    } catch (error) {
      throw new Error(
        `${error}; ${JSON.stringify({
          control: await cp.rpc("diagnose", { requestId: approved.requestId }),
          node: await node.rpc("status", { requestId: approved.requestId }),
          controlLogs: cp.logs(),
          nodeLogs: node.logs(),
        })}`,
      );
    }
    assert.equal(existsSync(join(root, "approved")), true);
    assert.equal((await node.rpc("status", { requestId: approved.requestId })).receipt.uid, 0);
    assert.equal(existsSync(join(root, "pending")), false);

    cookie = await login();
    const expired = await request("expired");
    await cp.rpc("clock", { now: expired.expiresAt });
    assert.equal((await decide(expired.requestId, "approve")).status, 200);
    assert.equal((await cp.rpc("status", { requestId: expired.requestId })).state, "expired");
    assert.equal(existsSync(join(root, "expired")), false);
    process.stdout.write(
      "Linux owner HTTP / node WebSocket privileged approval: passed (control UID 65534, node UID 0).\n",
    );
  } finally {
    await Promise.all(
      children.map(
        (entry) =>
          new Promise((resolve) => {
            if (entry.exitCode !== null) return resolve();
            entry.once("exit", resolve);
            entry.send({ action: "shutdown" });
          }),
      ),
    );
    rmSync(root, { recursive: true, force: true });
  }
}
