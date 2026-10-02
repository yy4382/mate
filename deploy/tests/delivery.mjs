import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { userInfo } from "node:os";

const [image, bundle, directory, version, archive, sourceRoot, daemonRecovery] =
  process.argv.slice(2);
assert.ok(image && bundle && directory && version && archive && sourceRoot);
assert.equal(process.platform, "linux");
assert.equal(resolve(process.execPath), join(bundle, "node/bin/node"));
const uid = process.getuid(),
  gid = process.getgid();
assert.ok(uid > 0 && gid > 0);
// This option is reserved for the disposable, already configured hosted runner.
// It must never be used against a developer's current Docker daemon.
if (daemonRecovery) {
  assert.equal(daemonRecovery, "--docker-daemon-recovery");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  const context = spawnSync("docker", ["context", "inspect"], { encoding: "utf8" });
  assert.equal(context.status, 0);
  assert.equal(JSON.parse(context.stdout)[0].Endpoints.docker.Host, "unix:///var/run/docker.sock");
  const containers = spawnSync("docker", ["ps", "--all", "--quiet"], { encoding: "utf8" });
  assert.equal(containers.status, 0);
  assert.equal(containers.stdout.trim(), "", "Runner must have no unrelated containers");
  assert.equal(
    spawnSync("sudo", ["-n", "systemctl", "is-active", "docker"], { encoding: "utf8" }).status,
    0,
  );
}
const project = `mate-delivery-${randomUUID().slice(0, 8)}`;
const data = join(directory, "control-plane"),
  nodeData = join(directory, "node");
const passwordFile = join(directory, "owner-password");
mkdirSync(data, { mode: 0o700 });
const password = "synthetic-delivery-acceptance-password";
writeFileSync(passwordFile, password, { mode: 0o600 });
const origin = "http://127.0.0.1:8787";
const base = join(sourceRoot, "deploy/control-plane/compose.yaml");
const initial = join(sourceRoot, "deploy/control-plane/compose.initialize.yaml");
const override = join(directory, "compose.fixture.json");
const env = {
  ...process.env,
  MATE_CONTROL_PLANE_IMAGE: image,
  MATE_UID: String(uid),
  MATE_GID: String(gid),
  MATE_CONTROL_PLANE_DATA_DIR: data,
  MATE_OWNER_PASSWORD_FILE: passwordFile,
};
let initialize = true,
  fixture = false,
  node,
  nodeOutput = "",
  cookie = "",
  channelId;
const requests = [],
  observed = new Map();
let phase = "work",
  providerError,
  nextCall = 0;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
