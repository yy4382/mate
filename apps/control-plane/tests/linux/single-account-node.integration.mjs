// Start both services as one ordinary account, pair over the real WebSocket, create Agents from the
// owner web API, restart each service, and run the real control-plane Durable loop through a local
// scripted provider and an ordinary node command. No root or identity switch is involved.
//
// This check needs no root, no container and no service manager: run it as the ordinary account
// that owns the Mate data directories. NOTIFY_SOCKET is advertised at a path that does not exist,
// so any surviving service-manager notification call fails loudly instead of passing unnoticed;
// tests/contracts/first-release-path.test.ts additionally pins the removed notifier and the
// removed identity-switching paths. A macOS run is cross-platform evidence only; record
// real Linux results separately.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

const launchingUid = typeof process.getuid === "function" ? process.getuid() : undefined;
if (launchingUid === 0)
  throw new Error("Run this check as the ordinary launching account, not as root.");
if (launchingUid === undefined)
  throw new Error("This check needs an account-aware host (Linux or macOS).");

const ownerPassword = "synthetic-owner-password-used-only-by-this-check";
const root = mkdtempSync(join(tmpdir(), "mate-single-account-"));
const controlData = join(root, "control-plane-data");
const nodeData = join(root, "node-data");
const agentWorkspaceRoot = join(root, "agents");
const passwordFile = join(root, "owner-password");
const notifySocketPath = join(root, "notify.sock");
const processes = [];

chmodSync(root, 0o700);
writeFileSync(passwordFile, `${ownerPassword}\n`, { mode: 0o600 });
chmodSync(passwordFile, 0o600);

/** Whether this host could even deliver a service-manager notification from the running account. */
const notifierAvailable = existsSync("/usr/bin/systemd-notify");

