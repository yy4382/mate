import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const image = process.argv[2];
if (!image)
  throw new Error("Usage: pnpm test:image:control-plane <built-image> [node-entry] [node-runtime]");
const root = fileURLToPath(new URL("../../", import.meta.url));
const nodeEntry = resolve(process.argv[3] ?? join(root, "apps/node/dist/main.js"));
const nodeRuntime = resolve(process.argv[4] ?? process.execPath);
const uid = process.getuid(),
  gid = process.getgid();
assert.ok(
  uid > 0 && gid > 0,
  "Run acceptance as an existing ordinary account with nonzero UID/GID",
);
const directory = mkdtempSync(join(tmpdir(), "mate-control-plane-image-"));
chmodSync(directory, 0o700);
const data = join(directory, "control-plane"),
  passwordFile = join(directory, "owner-password");
mkdirSync(data, { mode: 0o700 });
const password = "synthetic-control-plane-image-test-password";
writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
const project = `mate-cp-test-${randomUUID().slice(0, 8)}`;
const base = join(root, "deploy/control-plane/compose.yaml");
const initial = join(root, "deploy/control-plane/compose.initialize.yaml");
const env = {
  ...process.env,
  MATE_CONTROL_PLANE_IMAGE: image,
  MATE_UID: String(uid),
  MATE_GID: String(gid),
  MATE_CONTROL_PLANE_DATA_DIR: data,
  MATE_OWNER_PASSWORD_FILE: passwordFile,
};
let initialize = true,
  node,
  nodeOutput = "",
  occupiedName,
  cleanupPromise;
