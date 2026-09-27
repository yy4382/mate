// Start both services as one ordinary account, pair over the real WebSocket, restart each service,
// and check that the short-lived model worker keeps the same Linux account.
//
// This check needs no root, no container and no service manager: run it as the ordinary account
// that owns the Mate data directories. NOTIFY_SOCKET is advertised at a path that does not exist,
// so any surviving service-manager notification call fails loudly instead of passing unnoticed;
// tests/contracts/first-release-path.test.ts additionally pins the removed notifier and the
// removed privilege-dropping worker start. A macOS run is cross-platform evidence only; record
// real Linux results separately.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startModelProcess } from "../../dist/src/nodes/model-process.js";

const launchingUid = typeof process.getuid === "function" ? process.getuid() : undefined;
if (launchingUid === 0)
  throw new Error("Run this check as the ordinary launching account, not as root.");
if (launchingUid === undefined)
  throw new Error("This check needs an account-aware host (Linux or macOS).");

const ownerPassword = "synthetic-owner-password-used-only-by-this-check",
  root = mkdtempSync(join(tmpdir(), "mate-single-account-")),
  controlData = join(root, "control-plane-data"),
  nodeData = join(root, "node-data"),
  agentHomeRoot = join(root, "agents"),
  passwordFile = join(root, "owner-password"),
  notifySocketPath = join(root, "notify.sock"),
  processes = [];

chmodSync(root, 0o700);
writeFileSync(passwordFile, `${ownerPassword}\n`, { mode: 0o600 });
chmodSync(passwordFile, 0o600);

/** Whether this host could even deliver a service-manager notification from the running account. */
const notifierAvailable = existsSync("/usr/bin/systemd-notify");

/** A container pass is evidence about Linux userspace, not about the target host; record which one ran. */
const containerMarkers = ["/.dockerenv", "/run/.containerenv", "/run/systemd/container"],
  hostEnvironmentMarker = containerMarkers.find((marker) => existsSync(marker)),
  hostEnvironment =
    hostEnvironmentMarker !== undefined || typeof process.env.container === "string"
      ? "container"
      : "host";

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function start(entry, environment, label) {
  const child = spawn(process.execPath, [entry], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      NOTIFY_SOCKET: notifySocketPath,
      ...environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { text: "", exit: undefined, child, label };
  processes.push(output);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (output.text += chunk));
  child.stderr.on("data", (chunk) => (output.text += chunk));
  child.once("exit", (code, signal) => (output.exit = { code, signal }));
  return output;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function startControlPlane(label, port) {
  return start(
    "dist/src/control-plane/main.js",
    {
      MATE_CONTROL_PLANE_PORT: String(port),
      MATE_CONTROL_PLANE_DATA_DIR: controlData,
      MATE_OWNER_PASSWORD_FILE: passwordFile,
    },
    label,
  );
}

/** Probe-then-bind can lose the port to another process; retry instead of flaking. */
async function startControlPlaneOnFreePort(label) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await freePort(),
      candidate = startControlPlane(label, port);
    try {
      const listening = await waitFor(candidate, /MATE_CONTROL_PLANE_LISTENING (\d+)/, 5000);
      assert.equal(Number(listening[1]), port);
      return { control: candidate, port };
    } catch (error) {
      await stop(candidate);
      if (attempt === 4) throw error;
    }
  }
  throw new Error("Control plane did not start on a free port");
}

async function waitFor(output, pattern, timeoutMs = 10000, from = 0) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = output.text.slice(from).match(pattern);
    if (match) return match;
    if (output.exit)
      throw new Error(`${output.label} exited (${JSON.stringify(output.exit)}): ${output.text}`);
    await delay(20);
  }
  throw new Error(`${output.label} did not produce ${pattern}: ${output.text}`);
}

async function waitForExit(output, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !output.exit) await delay(20);
  assert.ok(output.exit, `${output.label} did not exit: ${output.text}`);
  return output.exit;
}

async function stop(output) {
  if (!output || output.exit) return;
  const exited = new Promise((resolveExit) => output.child.once("exit", resolveExit));
  output.child.kill("SIGTERM");
  await Promise.race([exited, delay(1500).then(() => output.child.kill("SIGKILL"))]);
  await exited;
}

async function login(origin) {
  const response = await fetch(new URL("/api/auth/login", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: ownerPassword }),
  });
  assert.equal(response.status, 204);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

async function waitForNodeStatus(origin, cookie, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const response = await fetch(new URL("/api/owner/nodes", origin), { headers: { cookie } });
    assert.equal(response.status, 200);
    const { nodes } = await response.json();
    last = nodes;
    const match = nodes.find(predicate);
    if (match) return match;
    await delay(50);
  }
  throw new Error(`Owner node status never matched: ${JSON.stringify(last)}`);
}

async function probeModelWorkerAccount() {
  let probe;
  const controller = new AbortController(),
    worker = startModelProcess({
      provider: "openai",
      modelId: "gpt-4o-mini",
      apiKey: "synthetic-key-single-account-probe",
      entry: join(process.cwd(), "tests/fixtures/account-probe-model-worker.mjs"),
      onTranscript: async (text) => {
        probe = JSON.parse(text);
        return true;
      },
      signal: controller.signal,
    });
  try {
    await worker.run({
      runId: randomUUID(),
      agentId: randomUUID(),
      sessionId: randomUUID(),
      actionScopeId: randomUUID(),
      sourceChannel: { channelId: randomUUID(), visibility: "private" },
      messages: [
        {
          sequence: 1,
          role: "user",
          text: "报告启动本次运行的 Linux 账号。",
          sourceChannelId: randomUUID(),
          sourceVisibility: "private",
          currentRunInput: true,
        },
      ],
      prompt: { name: "Synthetic Agent", role: "Validation", description: "No private data." },
    });
  } finally {
    controller.abort();
    worker.close();
  }
  assert.ok(probe, "Model worker did not report its account");
  assert.equal(probe.uid, launchingUid);
  if (typeof process.getgid === "function") assert.equal(probe.gid, process.getgid());
  assert.equal(probe.execPath, process.execPath);
  return probe;
}