/** A container pass is evidence about Linux userspace, not about the target host; record which one ran. */
const containerMarkers = ["/.dockerenv", "/run/.containerenv", "/run/systemd/container"];
const hostEnvironmentMarker = containerMarkers.find((marker) => existsSync(marker));
const hostEnvironment =
  hostEnvironmentMarker !== undefined || typeof process.env.container === "string"
    ? "container"
    : "host";

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function start(entry, environment, label) {
  const child = spawn(process.execPath, Array.isArray(entry) ? entry : [entry], {
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
    [
      "--input-type=module",
      "--eval",
      `const { startControlPlane } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "dist/main.js")).href)}); startControlPlane(Number(process.env.MATE_CONTROL_PLANE_PORT), undefined, {}, { modelForRun: model => ({ ...model, baseUrl: ${JSON.stringify(providerUrl)} }) });`,
    ],
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
    const port = await freePort();
    const candidate = startControlPlane(label, port);
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

/** Create one Agent from the owner web API and report what the web would show for it. */
async function createAgent(origin, cookie, nodeId, name) {
  const response = await fetch(new URL("/api/owner/agents", origin), {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      id: randomUUID(),
      nodeId,
      name,
      role: "按私信工作",
      description: "Synthetic single-account creation check.",
      model: { provider: "openai", id: "gpt-4o-mini" },
    }),
  });
  const body = await response.json();
  assert.ok(
    response.status === 200 || response.status === 201,
    `Agent creation failed: ${response.status} ${JSON.stringify(body)}`,
  );
  return body.agent;
}

/**
 * Ask the host's own account database whether the per-Agent Linux accounts this release removed
 * exist. "No account was created" is then an observed fact, not an assertion about our own code.
 * Returns undefined on a host without a local passwd database, so the answer stays honest.
 */
function perAgentAccountsExist(agentIds) {
  const listing = spawnSync("/usr/bin/getent", ["passwd"], { encoding: "utf8" });
  if (listing.error || listing.status !== 0) return undefined;
  const names = new Set(
    listing.stdout
      .split("\n")
      .map((line) => line.split(":", 1)[0])
      .filter(Boolean),
  );
  // The superseded scheme named each Agent's account `mate_` plus 27 hex characters of its UUID.
  return agentIds.some((agentId) => names.has(`mate_${agentId.replaceAll("-", "").slice(0, 27)}`));
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

let providerTurn = 0;
const provider = createHttpServer(async (request, response) => {
  for await (const _chunk of request) {
    /* consume the real Pi request */
  }
  const output =
    providerTurn++ === 0
      ? [
          {
            type: "function_call",
            id: "ordinary-command",
            call_id: "ordinary-command",
            name: "tools.call",
            arguments: JSON.stringify({
              name: "process.exec",
              input: { command: "id -u; id -g; pwd; printf 'once\\n' >> effect-count.txt" },
            }),
            status: "completed",
          },
        ]
      : [
          {
            type: "message",
            id: "silent-completion",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "本地检查完成。", annotations: [] }],
          },
        ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  output.forEach((item, output_index) =>
    response.write(
      `data: ${JSON.stringify({ type: "response.output_item.done", output_index, item })}\n\n`,
    ),
  );
  response.end(
    `data: ${JSON.stringify({ type: "response.completed", response: { id: `scripted-${providerTurn}`, status: "completed", output, usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 } } })}\n\n`,
  );
});
await new Promise((done) => provider.listen(0, "127.0.0.1", done));
const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;

async function checkControlPlaneLoop(origin, cookie, agent) {
  const directResponse = await fetch(
    new URL(`/api/owner/agents/${agent.id}/direct-channel`, origin),
    { method: "POST", headers: { cookie } },
  );
  assert.equal(directResponse.status, 200);
  const { channel } = await directResponse.json();
  const message = await fetch(new URL(`/api/owner/channels/${channel.id}/messages`, origin), {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "使用普通命令核对当前账号。" }),
  });
  assert.equal(message.status, 201);
  const database = new Database(join(controlData, "control-plane.sqlite"), { readonly: true });
  try {
    const deadline = Date.now() + 15000;
    while (
      Date.now() < deadline &&
      !database
        .prepare("SELECT 1 FROM owner_agent_runs WHERE agent_id=? AND state='completed'")
        .get(agent.id)
    )
      await delay(25);
    assert.ok(
      database
        .prepare("SELECT 1 FROM owner_agent_runs WHERE agent_id=? AND state='completed'")
        .get(agent.id),
      "Real Pi run did not complete",
    );
    const operation = database
      .prepare("SELECT state,receipt_json FROM owner_agent_process_operations WHERE agent_id=?")
      .get(agent.id);
    assert.equal(operation.state, "succeeded");
    const receipt = JSON.parse(operation.receipt_json);
    const [uid, gid, cwd] = receipt.stdout.trim().split("\n");
    assert.equal(Number(uid), launchingUid);
    assert.equal(Number(gid), process.getgid());
    assert.equal(cwd, agent.linuxIdentity.workspace);
    assert.equal(readFileSync(join(cwd, "effect-count.txt"), "utf8"), "once\n");
    assert.equal(providerTurn, 2);
    return { uid: Number(uid), gid: Number(gid), cwd };
  } finally {
    database.close();
  }
}