const origin = "http://127.0.0.1:8787";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
function docker(args, options = {}) {
  const result = spawnSync("docker", args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 120_000,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`docker ${args.join(" ")} failed: ${result.stderr}${result.stdout}`);
  return result.stdout.trim();
}
function compose(args, options = {}) {
  return docker(
    [
      "compose",
      "--project-name",
      project,
      "--file",
      base,
      ...(initialize ? ["--file", initial] : []),
      ...args,
    ],
    options,
  );
}
async function until(check, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`${message}\n${compose(["logs", "--no-color"])}\n${nodeOutput}`);
}
async function statusReady() {
  await until(async () => {
    try {
      return (await fetch(`${origin}/api/status`)).status === 200;
    } catch {
      return false;
    }
  }, "Compose control plane did not become reachable");
}
async function login() {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert.equal(response.status, 204, await response.text());
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  return cookie;
}
async function json(path, cookie, body) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
  return response.json();
}
function owners(path) {
  for (const name of readdirSync(path)) {
    const file = join(path, name),
      state = statSync(file);
    assert.equal(state.uid, uid, `UID for ${file}`);
    assert.equal(state.gid, gid, `GID for ${file}`);
    if (state.isDirectory()) owners(file);
  }
}
async function stopNode() {
  if (!node || node.exitCode !== null || node.signalCode !== null) return;
  const exited = new Promise((done) => node.once("exit", done));
  node.kill("SIGTERM");
  const timer = setTimeout(() => node.kill("SIGKILL"), 2000);
  await exited;
  clearTimeout(timer);
}
function removeOccupied() {
  if (!occupiedName) return;
  const result = spawnSync("docker", ["rm", "--force", occupiedName], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !result.stderr.includes("No such container"))
    throw new Error(`Cannot remove test port container ${occupiedName}: ${result.stderr}`);
  occupiedName = undefined;
}
function cleanup() {
  cleanupPromise ??= (async () => {
    await stopNode();
    removeOccupied();
    compose(["down", "--remove-orphans"]);
    rmSync(directory, { recursive: true, force: true });
  })();
  return cleanupPromise;
}
for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, async () => {
    try {
      await cleanup();
    } catch (error) {
      console.error(`Cleanup failed for project ${project}, data ${directory}:`, error);
    }
    process.exit(exitCode);
  });
}
try {
  console.log(
    JSON.stringify({
      test: "control-plane-image",
      host: process.platform,
      architecture: process.arch,
      uid,
      gid,
      project,
      dataDirectory: directory,
      image,
      nodeEntry,
      nodeRuntime,
      systemd: "not exercised",
      rootless: "not validated",
    }),
  );
  const imageInfo = JSON.parse(docker(["image", "inspect", image]))[0];
  console.log(
    JSON.stringify({
      imageId: imageInfo.Id,
      imagePlatform: `${imageInfo.Os}/${imageInfo.Architecture}`,
      version: imageInfo.Config.Labels["org.opencontainers.image.version"],
      imageBytes: imageInfo.Size,
    }),
  );
  // Inspect the delivered image without bind mounts or the source checkout.
  docker([
    "run",
    "--rm",
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "-e",
    `
    import { accessSync, existsSync, readdirSync, realpathSync, lstatSync } from 'node:fs';
    import { join } from 'node:path';
    if (existsSync('src') || existsSync('tests')) throw new Error('Source/tests entered the delivery package');
    for (const path of ['/usr/local/bin/pnpm','/usr/local/bin/npm','/usr/bin/g++','/usr/bin/make']) if (existsSync(path)) throw new Error('Build tool in runtime: '+path);
    const visit = path => { for (const name of readdirSync(path)) { const file = join(path,name); const state = lstatSync(file); if(state.isSymbolicLink() && !realpathSync(file).startsWith('/opt/mate/')) throw new Error('Dependency outside delivery: '+file); if(state.isDirectory()) visit(file); }};
    visit('/opt/mate');
    const { webRoot } = await import('@mate/web/assets'); accessSync(join(webRoot,'index.html')); accessSync(join(webRoot,'manifest.webmanifest'));
    await import('better-sqlite3'); await import('argon2');
  `,
  ]);
  const missing = join(directory, "missing-data");
  assert.throws(
    () => compose(["up", "--detach"], { env: { ...env, MATE_CONTROL_PLANE_DATA_DIR: missing } }),
    /failed/,
  );
  assert.equal(existsSync(missing), false, "Compose must not create a missing bind source");
  compose(["down"]);
  compose(["up", "--detach"], { env: { ...env, MATE_UID: "0" } });
  await until(
    () => compose(["logs", "--no-color"]).includes("nonzero owner UID and GID"),
    "Root container account was not rejected",
  );
  assert.equal(existsSync(join(data, "control-plane.sqlite")), false);
  compose(["down"]);
  const regularFile = join(directory, "not-a-directory");
  writeFileSync(regularFile, "synthetic", { mode: 0o600 });
  compose(["up", "--detach"], { env: { ...env, MATE_CONTROL_PLANE_DATA_DIR: regularFile } });
  await until(
    () => compose(["logs", "--no-color"]).includes("private directory owned"),
    "File bind source was not rejected",
  );
  const rejectedId = compose(["ps", "--all", "--quiet", "control-plane"]);
  await until(
    () => JSON.parse(docker(["inspect", rejectedId]))[0].State.ExitCode === 1,
    "Invalid bind source did not produce a failed process exit",
  );
  assert.equal(readFileSync(regularFile, "utf8"), "synthetic");
  assert.equal(statSync(regularFile).mode & 0o777, 0o600);
  compose(["down"]);
  // A public directory is rejected before the application can initialise/chmod it.
  chmodSync(data, 0o755);
  compose(["up", "--detach"]);
  await until(
    () => compose(["logs", "--no-color"]).includes("private directory owned"),
    "Public directory was not rejected",
  );
  assert.equal(statSync(data).mode & 0o777, 0o755);
  assert.equal(existsSync(join(data, "control-plane.sqlite")), false);
  compose(["down"]);
  chmodSync(data, 0o700);
  const publicPasswordFile = join(directory, "public-owner-password");
  writeFileSync(publicPasswordFile, `${password}\n`, { mode: 0o644 });
  chmodSync(publicPasswordFile, 0o644);
  compose(["up", "--detach"], { env: { ...env, MATE_OWNER_PASSWORD_FILE: publicPasswordFile } });
  await until(
    () => compose(["logs", "--no-color"]).includes("private regular file owned"),
    "Public password was not rejected",
  );
  assert.equal(existsSync(join(data, "control-plane.sqlite")), false);
  compose(["down"]);
  console.log(
    JSON.stringify({
      privatePassword: {
        uid: statSync(passwordFile).uid,
        gid: statSync(passwordFile).gid,
        mode: statSync(passwordFile).mode & 0o777,
      },
    }),
  );
  compose(["up", "--detach"]);
  await statusReady();
  let cookie = await login();
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /lang="zh-CN"/);
  for (const path of ["/manifest.webmanifest", "/sw.js", "/icon-192.png", "/icon-512.png"])
    assert.equal((await fetch(`${origin}${path}`)).status, 200);
  const id = compose(["ps", "--quiet", "control-plane"]);
  const container = JSON.parse(docker(["inspect", id]))[0];
  assert.equal(container.Config.User, `${uid}:${gid}`);
  assert.deepEqual(container.HostConfig.PortBindings["8787/tcp"], [
    { HostIp: "127.0.0.1", HostPort: "8787" },
  ]);
  assert.equal(container.HostConfig.RestartPolicy.Name, "unless-stopped");
  assert.deepEqual(container.Mounts.map(({ Destination }) => Destination).sort(), [
    "/run/mate/owner-password",
    "/var/lib/mate/control-plane",
  ]);
  assert.equal(
    container.Mounts.find(({ Destination }) => Destination === "/run/mate/owner-password").RW,
    false,
  );
  assert.equal(
    docker(["exec", id, "node", "-e", "console.log(`${process.getuid()}:${process.getgid()}`)"]),
    `${uid}:${gid}`,
  );
  const { pairingToken } = await json("/api/owner/nodes/pairing-tokens", cookie, {});
  node = spawn(nodeRuntime, [nodeEntry], {
    cwd: directory,
    env: {
      ...process.env,
      MATE_CONTROL_PLANE_URL: origin,
      MATE_NODE_DATA_DIR: join(directory, "node"),
      MATE_NODE_PAIRING_TOKEN: pairingToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  node.on("error", (error) => {
    nodeOutput += error.message;
  });
  node.stdout.on("data", (chunk) => {
    nodeOutput += chunk;
  });
  node.stderr.on("data", (chunk) => {
    nodeOutput += chunk;
  });
  await until(
    async () =>
      (await json("/api/owner/nodes", cookie)).nodes.some((candidate) => candidate.online),
    "Existing host node did not connect",
  );
  const { nodes } = await json("/api/owner/nodes", cookie);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].online, true);
  const channel = await json("/api/owner/channels", cookie, {
    name: "镜像交付测试",
    description: "",
    visibility: "private",
  });
  const message = await json(`/api/owner/channels/${channel.id}/messages`, cookie, {
    text: "容器替换后保留的合成消息",
  });
  const upload = await fetch(`${origin}/api/owner/channels/${channel.id}/attachments`, {
    method: "POST",
    headers: {
      cookie,
      "x-mate-filename": encodeURIComponent("合成资料.txt"),
      "content-type": "text/plain",
    },
    body: "synthetic attachment survives replacement",
  });
  assert.equal(upload.status, 201, await upload.clone().text());
  const { attachment } = await upload.json();
  owners(data);
  assert.equal(statSync(join(data, "control-plane.sqlite")).mode & 0o777, 0o600);
  owners(join(directory, "node"));
  compose(["down"]);
  rmSync(passwordFile);
  initialize = false;
  compose(["up", "--detach", "--force-recreate"]);
  await statusReady();
  cookie = await login();
  const history = await json(`/api/owner/channels/${channel.id}/messages`, cookie);
  assert.equal(history.messages[0].id, message.id);
  const content = await fetch(
    `${origin}/api/owner/channels/${channel.id}/attachments/${attachment.id}/content`,
    { headers: { cookie } },
  );
  assert.equal(await content.text(), "synthetic attachment survives replacement");
  await until(
    async () =>
      (await json("/api/owner/nodes", cookie)).nodes.some(
        (candidate) => candidate.id === nodes[0].id && candidate.online,
      ),
    "Node identity did not survive container replacement",
  );
  const replacementId = compose(["ps", "--quiet", "control-plane"]);
  assert.notEqual(replacementId, id);
  assert.equal(JSON.parse(docker(["inspect", replacementId]))[0].Mounts.length, 1);
  // The app handles SIGTERM even as PID 1. A process signal leaves Docker restart policy enabled.
  await delay(10_100);
  docker(["exec", replacementId, "node", "-e", "process.kill(1, 'SIGTERM')"]);
  await until(
    () => JSON.parse(docker(["inspect", replacementId]))[0].RestartCount > 0,
    "Unexpected exit did not restart under unless-stopped",
  );
  await statusReady();
  compose(["stop"]);
  await delay(1500);
  assert.equal(JSON.parse(docker(["inspect", replacementId]))[0].State.Running, false);
  compose(["start"]);
  await statusReady();
  await stopNode();
  compose(["down"]);
  occupiedName = `${project}-occupied-port`;
  try {
    docker([
      "run",
      "--detach",
      "--name",
      occupiedName,
      "--publish",
      "127.0.0.1:8787:8787",
      "--entrypoint",
      "node",
      image,
      "-e",
      "require('http').createServer((_,res)=>res.end('occupied')).listen(8787,'0.0.0.0')",
    ]);
    assert.throws(() => compose(["up", "--detach"]), /failed/);
    const failed = JSON.parse(
      docker(["inspect", compose(["ps", "--all", "--quiet", "control-plane"])]),
    )[0];
    assert.equal(failed.State.Running, false);
    assert.deepEqual(failed.HostConfig.PortBindings["8787/tcp"], [
      { HostIp: "127.0.0.1", HostPort: "8787" },
    ]);
  } finally {
    removeOccupied();
  }
  owners(data);
  console.log(
    "PASS: real image/Compose owner API, PWA, host node, private mounts, replacement, unexpected-exit restart, explicit stop/start, bind-source rejection and port conflict",
  );
  console.log(
    "NOT RUN: isolated Docker-daemon restart, rootless/userns-remap, real provider, public HTTPS/Web Push, VPS deployment or systemd-user installation matrix",
  );
} finally {
  await cleanup();
}