function docker(args) {
  const result = spawnSync("docker", args, { env, encoding: "utf8", timeout: 120_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `docker ${args.join(" ")}: ${result.stderr}${result.stdout}`);
  return result.stdout.trim();
}
function compose(args) {
  return docker([
    "compose",
    "--project-name",
    project,
    "--file",
    base,
    ...(initialize ? ["--file", initial] : []),
    ...(fixture ? ["--file", override] : []),
    ...args,
  ]);
}
async function until(check, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (providerError) throw providerError;
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`${label}\n${nodeOutput}\n${compose(["logs", "--no-color", "--tail", "100"])}`);
}
async function ready() {
  await until(async () => {
    try {
      return (await fetch(`${origin}/api/status`, { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      return false;
    }
  }, "Control plane not reachable");
}
async function login() {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert.equal(response.status, 204, await response.text());
  cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
}
async function restartDocker() {
  const result = spawnSync("sudo", ["-n", "systemctl", "restart", "docker"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Existing runner Docker restart failed: ${result.stderr}`);
  await until(
    () => spawnSync("docker", ["info"], { encoding: "utf8", timeout: 5000 }).status === 0,
    "Runner Docker did not recover",
  );
}
async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
  return response.status === 204 ? undefined : response.json();
}
function owners(path) {
  const state = statSync(path);
  assert.equal(state.uid, uid, `UID ${path}`);
  assert.equal(state.gid, gid, `GID ${path}`);
  if (state.isDirectory()) for (const name of readdirSync(path)) owners(join(path, name));
}
function startNode(pairingToken) {
  node = spawn(process.execPath, [join(bundle, "app/apps/node/dist/main.js")], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: "C.UTF-8",
      MATE_CONTROL_PLANE_URL: origin,
      MATE_NODE_DATA_DIR: nodeData,
      ...(pairingToken ? { MATE_NODE_PAIRING_TOKEN: pairingToken } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  node.stdout.on("data", (chunk) => (nodeOutput += chunk));
  node.stderr.on("data", (chunk) => (nodeOutput += chunk));
  node.on("error", (error) => (providerError = error));
}
async function stopNode() {
  if (!node || node.exitCode !== null || node.signalCode !== null) return;
  const exited = new Promise((done) => node.once("exit", done));
  node.kill("SIGTERM");
  const timer = setTimeout(() => node.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
}
function call(name, input) {
  const id = `delivery-${++nextCall}`;
  return {
    type: "function_call",
    id,
    call_id: id,
    name: "tools.call",
    arguments: JSON.stringify({ name, input }),
    status: "completed",
  };
}
function text(message) {
  return {
    type: "message",
    id: `message-${++nextCall}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: message, annotations: [] }],
  };
}
const steps = [
  () =>
    call("process.exec", { command: "id -u; id -g; pwd; printf 'once\\n' >> effect-count.txt" }),
  () =>
    call("workspace.write", {
      path: "delivery.txt",
      content: "synthetic delivered workspace file\n",
    }),
  () => call("workspace.read", { path: "delivery.txt" }),
  () =>
    call("attachments.publish", {
      conversationId: channelId,
      path: "delivery.txt",
      filename: "包内节点资料.txt",
    }),
  () => text("交付演练完成。"),
];
let step = 0;
const provider = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    for (const item of body.input ?? [])
      if (item.type === "function_call_output") observed.set(item.call_id, JSON.parse(item.output));
    const output =
      phase === "work" ? [steps[step++]?.() ?? text("保持原会话。")] : [text("原会话接续完成。")];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [output_index, item] of output.entries())
      response.write(
        `data: ${JSON.stringify({ type: "response.output_item.done", output_index, item })}\n\n`,
      );
    response.end(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: `synthetic-${requests.length}`,
          status: "completed",
          output,
          usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
        },
      })}\n\n`,
    );
  } catch (error) {
    providerError = error;
    response.writeHead(500);
    response.end("Synthetic fixture failed");
  }
});

let cleanupPromise;
function cleanup() {
  return (cleanupPromise ??= (async () => {
    await stopNode();
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
    compose(["down", "--remove-orphans"]);
    console.log(`Retained synthetic test files: ${directory}`);
  })());
}
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
])
  process.once(signal, async () => {
    try {
      await cleanup();
    } finally {
      process.exit(code);
    }
  });

try {
  const imageInfo = JSON.parse(docker(["image", "inspect", image]))[0];
  assert.equal(imageInfo.Os, "linux");
  assert.equal(imageInfo.Architecture, process.arch === "x64" ? "amd64" : "arm64");
  assert.equal(imageInfo.Config.Labels["org.opencontainers.image.version"], version);
  const metadata = JSON.parse(readFileSync(join(bundle, "bundle.json"), "utf8"));
  assert.equal(metadata.version, version);
  const sourceFile = join(dirname(archive), "SOURCE_COMMIT");
  const sourceCommit = existsSync(sourceFile) ? readFileSync(sourceFile, "utf8").trim() : null;
  if (sourceCommit) {
    assert.match(sourceCommit, /^[a-f0-9]{40}$/);
    assert.equal(sourceCommit, imageInfo.Config.Labels["org.opencontainers.image.revision"]);
  }
  console.log(
    JSON.stringify({
      test: "actual-delivery",
      system: readFileSync("/etc/os-release", "utf8"),
      architecture: process.arch,
      account: userInfo().username,
      uid,
      gid,
      kernel: spawnSync("uname", ["-r"], { encoding: "utf8" }).stdout.trim(),
      environment:
        existsSync("/.dockerenv") || existsSync("/run/systemd/container")
          ? "container"
          : spawnSync("systemd-detect-virt", [], { encoding: "utf8" }).stdout.trim() || "unknown",
      imageId: imageInfo.Id,
      imageRevision: imageInfo.Config.Labels["org.opencontainers.image.revision"],
      imageBytes: imageInfo.Size,
      version,
      runtime: process.version,
      dedicatedRuntime: process.execPath,
      sourceCommit,
      systemLibraries: metadata.systemLibraries,
      hostBuildTools: spawnSync(
        "sh",
        ["-c", "command -v node || :; command -v pnpm || :; command -v cc || :"],
        { encoding: "utf8" },
      ).stdout,
      packageBytes: statSync(archive).size,
      packageSha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
      userManager: "not exercised by this delivery script",
      provider: "synthetic HTTP/SSE",
      directory,
    }),
  );
  // First run uses the production entrypoint and unmodified production Compose.
  compose(["up", "--detach"]);
  await ready();
  await login();
  assert.match(await (await fetch(origin)).text(), /lang="zh-CN"/);
  for (const path of ["/manifest.webmanifest", "/sw.js", "/icon-192.png", "/icon-512.png"])
    assert.equal((await fetch(`${origin}${path}`)).status, 200);
  const productionId = compose(["ps", "--quiet", "control-plane"]);
  const production = JSON.parse(docker(["inspect", productionId]))[0];
  assert.equal(production.Config.User, `${uid}:${gid}`);
  const containerAccount = JSON.parse(
    docker([
      "exec",
      productionId,
      "node",
      "-e",
      "console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid()}))",
    ]),
  );
  assert.deepEqual(containerAccount, { uid, gid });
  assert.deepEqual(production.HostConfig.PortBindings["8787/tcp"], [
    { HostIp: "127.0.0.1", HostPort: "8787" },
  ]);
  assert.equal(production.HostConfig.RestartPolicy.Name, "unless-stopped");
  assert.deepEqual(production.Mounts.map((mount) => mount.Destination).sort(), [
    "/run/mate/owner-password",
    "/var/lib/mate/control-plane",
  ]);
  compose(["down"]);
  initialize = false;
  // Remove the configured source path; retain the synthetic file as evidence.
  renameSync(passwordFile, join(directory, "retained-synthetic-password"));
  assert.equal(existsSync(passwordFile), false);
  const gateway = JSON.parse(docker(["network", "inspect", "bridge"]))[0].IPAM.Config[0].Gateway;
  assert.match(gateway, /^(?:\d{1,3}\.){3}\d{1,3}$/);
  await new Promise((done, reject) => {
    provider.once("error", reject);
    provider.listen(0, gateway, done);
  });
  const port = provider.address().port;
  writeFileSync(
    override,
    JSON.stringify({
      services: {
        "control-plane": {
          entrypoint: ["node", "/run/mate-test/control-plane-fixture.mjs"],
          environment: { MATE_TEST_PROVIDER_URL: `http://mate-fixture.host:${port}/v1` },
          extra_hosts: ["mate-fixture.host:host-gateway"],
          volumes: [
            {
              type: "bind",
              source: join(sourceRoot, "deploy/tests/control-plane-fixture.mjs"),
              target: "/run/mate-test/control-plane-fixture.mjs",
              read_only: true,
              bind: { create_host_path: false },
            },
          ],
        },
      },
    }),
    { mode: 0o600 },
  );
  fixture = true;
  compose(["up", "--detach"]);
  await ready();
  await login();
  const { pairingToken } = await api("/api/owner/nodes/pairing-tokens", {});
  startNode(pairingToken);
  const connected = await until(
    async () => (await api("/api/owner/nodes")).nodes.find((candidate) => candidate.online),
    "Node offline",
  );
  const created = await api("/api/owner/agents", {
    id: randomUUID(),
    nodeId: connected.id,
    name: "交付同事",
    role: "验证交付",
    description: "Synthetic acceptance only",
    model: { provider: "openai", id: "gpt-4o-mini" },
  });
  const agent = await until(
    async () =>
      (await api("/api/owner/agents")).agents.find(
        (candidate) => candidate.id === created.agent.id && candidate.linuxIdentity,
      ),
    "Agent workspace not ready",
  );
  assert.equal(agent.linuxIdentity.uid, uid);
  assert.equal(agent.linuxIdentity.gid, gid);
  assert.equal(agent.linuxIdentity.username, userInfo().username);
  const { channel } = await api(`/api/owner/agents/${agent.id}/direct-channel`, {});
  channelId = channel.id;
  await api("/api/owner/model-credentials/openai", { apiKey: "synthetic-delivery-key" }, "PUT");
  const message = await api(`/api/owner/channels/${channelId}/messages`, {
    text: "验证普通命令、文件和附件。",
  });
  const task = await api("/api/owner/tasks", {
    messageId: message.id,
    title: "容器替换后保留任务",
  });
  await until(
    async () =>
      (await api(`/api/owner/agents/${agent.id}/activity?detail=1`)).events.some(
        (event) => event.kind === "run.completed",
      ),
    "Pi run did not complete",
  );
  const results = [...observed.values()];
  assert.equal(results.length, 4);
  for (const result of results) assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(results[0].result.state, "succeeded");
  const command = results[0].result.receipt;
  assert.equal(command.code, 0, JSON.stringify(command));
  assert.deepEqual(command.stdout.trim().split("\n"), [
    String(uid),
    String(gid),
    agent.linuxIdentity.workspace,
  ]);
  assert.equal(readlinkSync(`/proc/${node.pid}/exe`), process.execPath);
  console.log(
    JSON.stringify({
      runtimeFacts: {
        controlPlane: containerAccount,
        nodePid: node.pid,
        nodeRuntime: readlinkSync(`/proc/${node.pid}/exe`),
        commandUid: uid,
        commandGid: gid,
        nodeId: connected.id,
        agentId: agent.id,
        sessionId: agent.sessionId,
        taskId: task.id,
        workspace: agent.linuxIdentity.workspace,
      },
    }),
  );
  const effectFile = join(agent.linuxIdentity.workspace, "effect-count.txt");
  assert.equal(readFileSync(effectFile, "utf8"), "once\n");
  const attachment = (await api(`/api/owner/channels/${channelId}/attachments`)).attachments[0];
  assert.ok(attachment);
  const file = await api(`/api/owner/agents/${agent.id}/workspace/chunk?path=delivery.txt`);
  assert.equal(
    Buffer.from(file.base64, "base64").toString(),
    "synthetic delivered workspace file\n",
  );
  const firstRequest = JSON.stringify(requests[0]);
  const identityBefore = readFileSync(join(nodeData, "node-identity.json"), "utf8");
  owners(data);
  owners(nodeData);

  console.log(
    JSON.stringify({
      resources: {
        nodeVmRSS: readFileSync(`/proc/${node.pid}/status`, "utf8").match(/^VmRSS:\s+(.+)$/m)?.[1],
        controlPlane: docker([
          "stats",
          "--no-stream",
          "--format",
          "{{json .}}",
          compose(["ps", "--quiet", "control-plane"]),
        ]),
        disk: spawnSync("du", ["-sk", bundle, data, nodeData], { encoding: "utf8" }).stdout,
      },
    }),
  );
  await stopNode();
  compose(["down"]);
  compose(["up", "--detach", "--force-recreate"]);
  await ready();
  await login();
  assert.equal(readFileSync(join(nodeData, "node-identity.json"), "utf8"), identityBefore);
  startNode();
  await until(
    async () =>
      (await api("/api/owner/nodes")).nodes.find(
        (candidate) => candidate.id === connected.id && candidate.online,
      ),
    "Original node did not reconnect",
  );
  const restored = (await api("/api/owner/agents")).agents.find(
    (candidate) => candidate.id === agent.id,
  );
  assert.equal(restored.sessionId, agent.sessionId);
  assert.deepEqual(restored.linuxIdentity, agent.linuxIdentity);
  assert.ok((await api("/api/owner/tasks")).tasks.some((candidate) => candidate.id === task.id));
  const attachmentResponse = await fetch(
    `${origin}/api/owner/channels/${channelId}/attachments/${attachment.id}/content`,
    { headers: { cookie } },
  );
  assert.equal(attachmentResponse.status, 200);
  assert.equal(await attachmentResponse.text(), "synthetic delivered workspace file\n");
  assert.equal(readFileSync(effectFile, "utf8"), "once\n");
  const replacement = JSON.parse(
    docker(["inspect", compose(["ps", "--quiet", "control-plane"])]),
  )[0];
  assert.notEqual(replacement.Id, productionId);
  assert.equal(
    replacement.Config.Env.some((value) => value.startsWith("MATE_OWNER_PASSWORD_FILE=")),
    false,
  );
  assert.equal(
    replacement.Mounts.some((mount) => mount.Destination === "/run/mate/owner-password"),
    false,
  );
  phase = "continue";
  const before = requests.length;
  await api(`/api/owner/channels/${channelId}/messages`, { text: "继续原会话。" });
  await until(() => requests.length > before, "Restored session not sent to provider");
  assert.ok(
    JSON.stringify(requests.at(-1)).includes("交付演练完成。"),
    "Persisted transcript missing from resumed model context",
  );
  assert.ok(firstRequest.includes("验证普通命令"));
  await until(
    async () => (await api(`/api/owner/agents/${agent.id}/usage`)).total.requestCount >= before + 1,
    "Resumed provider response not committed",
  );
  if (daemonRecovery) {
    const id = compose(["ps", "--quiet", "control-plane"]);
    await delay(10_100);
    docker(["exec", id, "node", "-e", "process.kill(1,'SIGTERM')"]);
    await until(
      () => JSON.parse(docker(["inspect", id]))[0].RestartCount > 0,
      "Unexpected process exit did not restart",
    );
    await ready();
    await restartDocker();
    await ready();
    await login();
    assert.equal(compose(["ps", "--quiet", "control-plane"]), id);
    assert.equal(JSON.parse(docker(["inspect", id]))[0].State.Running, true);
    await until(
      async () =>
        (await api("/api/owner/nodes")).nodes.some(
          (candidate) => candidate.id === connected.id && candidate.online,
        ),
      "Node failed to reconnect after Docker restart",
    );
    compose(["stop"]);
    await restartDocker();
    await delay(1500);
    assert.equal(
      JSON.parse(docker(["inspect", id]))[0].State.Running,
      false,
      "Explicit stop must survive daemon restart",
    );
    compose(["start"]);
    await ready();
    await login();
    console.log(
      "PASS: existing isolated hosted-runner Docker daemon restarted; running container restored and explicit stop preserved; no daemon configuration or account privileges changed",
    );
  }
  owners(data);
  owners(nodeData);
  await stopNode();
  compose(["down"]);
  // An externally supplied, incompatible database must remain unchanged.
  const foreignData = join(directory, "foreign-control-plane");
  mkdirSync(foreignData, { mode: 0o700 });
  docker([
    "run",
    "--rm",
    "--user",
    `${uid}:${gid}`,
    "--mount",
    `type=bind,src=${foreignData},dst=/fixture`,
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "-e",
    "import Database from 'better-sqlite3'; const db = new Database('/fixture/control-plane.sqlite'); db.exec('CREATE TABLE synthetic_sentinel(value TEXT)'); db.prepare('INSERT INTO synthetic_sentinel VALUES(?)').run('preserve'); db.pragma('application_id = 1296257100'); db.pragma('user_version = 999'); db.close();",
  ]);
  const foreignDatabase = join(foreignData, "control-plane.sqlite");
  const beforeFormat = createHash("sha256").update(readFileSync(foreignDatabase)).digest("hex");
  fixture = false;
  env.MATE_CONTROL_PLANE_DATA_DIR = foreignData;
  compose(["up", "--detach"]);
  await until(
    () => compose(["logs", "--no-color"]).includes("uses control-plane schema revision 999"),
    "Foreign database format was not rejected",
  );
  compose(["down"]);
  assert.equal(
    createHash("sha256").update(readFileSync(foreignDatabase)).digest("hex"),
    beforeFormat,
  );
  env.MATE_CONTROL_PLANE_DATA_DIR = data;
  console.log(
    "PASS: incompatible external control-plane database rejected without modifying its bytes",
  );
  console.log(
    "PASS: delivered image + production Compose + complete node runtime; owner API, real WebSocket/Pi/persistence, same-account commands/files, node-published attachment, replacement, original IDs/tasks/session/workspace, password-free recreation",
  );
  console.log(
    "NOT RUN: real provider, HTTPS/Web Push, user-service lifecycle, linger logout/boot, VPS deployment; Docker-daemon policy is a separate isolated-host command",
  );
} finally {
  await cleanup();
}