let control;
let node;
try {
  const started = await startControlPlaneOnFreePort("control plane");
  const controlPlanePort = started.port;
  const origin = `http://127.0.0.1:${controlPlanePort}`;
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
      "../node/dist/main.js",
      {
        MATE_CONTROL_PLANE_URL: controlPlaneUrl,
        MATE_NODE_DATA_DIR: dataDirectory,
        MATE_NODE_AGENT_WORKSPACE_ROOT: agentWorkspaceRoot,
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

  // Create two Agents from the owner web API on the ordinary account this check already runs as.
  const firstAgent = await createAgent(origin, cookie, paired[1], "第一名同事");
  const secondAgent = await createAgent(origin, cookie, paired[1], "第二名同事");
  const agentEvidence = [firstAgent, secondAgent].map((agent) => {
    assert.ok(
      agent.linuxIdentity && ["waiting_credentials", "ready"].includes(agent.status),
      `Agent ${agent.id} did not reach a runnable state: ${JSON.stringify(agent)}`,
    );
    const workspace = agent.linuxIdentity.workspace;
    const memory = join(workspace, "MEMORY.md");
    assert.equal(lstatSync(workspace).isDirectory(), true, "Agent workspace is not a directory");
    assert.equal(lstatSync(memory).isFile(), true, "Agent memory entry point is missing");
    assert.match(readFileSync(memory, "utf8"), /memory/, "The memory entry point is empty");
    return {
      agentId: agent.id,
      status: agent.status,
      accountUsername: agent.linuxIdentity.username,
      accountUid: agent.linuxIdentity.uid,
      accountGid: agent.linuxIdentity.gid,
      workspace,
      memoryEntryAvailable: true,
      sessionId: agent.sessionId,
    };
  });
  assert.notEqual(agentEvidence[0].workspace, agentEvidence[1].workspace);
  assert.notEqual(agentEvidence[0].sessionId, agentEvidence[1].sessionId);
  assert.equal(agentEvidence[0].accountUid, launchingUid);
  assert.equal(agentEvidence[0].accountUsername, agentEvidence[1].accountUsername);
  assert.equal(agentEvidence[0].accountUid, agentEvidence[1].accountUid);

  // Configuring a provider key is what the owner does next; the Agent then shows as runnable.
  const credential = await fetch(new URL("/api/owner/model-credentials/openai", origin), {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-key-single-account-check" }),
  });
  assert.equal(credential.status, 204);
  const afterCredential = await (
    await fetch(new URL("/api/owner/agents", origin), { headers: { cookie } })
  ).json();
  const ready = afterCredential.agents.find((agent) => agent.id === firstAgent.id);
  assert.equal(ready?.status, "ready");

  // Creating those Agents must not have created a Linux account for either of them.
  const perAgentAccountExists = perAgentAccountsExist(agentEvidence.map((agent) => agent.agentId));
  assert.notEqual(perAgentAccountExists, true, "Agent creation created a per-Agent Linux account");
  const command = await checkControlPlaneLoop(origin, cookie, firstAgent);
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
      modelLoopLocation: "control-plane",
      providerTransport: "local-scripted-http-sse",
      ordinaryCommandUid: command.uid,
      ordinaryCommandGid: command.gid,
      ordinaryCommandWorkspace: command.cwd,
      completePiRunConfirmed: true,
      serviceManagerSocketAdvertised: notifySocketPath,
      serviceManagerNotifierBinaryPresent: notifierAvailable,
      tokenReuseRejected: true,
      impostorRejected: true,
      nodeRestartReauthenticated: true,
      controlPlaneRestartReauthenticated: true,
      offlineStatusReported: true,
      agentsCreatedFromWeb: agentEvidence.length,
      ranAsRoot: false,
      // Read from the host's own account database, not from Mate's code.
      localAccountDatabaseRead: perAgentAccountExists !== undefined,
      perAgentLinuxAccountExists: perAgentAccountExists ?? null,
      agentAccountsAreLaunchingAccount: agentEvidence.every(
        (agent) =>
          agent.accountUid === launchingUid && agent.accountUsername === userInfo().username,
      ),
      agentRunnableStateReached: ready?.status === "ready",
      agentsShareLaunchingAccount:
        agentEvidence[0].accountUid === agentEvidence[1].accountUid &&
        agentEvidence[0].accountUsername === agentEvidence[1].accountUsername,
      agentWorkspacesDistinct: agentEvidence[0].workspace !== agentEvidence[1].workspace,
      agentSessionsDistinct: agentEvidence[0].sessionId !== agentEvidence[1].sessionId,
      agentMemoryEntryAvailable: true,
      agentWorkspaceMode: agentEvidence.map((agent) =>
        (lstatSync(agent.workspace).mode & 0o777).toString(8),
      ),
      agentWorkspaceList: agentEvidence.map((agent) => agent.workspace),
      agentAccountProbe: agentEvidence.map((agent) => ({
        username: agent.accountUsername,
        uid: agent.accountUid,
        gid: agent.accountGid,
      })),
    })}\n`,
  );
} finally {
  for (const entry of processes) await stop(entry).catch(() => undefined);
  provider.closeAllConnections();
  await new Promise((done) => provider.close(done));
  rmSync(root, { recursive: true, force: true });
}