let control, node;
try {
  const started = await startControlPlaneOnFreePort("control plane"),
    controlPlanePort = started.port,
    origin = `http://127.0.0.1:${controlPlanePort}`;
  control = started.control;
  assert.equal((await fetch(new URL("/api/status", origin))).status, 200);
  let cookie = await login(origin);

  const pairingResponse = await fetch(new URL("/api/owner/nodes/pairing-tokens", origin), {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(pairingResponse.status, 201);
  const { pairingToken } = await pairingResponse.json();

  const startNode = (token, dataDirectory = nodeData, controlPlaneUrl = origin) =>
    start(
      "dist/src/node/main.js",
      {
        MATE_CONTROL_PLANE_URL: controlPlaneUrl,
        MATE_NODE_DATA_DIR: dataDirectory,
        MATE_NODE_AGENT_HOME_ROOT: agentHomeRoot,
        ...(token ? { MATE_NODE_PAIRING_TOKEN: token } : {}),
      },
      "node",
    );

  node = startNode(pairingToken);
  const paired = await waitFor(node, /MATE_NODE_PAIRED ([0-9a-f-]+)/i);
  await waitFor(node, /MATE_NODE_HEARTBEAT_ACK [0-9a-f-]+/i);
  const online = await waitForNodeStatus(
    origin,
    cookie,
    (candidate) => candidate.id === paired[1] && candidate.online,
  );
  assert.ok(online.lastConnectedAt);
  assert.equal(statSync(join(nodeData, "node-identity.json")).uid, launchingUid);
  assert.equal(statSync(controlData).uid, launchingUid);

  const tokenReuse = startNode(pairingToken, join(root, "node-token-reuse"));
  assert.equal((await waitForExit(tokenReuse)).code, 1);
  assert.match(tokenReuse.text, /配对令牌无效、已过期或已使用/);

  const impostorData = join(root, "node-impostor");
  mkdirSync(impostorData, { mode: 0o700 });
  const { privateKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  writeFileSync(
    join(impostorData, "node-identity.json"),
    JSON.stringify({ id: paired[1], privateKey }),
    { mode: 0o600 },
  );
  const impostor = startNode(undefined, impostorData);
  assert.equal((await waitForExit(impostor)).code, 1);
  assert.match(impostor.text, /控制面拒绝了此节点身份/);
  const afterImpersonation = await waitForNodeStatus(
    origin,
    cookie,
    (candidate) => candidate.id === paired[1] && candidate.online,
  );
  assert.equal(afterImpersonation.lastConnectedAt, online.lastConnectedAt);

  await stop(node);
  const offline = await waitForNodeStatus(
    origin,
    cookie,
    (candidate) => candidate.id === paired[1] && !candidate.online,
  );
  assert.equal(offline.lastConnectedAt, online.lastConnectedAt);

  node = startNode(undefined);
  const reconnected = await waitFor(node, /MATE_NODE_CONNECTED ([0-9a-f-]+)/i);
  await waitFor(node, /MATE_NODE_HEARTBEAT_ACK [0-9a-f-]+/i);
  assert.equal(reconnected[1], paired[1]);
  await waitForNodeStatus(
    origin,
    cookie,
    (candidate) => candidate.id === paired[1] && candidate.online,
  );

  // Restart the control plane at the same address while the node keeps running: the live node must
  // re-authenticate by itself, without a new pairing token and without being restarted.
  const beforeControlRestart = node.text.length;
  await stop(control);
  control = startControlPlane("restarted control plane", controlPlanePort);
  await waitFor(control, /MATE_CONTROL_PLANE_LISTENING (\d+)/);
  cookie = await login(origin);
  const reauthenticated = await waitFor(
    node,
    /MATE_NODE_CONNECTED ([0-9a-f-]+)/i,
    15000,
    beforeControlRestart,
  );
  await waitFor(node, /MATE_NODE_HEARTBEAT_ACK [0-9a-f-]+/i, 15000, beforeControlRestart);
  assert.equal(reauthenticated[1], paired[1]);
  await waitForNodeStatus(
    origin,
    cookie,
    (candidate) => candidate.id === paired[1] && candidate.online,
  );

  const worker = await probeModelWorkerAccount();
  await stop(node);

  process.stdout.write(
    `${JSON.stringify({
      mode: "ordinary-account-startup",
      kernel: process.platform,
      linuxKernel: process.platform === "linux",
      hostEnvironment,
      hostEnvironmentMarker: hostEnvironmentMarker ?? null,
      launchingUid,
      launchedAsRoot: false,
      controlPlaneUid: statSync(controlData).uid,
      nodeIdentityUid: statSync(join(nodeData, "node-identity.json")).uid,
      // Checked at the node's model-process seam with a scripted worker, not through a full Agent run.
      modelWorkerAccountProbe: "startModelProcess-seam",
      modelWorkerProcessUid: worker.uid,
      modelWorkerProcessGid: worker.gid,
      serviceManagerSocketAdvertised: notifySocketPath,
      serviceManagerNotifierBinaryPresent: notifierAvailable,
      tokenReuseRejected: true,
      impostorRejected: true,
      nodeRestartReauthenticated: true,
      controlPlaneRestartReauthenticated: true,
      offlineStatusReported: true,
    })}\n`,
  );
} finally {
  for (const entry of processes) await stop(entry).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
