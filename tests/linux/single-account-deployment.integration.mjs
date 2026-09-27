// Deploy a fresh release package as one ordinary account, using only the documented commands, and
// prove the whole owner path works: start both services, restart them, read the status and doctor
// diagnostics, log in, pair a node, create an Agent from the web API, and run one ordinary command
// in that Agent's workspace. Then back the whole deployment up and verify it, refuse a checkpoint
// whose bytes changed under it, and refuse to publish one it cannot read completely. On the same
// checkpoint, run the documented restore drill — stop both services, verify, restore, start — and
// prove a damaged or incomplete checkpoint cannot be restored while the verified one brings the
// Agent's identity, session, message, unfinished task and workspace back, reconnects the node, and
// still runs an ordinary command. Finally stop both services and check that the status command and
// the web page report the truth.
//
// No root, no container, no service manager and no Linux account database are involved. A macOS run
// is cross-platform evidence only; record real Linux results separately. NOTIFY_SOCKET is advertised
// at a path that does not exist, so any surviving service-manager notification call would fail
// loudly instead of passing unnoticed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { statfsSync } from "node:fs";
import { createServer } from "node:net";
import { availableParallelism, totalmem } from "node:os";
import Database from "better-sqlite3";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";

const launchingUid = typeof process.getuid === "function" ? process.getuid() : undefined;
if (launchingUid === 0)
  throw new Error("Run this check as the ordinary launching account, not as root.");
if (launchingUid === undefined)
  throw new Error("This check needs an account-aware host (Linux or macOS).");

const ownerPassword = "synthetic-owner-password-used-only-by-this-check",
  cli = resolve("dist/src/deployment/cli.js"),
  modelWorkerEntry = resolve("tests/fixtures/direct-message-model-worker.mjs"),
  // `realpath` so every path below is a path the kernel reaches without a symbolic link of its own:
  // a checkpoint refuses to be written through one, and a temp root like macOS's `/var` is itself a
  // link. The check is about the deployment, not about the temp directory's spelling.
  root = realpathSync(mkdtempSync(join(tmpdir(), "mate-deployment-"))),
  // A released package is exactly these four build outputs, copied out of the checkout. The first
  // `pnpm build` runs in the checkout root, so a worktree may have reached that store through a
  // symlink; copying the real bytes is what an owner does and what makes the package movable.
  releaseSource = join(root, "release"),
  notifySocketPath = join(root, "notify.sock");

// A container pass is evidence about Linux userspace, not about the target host.
const containerMarkers = ["/.dockerenv", "/run/.containerenv", "/run/systemd/container"],
  hostEnvironmentMarker = containerMarkers.find((marker) => existsSync(marker)),
  hostEnvironment =
    hostEnvironmentMarker !== undefined || typeof process.env.container === "string"
      ? "container"
      : "host";

chmodSync(root, 0o700);

mkdirSync(releaseSource, { recursive: true, mode: 0o755 });
// `realpath` is what makes the package movable: in a worktree the checkout's own `node_modules`
// may itself be a link to a shared store, while the copied tree keeps the package manager's
// internal relative links exactly as installed.
const checkout = realpathSync(resolve("."));
mkdirSync(`${releaseSource}/node_modules`, { recursive: true, mode: 0o755 });
for (const [name, target] of [
  ["dist", `${releaseSource}/dist`],
  ["node_modules", `${releaseSource}/node_modules`],
]) {
  const copied = spawnSync("/bin/cp", ["-a", `${checkout}/${name}/.`, target], {
    encoding: "utf8",
  });
  assert.equal(copied.status, 0, `could not build the release package: ${copied.stderr}`);
}
for (const name of ["package.json", "pnpm-lock.yaml"]) {
  const copied = spawnSync(
    "/bin/cp",
    ["-L", `${resolve(".")}/${name}`, `${releaseSource}/${name}`],
    {
      encoding: "utf8",
    },
  );
  assert.equal(copied.status, 0, `could not build the release package: ${copied.stderr}`);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** The host's own numbers, read from the kernel so the record is what the machine really had. */
function totalMemoryBytes() {
  if (typeof totalmem === "function") return totalmem();
  // Linux without `os.totalmem` in this Node build: read the same figure from `/proc/meminfo`.
  const match = /^MemTotal:\s+(\d+)\s+kB$/m.exec(readFileSync("/proc/meminfo", "utf8"));
  return match ? Number(match[1]) * 1024 : 0;
}

function diskFreeBytes(path) {
  const stat = statfsSync(path);
  return Number(BigInt(stat.bavail) * BigInt(stat.bsize));
}

/** Run one documented CLI command and return its parsed JSON report. */
function step(label) {
  process.stderr.write(`[deployment-check] ${label}\n`);
}

function deploy(args, extraEnvironment = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      NOTIFY_SOCKET: notifySocketPath,
      ...extraEnvironment,
    },
  });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.status, 0, `mate-deploy ${args.join(" ")} failed: ${text}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`mate-deploy ${args.join(" ")} did not print a JSON report: ${text}`);
  }
}

/**
 * Run one documented CLI command that has to fail, and return everything it said. A tool that
 * cannot do what it was asked has to say so and exit non-zero; a report on stdout would be read as
 * success by anything watching this command.
 */
function deployFailing(args, extraEnvironment = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      NOTIFY_SOCKET: notifySocketPath,
      ...extraEnvironment,
    },
  });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.notEqual(
    result.status,
    0,
    `mate-deploy ${args.join(" ")} unexpectedly succeeded: ${text}`,
  );
  assert.equal(
    result.stdout.trim(),
    "",
    `mate-deploy ${args.join(" ")} reported both failure and a result: ${text}`,
  );
  return text;
}

/**
 * Read a checkpoint back the way a restore would. Everything here is read with the ordinary
 * account's own permissions, and every store named is one the owner's state lives in: without it
 * the copy is not a backup of this deployment.
 */
function assertCheckpointHoldsDeployment(backupDir, agentId) {
  assert.ok(
    existsSync(join(backupDir, "control", "control-plane.sqlite")),
    "the checkpoint has no control-plane database",
  );
  assert.ok(
    existsSync(join(backupDir, "node", "node-identity.json")),
    "the checkpoint has no node identity",
  );
  // The Agent's own workspace, with the file its ordinary command wrote.
  assert.equal(
    readFileSync(join(backupDir, "homes", agentId, "ledger.txt"), "utf8"),
    "once\n",
    "the Agent's workspace is not in the checkpoint",
  );
  const control = new Database(join(backupDir, "control", "control-plane.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    for (const table of [
      "owner_agent_sessions",
      "owner_agent_session_journal",
      "owner_sessions",
      "owner_messages",
      "owner_message_deliveries",
      "owner_tasks",
      "owner_task_events",
      "owner_reminders",
      "owner_reminder_firings",
      "owner_agent_process_operations",
    ]) {
      const counted = control.prepare(`SELECT count(*) AS rows FROM ${table}`).get();
      assert.ok(Number.isSafeInteger(counted.rows), `${table} is not readable in the checkpoint`);
    }
    assert.ok(
      control.prepare("SELECT id FROM owner_agent_sessions WHERE agent_id=?").get(agentId),
      "the Agent's own session is not in the checkpoint",
    );
    assert.ok(
      control.prepare("SELECT count(*) AS rows FROM owner_messages").get().rows > 0,
      "the owner's messages are not in the checkpoint",
    );
  } finally {
    control.close();
  }
  const receipts = new Database(join(backupDir, "node", "agent-process-operations.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    assert.ok(
      receipts.prepare("SELECT count(*) AS rows FROM agent_process_operations").get().rows > 0,
      "the node's operation receipts are not in the checkpoint",
    );
  } finally {
    receipts.close();
  }
}

/**
 * One owner request, retried for a bounded time. A service that has just been (re)started can have
 * a listening socket that is not answering yet, and a restarted server can reset a connection that
 * was already open; both are client-side races rather than service facts, so a check that is about
 * service state retries rather than reporting them as failure.
 */
async function request(url, options = {}, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      return await fetch(url, { ...options, headers: { connection: "close", ...options.headers } });
    } catch (error) {
      last = error;
      await delay(100);
    }
  }
  throw last;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

/**
 * The newest plain assistant turn this Agent recorded for itself. Private run transcripts stay in
 * the Agent's own session; only an explicit `messages.send` reaches a conversation.
 */
function sessionTurnText(controlPlaneDataDir, agentId) {
  const database = new Database(join(controlPlaneDataDir, "control-plane.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const row = database
      .prepare(
        `SELECT text FROM owner_agent_session_journal
         WHERE role='assistant' AND tool_action_id IS NULL AND run_id IN
           (SELECT id FROM owner_agent_runs WHERE agent_id=?)
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(agentId);
    return row?.text;
  } finally {
    database.close();
  }
}

async function login(origin) {
  const response = await request(new URL("/api/auth/login", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: ownerPassword }),
  });
  assert.equal(response.status, 204);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

async function eventually(read, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (last !== undefined) return last;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

async function nodeOnline(origin, cookie, nodeId, expected) {
  return eventually(async () => {
    const response = await request(new URL("/api/owner/nodes", origin), { headers: { cookie } });
    const { nodes } = await response.json();
    const node = nodes.find((candidate) => candidate.id === nodeId);
    return node && node.online === expected ? node : undefined;
  }, `the web page to report node ${nodeId} online=${expected}`);
}

/** Ask the Agent, from the owner's own direct channel, to run one scripted ordinary command. */
async function askAgentToRunOneCommand(origin, cookie, agent) {
  await putModelKey(origin, cookie, "synthetic-key-ordinary-commands");
  const channel = await (
    await request(new URL(`/api/owner/agents/${agent.id}/direct-channel`, origin), {
      method: "POST",
      headers: { cookie },
    })
  ).json();
  const sent = await request(
    new URL(`/api/owner/channels/${channel.channel.id}/messages`, origin),
    {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "按脚本执行普通命令。" }),
    },
  );
  assert.equal(sent.ok, true, "the owner message was not accepted");
  return { channelId: channel.channel.id, messageId: (await sent.json()).id };
}

/** The owner authorises one provider key for the deployment (or the restored one). */
async function putModelKey(origin, cookie, apiKey) {
  const credential = await request(new URL("/api/owner/model-credentials/openai", origin), {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  assert.equal(credential.status, 204);
}

/** How many logical sessions the control plane holds for one Agent. */
function sessionCount(controlPlaneDataDir, agentId) {
  return countRows(
    controlPlaneDataDir,
    "SELECT count(*) AS rows FROM owner_agent_sessions WHERE agent_id=?",
    agentId,
  );
}

/** How many model runs for one Agent have reached a terminal state. */
function completedRunCount(controlPlaneDataDir, agentId) {
  return countRows(
    controlPlaneDataDir,
    "SELECT count(*) AS rows FROM owner_agent_runs WHERE agent_id=? AND state='completed'",
    agentId,
  );
}

function countRows(controlPlaneDataDir, statement, parameter) {
  const database = new Database(join(controlPlaneDataDir, "control-plane.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return database.prepare(statement).get(parameter).rows;
  } finally {
    database.close();
  }
}

const controlPlanePort = await freePort(),
  origin = `http://127.0.0.1:${controlPlanePort}`,
  deployConfig = {
    version: 1,
    publicOrigin: "https://mate.example.test",
    controlPlanePort,
    releaseRoot: join(root, "app"),
    stateDir: join(root, "state"),
    controlPlaneDataDir: join(root, "data", "control-plane"),
    nodeDataDir: join(root, "data", "node"),
    agentHomeRoot: join(root, "data", "agents"),
    ownerPasswordFile: join(root, "owner-password"),
  },
  configPath = join(root, "deploy.json"),
  // The scripted model worker travels through the node's documented test-only seam, because this
  // check has no provider credentials and still has to observe a real command.
  environment = { MATE_NODE_MODEL_WORKER_ENTRY: modelWorkerEntry };

writeFileSync(deployConfig.ownerPasswordFile, `${ownerPassword}\n`, { mode: 0o600 });
writeFileSync(configPath, `${JSON.stringify(deployConfig, null, 2)}\n`, { mode: 0o600 });

try {
  // A fresh package, installed with the documented ordinary-account command. Installation starts
  // the control plane only: a brand-new node needs the one-time pairing token that the owner
  // creates in the web page, so the installer says so instead of guessing.
  step("install a fresh package");
  const installed = deploy(["install", configPath, releaseSource], environment);
  assert.equal(installed.services["control-plane"].state, "running");
  assert.equal(installed.services.node.state, "not_running");
  assert.match(installed.next, /配对令牌/);
  assert.equal(statSync(deployConfig.controlPlaneDataDir).uid, launchingUid);
  const firstControlPid = installed.services["control-plane"].pid;

  const doctor = deploy(["doctor", configPath], environment);
  assert.equal(doctor.account, userInfo().username);
  assert.equal(doctor.controlPlaneHttp, "running");
  assert.equal(doctor.services["control-plane"].state, "running");
  assert.match(doctor.release, /releases\//);
  assert.equal(typeof doctor.logs.node, "string");

  // The owner logs in, generates the one-time token and starts both services with it in the
  // environment, which is how a first pairing works in a real deployment too.
  step("log in and pair the node");
  let cookie = await login(origin);
  const pairingResponse = await request(new URL("/api/owner/nodes/pairing-tokens", origin), {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(pairingResponse.status, 201);
  const { pairingToken } = await pairingResponse.json();
  const paired = deploy(["start", configPath], {
    ...environment,
    MATE_NODE_PAIRING_TOKEN: pairingToken,
  });
  assert.equal(paired.services["control-plane"].state, "running");
  assert.equal(paired.services.node.state, "running");
  assert.equal(statSync(deployConfig.nodeDataDir).uid, launchingUid);
  const firstNodePid = paired.services.node.pid;
  const nodeIdentity = JSON.parse(
    readFileSync(join(deployConfig.nodeDataDir, "node-identity.json"), "utf8"),
  );
  await nodeOnline(origin, cookie, nodeIdentity.id, true);

  // Restarting is a real restart: both recorded processes are replaced, both come back ready, and
  // the already-paired node reconnects with the identity it saved rather than a new token.
  step("restart both services");
  // The control plane first: a node that comes back before its control plane is listening only
  // retries, which is wasted time rather than a failure but makes the check noisy.
  const controlOnly = deploy(["restart", configPath, "control-plane"], environment);
  const nodeOnly = deploy(["restart", configPath, "node"], environment);
  const restarted = {
    services: {
      "control-plane": controlOnly.services["control-plane"],
      node: nodeOnly.services.node,
    },
  };
  assert.equal(restarted.services["control-plane"].state, "running");
  assert.equal(restarted.services.node.state, "running");
  assert.notEqual(restarted.services["control-plane"].pid, firstControlPid);
  assert.notEqual(restarted.services.node.pid, firstNodePid);
  cookie = await login(origin);
  await nodeOnline(origin, cookie, nodeIdentity.id, true);

  // The complete owner path: one Agent created from the web API on the ordinary account this check
  // already runs as, then one real ordinary command in that Agent's own workspace.
  step("create an Agent and run one ordinary command");
  const agentResponse = await request(new URL("/api/owner/agents", origin), {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      id: randomUUID(),
      nodeId: nodeIdentity.id,
      name: "部署检查同事",
      role: "执行一条普通命令",
      description: "Synthetic single-account deployment check.",
      model: { provider: "openai", id: "gpt-4o-mini" },
    }),
  });
  const agentBody = await agentResponse.json();
  assert.equal(agentResponse.status, 201, `Agent creation failed: ${JSON.stringify(agentBody)}`);
  const agent = agentBody.agent,
    workspace = agent.linuxIdentity.workspace;
  assert.equal(agent.linuxIdentity.uid, launchingUid);
  assert.equal(agent.linuxIdentity.username, userInfo().username);

  const agentRequest = await askAgentToRunOneCommand(origin, cookie, agent),
    channelId = agentRequest.channelId;
  const ledger = await eventually(
    () =>
      existsSync(join(workspace, "ledger.txt"))
        ? readFileSync(join(workspace, "ledger.txt"), "utf8")
        : undefined,
    "the Agent's ordinary command to change its workspace",
  );
  assert.equal(ledger, "once\n");
  // The Agent's own record of what the command returned: a plain assistant turn is private to the
  // Agent's session by design, so the check reads it there rather than expecting a channel message.
  const reported = JSON.parse(
    await eventually(
      () => sessionTurnText(deployConfig.controlPlaneDataDir, agent.id),
      "the Agent's own record of the command result",
    ),
  );
  assert.equal(reported.results[0].state, "succeeded");
  assert.equal(reported.results[0].cwd, workspace);
  const controlPlaneLog = readFileSync(join(deployConfig.stateDir, "control-plane.log"), "utf8");
  assert.match(controlPlaneLog, /MATE_CONTROL_PLANE_LISTENING \d+/);

  // One unfinished task anchored on the message the Agent already handled. It is created from the
  // existing message rather than a new one, so the task does not need a model run of its own.
  step("open one unfinished task on the owner's message");
  const taskResponse = await request(new URL("/api/owner/tasks", origin), {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ messageId: agentRequest.messageId }),
  });
  assert.equal(taskResponse.status, 201, "the owner's task was not created");
  const taskId = (await taskResponse.json()).id;

  // One reminder the Agent schedules for itself through its own reminder tool, before the
  // checkpoint, so the restore drill can show a reminder surviving a real stop/restore/start cycle
  // rather than one an operator inserted by hand.
  step("let the Agent schedule one reminder");
  await putModelKey(origin, cookie, "synthetic-key-plan-reminder");
  const runsBeforeReminder = completedRunCount(deployConfig.controlPlaneDataDir, agent.id);
  const reminderRequest = await request(
    new URL(`/api/owner/channels/${channelId}/messages`, origin),
    {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "安排一条自己的提醒。" }),
    },
  );
  assert.equal(reminderRequest.ok, true, "the owner message was not accepted");
  await eventually(
    () =>
      completedRunCount(deployConfig.controlPlaneDataDir, agent.id) > runsBeforeReminder
        ? true
        : undefined,
    "the Agent to finish the run that schedules its reminder",
  );
  const reminder = (() => {
    const database = new Database(join(deployConfig.controlPlaneDataDir, "control-plane.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      return database
        .prepare(
          `SELECT reminder.id,reminder.text,reminder.due_at,reminder.state,
                  (SELECT count(*) FROM owner_agent_tool_actions action
                   WHERE action.agent_id=reminder.agent_id AND action.operation='reminders.create'
                     AND action.result_json LIKE '%' || reminder.id || '%') AS createdByTool
           FROM owner_reminders reminder WHERE reminder.agent_id=?`,
        )
        .get(agent.id);
    } finally {
      database.close();
    }
  })();
  assert.ok(reminder, "the Agent's own reminder tool call created no reminder");
  assert.equal(reminder.createdByTool, 1, "the reminder did not come from the Agent's tool call");
  assert.equal(reminder.state, "active");

  // The owner's backup path, exactly as documented and as the same ordinary account: both services
  // stop and are confirmed stopped, the state is copied, the services come back, and the result is
  // verified. Nothing here is root, a service manager or an approval step.
  //
  // A complete checkpoint has to hold the node's workspace receipts, and only a host that runs
  // workspace operations keeps that directory at all. This section therefore runs where the state
  // it checks really exists and says plainly where it does not, rather than treating a host without
  // receipts as a host whose backup worked.
  const backupEvidence = { ran: false, checkpointOwnerUid: null, checkpointMode: null },
    // Recorded separately from the backup section, because a host that cannot take a checkpoint
    // cannot exercise a restore either and must say so rather than claim one.
    restoreEvidence = {
      ran: false,
      refusedAlteredCheckpoint: false,
      refusedIncompleteCheckpoint: false,
      agentIdentityAndWorkspace: false,
      oneLogicalSession: false,
      unfinishedTask: false,
      reminder: false,
      nodeReauthenticated: false,
      deliveryContinued: false,
      ordinaryCommandAfterRestore: false,
    };
  if (!existsSync(join(deployConfig.nodeDataDir, "workspace-receipts"))) {
    step("skip the backup check: this host keeps no node workspace receipts to copy");
  } else {
    step("back up both stopped services and verify the checkpoint");
    // The first form in the operations document: no destination, so the checkpoint lands in Mate's
    // own state directory.
    const backedUp = deploy(["backup", configPath], environment),
      backupDir = String(backedUp.checkpoint);
    assert.ok(
      backupDir.startsWith(`${deployConfig.stateDir}/checkpoints/`),
      `the default checkpoint went to ${backupDir}`,
    );
    assert.equal(typeof backedUp.id, "string");
    assert.ok(backedUp.entries > 5, `the checkpoint holds only ${backedUp.entries} entries`);
    // What the ordinary account produced belongs to it and is private to it.
    assert.equal(statSync(backupDir).uid, launchingUid);
    assert.equal(statSync(backupDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(deployConfig.stateDir, "checkpoints")).mode & 0o777, 0o700);
    assertCheckpointHoldsDeployment(backupDir, agent.id);
    const verifiedBackup = deploy(["verify", configPath, backupDir], environment);
    assert.equal(verifiedBackup.id, backedUp.id);
    // A backup stops the services, so it has to bring back the ones that were running: the owner's
    // deployment keeps serving, and the node is really reconnected rather than merely restarted.
    const afterBackup = deploy(["status", configPath], environment);
    assert.equal(afterBackup.services["control-plane"].state, "running");
    assert.equal(afterBackup.services.node.state, "running");
    await nodeOnline(origin, cookie, nodeIdentity.id, true);

    // A verification that fails is a failure: the owner is told, and the checkpoint is left exactly
    // as it was found rather than being repaired into something that would pass next time.
    step("refuse a checkpoint whose copied bytes changed");
    mkdirSync(join(root, "backups"), { mode: 0o700 });
    const tampered = join(root, "backups", "tampered");
    assert.equal(spawnSync("/bin/cp", ["-a", backupDir, tampered]).status, 0);
    appendFileSync(join(tampered, "homes", agent.id, "ledger.txt"), "tampered\n");
    assert.match(deployFailing(["verify", configPath, tampered], environment), /integrity/i);
    assert.equal(
      readFileSync(join(tampered, "homes", agent.id, "ledger.txt"), "utf8"),
      "once\ntampered\n",
    );

    // A path the account cannot read stops the backup instead of publishing what it managed to
    // copy: no completion marker is written, the failure says what is left is not a backup, and a
    // verification of it refuses it rather than reading the leftovers as one.
    step("refuse to publish a backup it cannot read completely");
    const unreadable = join(workspace, "unreadable"),
      unreadableBackup = join(root, "backups", "unreadable");
    mkdirSync(unreadable, { mode: 0o700 });
    writeFileSync(join(unreadable, "note.txt"), "private note\n", { mode: 0o600 });
    chmodSync(unreadable, 0o000);
    let unreadableReport;
    try {
      unreadableReport = deployFailing(["backup", configPath, unreadableBackup], environment);
    } finally {
      chmodSync(unreadable, 0o700);
    }
    assert.match(unreadableReport, /not a backup/i);
    assert.ok(
      !existsSync(join(unreadableBackup, "complete.json")),
      "a failed backup left a completion marker behind",
    );
    assert.match(
      deployFailing(["verify", configPath, unreadableBackup], environment),
      /incomplete/i,
    );
    // The services the failed backup stopped are running again, so the owner is not left with a
    // deployment that a failed maintenance step silently took down.
    const afterFailedBackup = deploy(["status", configPath], environment);
    assert.equal(afterFailedBackup.services["control-plane"].state, "running");
    assert.equal(afterFailedBackup.services.node.state, "running");
    backupEvidence.ran = true;
    backupEvidence.checkpointOwnerUid = statSync(backupDir).uid;
    backupEvidence.checkpointMode = (statSync(backupDir).mode & 0o777).toString(8);

    // The restore drill, in the order the operations document gives it: stop both services, verify
    // the same checkpoint, restore it, then start again. Everything below is the ordinary account's
    // own permissions on a real kernel, with no root and no service manager.
    step("stop both services, verify the checkpoint, and refuse two bad ones");
    const liveOnlyWorkspace = join(workspace, "live-only.txt"),
      liveOnlyData = join(deployConfig.controlPlaneDataDir, "live-only.txt"),
      memoryEntry = join(workspace, "MEMORY.md"),
      memoryBefore = readFileSync(memoryEntry, "utf8");
    deploy(["stop", configPath], environment);
    assert.equal(
      deploy(["verify", configPath, backupDir], environment).id,
      backedUp.id,
      "the checkpoint no longer verifies after a restore drill has not even started",
    );
    // State that exists only after the checkpoint, which a restore must replace and a refusal must
    // leave alone.
    writeFileSync(liveOnlyWorkspace, "written after the backup\n", { mode: 0o600 });
    writeFileSync(liveOnlyData, "written after the backup\n", { mode: 0o600 });
    rmSync(memoryEntry);

    // A checkpoint whose bytes changed after it was written, and leftovers from a backup that never
    // completed: both are refused, neither prints a report, and the stopped deployment is untouched.
    for (const [label, bad, expected] of [
      ["an altered checkpoint", tampered, /integrity/i],
      ["an incomplete checkpoint", unreadableBackup, /incomplete/i],
    ]) {
      assert.match(deployFailing(["restore", configPath, bad], environment), expected, label);
      assert.ok(existsSync(liveOnlyWorkspace), `${label} was accepted and replaced live state`);
      assert.ok(existsSync(liveOnlyData), `${label} was accepted and replaced live state`);
    }
    const stillStopped = deploy(["status", configPath], environment);
    assert.equal(stillStopped.services["control-plane"].state, "not_running");
    assert.equal(stillStopped.services.node.state, "not_running");
    restoreEvidence.refusedAlteredCheckpoint = true;
    restoreEvidence.refusedIncompleteCheckpoint = true;

    step("restore the verified checkpoint and start both services again");
    const restored = deploy(["restore", configPath, backupDir], environment);
    assert.equal(restored.checkpoint, backupDir);
    assert.equal(restored.id, backedUp.id);
    assert.deepEqual(restored.holds, [], "the restored Agent was not proven and stays held");
    assert.deepEqual(restored.released, [agent.id]);
    assert.equal(restored.previous.length, 3, "the replaced state was not kept for review");
    // Each kept directory really exists, belongs to this account, and still holds the receipts of
    // the state the restore replaced — that is what makes an unknown or late command reviewable.
    for (const replaced of restored.previous) {
      assert.ok(statSync(replaced).isDirectory(), `${replaced} is not a kept state directory`);
      assert.equal(statSync(replaced).uid, launchingUid);
    }
    const keptNodeState = `${deployConfig.nodeDataDir}.mate-before-${restored.id}`;
    assert.ok(
      restored.previous.includes(keptNodeState),
      "the report does not name where the replaced node state went",
    );
    const keptReceipts = new Database(join(keptNodeState, "agent-process-operations.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      assert.ok(
        keptReceipts.prepare("SELECT count(*) AS rows FROM agent_process_operations").get().rows >
          0,
        "the receipts of the replaced node state are not readable where the report says",
      );
    } finally {
      keptReceipts.close();
    }
    // The services the owner had already stopped are not started by the restore: that is the
    // documented `start` step below, and the report says so.
    assert.equal(restored.services["control-plane"].state, "not_running");
    assert.equal(restored.services.node.state, "not_running");
    // A restore returns to the checkpoint: state written after it is gone from the live paths, and
    // the restored workspace is the one the Agent was created with.
    assert.ok(
      !existsSync(liveOnlyWorkspace),
      "a post-checkpoint workspace file survived the restore",
    );
    assert.ok(!existsSync(liveOnlyData), "a post-checkpoint data file survived the restore");
    assert.equal(readFileSync(join(workspace, "ledger.txt"), "utf8"), "once\n");
    assert.equal(readFileSync(memoryEntry, "utf8"), memoryBefore);

    const afterRestoreStart = deploy(["start", configPath], environment);
    assert.equal(afterRestoreStart.services["control-plane"].state, "running");
    assert.equal(afterRestoreStart.services.node.state, "running");
    // The node re-authenticates with the restored key, and the page the owner reads reports it.
    await nodeOnline(origin, cookie, nodeIdentity.id, true);
    // The owner's own login survived the restore, so the same cookie still reads the page.
    const agentsAfterRestore = await request(new URL("/api/owner/agents", origin), {
      headers: { cookie },
    });
    assert.equal(agentsAfterRestore.status, 200);
    const restoredAgent = (await agentsAfterRestore.json()).agents.find(
      (candidate) => candidate.id === agent.id,
    );
    assert.ok(restoredAgent, "the Agent's ID did not survive the restore");
    assert.equal(restoredAgent.linuxIdentity.workspace, workspace);
    assert.equal(restoredAgent.linuxIdentity.uid, launchingUid);
    assert.equal(sessionCount(deployConfig.controlPlaneDataDir, agent.id), 1);
    // The conversation the checkpoint was taken for is live again.
    const restoredHistory = await (
      await request(new URL(`/api/owner/channels/${channelId}/messages`, origin), {
        headers: { cookie },
      })
    ).json();
    assert.ok(
      restoredHistory.messages.some((message) => message.id === agentRequest.messageId),
      "the pre-checkpoint message is missing after the restore",
    );
    // The unfinished task the owner opened before the checkpoint is still open.
    const restoredTasks = await (
      await request(new URL("/api/owner/tasks", origin), { headers: { cookie } })
    ).json();
    assert.ok(
      restoredTasks.tasks.some((task) => task.id === taskId && task.status === "open"),
      "the owner's unfinished task did not survive the restore",
    );
    // The reminder the Agent scheduled for itself is still the same one, still waiting to come due.
    const restoredReminder = (() => {
      const database = new Database(
        join(deployConfig.controlPlaneDataDir, "control-plane.sqlite"),
        { readonly: true, fileMustExist: true },
      );
      try {
        return database
          .prepare("SELECT id,text,due_at,state FROM owner_reminders WHERE id=?")
          .get(reminder.id);
      } finally {
        database.close();
      }
    })();
    assert.deepEqual(restoredReminder, {
      id: reminder.id,
      text: reminder.text,
      due_at: reminder.due_at,
      state: "active",
    });
    restoreEvidence.ran = true;
    restoreEvidence.agentIdentityAndWorkspace = true;
    restoreEvidence.oneLogicalSession = true;
    restoreEvidence.unfinishedTask = true;
    restoreEvidence.reminder = true;
    restoreEvidence.nodeReauthenticated = true;

    // Message delivery continues: one more owner message reaches the restored Agent, runs, and its
    // ordinary command writes in the restored workspace.
    step("ask the restored Agent for one more ordinary command");
    const runsBefore = completedRunCount(deployConfig.controlPlaneDataDir, agent.id);
    await putModelKey(origin, cookie, "synthetic-key-after-restore");
    const continued = await request(new URL(`/api/owner/channels/${channelId}/messages`, origin), {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "恢复后再执行一条普通命令。" }),
    });
    assert.equal(continued.ok, true, "the restored deployment refused the owner's message");
    // A completed run is a durable fact the control plane writes only at the end of one, so a run
    // that failed or never started cannot pass this the way a stale transcript could.
    await eventually(
      () =>
        completedRunCount(deployConfig.controlPlaneDataDir, agent.id) > runsBefore
          ? true
          : undefined,
      "the restored Agent to complete a run from a new owner message",
    );
    assert.equal(readFileSync(join(workspace, "ledger.txt"), "utf8"), "once\nafter-restore\n");
    // And the Agent kept its own record of that run, naming the reminder it scheduled before the
    // checkpoint: the restored deployment still shows the Agent its own unfinished work.
    const finalTurn = sessionTurnText(deployConfig.controlPlaneDataDir, agent.id);
    assert.match(finalTurn, /恢复后仍可执行普通命令。/);
    assert.match(finalTurn, new RegExp(reminder.text));
    restoreEvidence.deliveryContinued = true;
    restoreEvidence.ordinaryCommandAfterRestore = true;
  }

  // Stopping only the node must reach both places the owner looks: the still-running control plane
  // reports that node offline in the web page, and the CLI reports the process is gone.
  step("stop the node and check both diagnostics agree");
  deploy(["stop", configPath, "node"], environment);
  await nodeOnline(origin, cookie, nodeIdentity.id, false);
  const nodeStoppedByCli = deploy(["status", configPath], environment);
  assert.equal(nodeStoppedByCli.services["control-plane"].state, "running");
  assert.equal(nodeStoppedByCli.services.node.state, "not_running");

  // Starting again brings the node back with its saved identity, and stopping everything leaves
  // both reported as not running rather than as a stale "running" claim.
  step("start again, then stop everything");
  deploy(["start", configPath], environment);
  await nodeOnline(origin, cookie, nodeIdentity.id, true);
  const stopped = deploy(["stop", configPath], environment);
  assert.equal(stopped.services["control-plane"].state, "stopped");
  assert.equal(stopped.services.node.state, "stopped");
  const afterStop = deploy(["status", configPath], environment);
  assert.equal(afterStop.services["control-plane"].state, "not_running");
  assert.equal(afterStop.services.node.state, "not_running");

  process.stdout.write(
    `${JSON.stringify({
      mode: "ordinary-account-deployment",
      kernel: process.platform,
      linuxKernel: process.platform === "linux",
      hostEnvironment,
      hostEnvironmentMarker: hostEnvironmentMarker ?? null,
      launchingUid,
      launchedAsRoot: false,
      cli: "dist/src/deployment/cli.js",
      commandsExercised: [
        "install",
        "doctor",
        "start",
        "restart",
        "stop CONFIG node",
        "status",
        ...(backupEvidence.ran ? ["backup CONFIG", "verify CONFIG CHECKPOINT"] : []),
        ...(restoreEvidence.ran
          ? ["stop CONFIG", "restore CONFIG CHECKPOINT", "start CONFIG"]
          : []),
      ],
      controlPlanePort,
      releaseRootAccountOwned: statSync(deployConfig.releaseRoot).uid === launchingUid,
      dataDirsAccountOwned:
        statSync(deployConfig.controlPlaneDataDir).uid === launchingUid &&
        statSync(deployConfig.nodeDataDir).uid === launchingUid,
      serviceStateDirMode: (statSync(deployConfig.stateDir).mode & 0o777).toString(8),
      restartReplacedBothProcesses: true,
      controlPlaneHttpProbe: doctor.controlPlaneHttp,
      agentCreatedFromWeb: true,
      agentAccountUid: agent.linuxIdentity.uid,
      agentAccountUsername: agent.linuxIdentity.username,
      agentWorkspace: workspace,
      ordinaryCommandRanInAgentWorkspace: ledger === "once\n",
      agentReportedCommandResult: reported.results[0].state,
      // The backup the ordinary account made, read back and verified on this kernel. A host that
      // keeps no node workspace receipts reports `false` here rather than an unproven claim.
      backupVerifiedAsOrdinaryAccount: backupEvidence.ran,
      backupCheckpointOwnerUid: backupEvidence.checkpointOwnerUid,
      backupCheckpointMode: backupEvidence.checkpointMode,
      backupHoldsAgentWorkspace: backupEvidence.ran,
      backupHoldsSessionsMessagesTasksRemindersAndReceipts: backupEvidence.ran,
      backupResumedBothServices: backupEvidence.ran,
      backupRefusedTamperedCheckpoint: backupEvidence.ran,
      backupRefusedUnreadablePath: backupEvidence.ran,
      backupRanAsRoot: false,
      // The restore drill on this kernel: a refused checkpoint changes nothing, the verified one is
      // applied, the Agent's identity, one session, message, task and workspace continue, the node
      // authenticates again and the page reports it, and an ordinary command still runs afterwards.
      restoreVerifiedAsOrdinaryAccount: restoreEvidence.ran,
      restoreRefusedAlteredCheckpoint: restoreEvidence.refusedAlteredCheckpoint,
      restoreRefusedIncompleteCheckpoint: restoreEvidence.refusedIncompleteCheckpoint,
      restoreKeptAgentIdentityAndWorkspace: restoreEvidence.agentIdentityAndWorkspace,
      restoreKeptOneLogicalSession: restoreEvidence.oneLogicalSession,
      restoreKeptUnfinishedTask: restoreEvidence.unfinishedTask,
      restoreKeptAgentReminder: restoreEvidence.reminder,
      restoreKeptPendingWorkAndRanAgain: restoreEvidence.deliveryContinued,
      restoreOrdinaryCommandRanAfterRestore: restoreEvidence.ordinaryCommandAfterRestore,
      restoredNodeReauthenticatedAndPageShowsOnline: restoreEvidence.nodeReauthenticated,
      restoreRanAsRoot: false,
      nodeStoppedStateReported: stopped.services.node.state,
      // The host this ran on, so a low-resource VPS claim can be checked against real numbers
      // instead of being assumed from the ticket.
      hostFacts: {
        cpuCount: availableParallelism(),
        memoryMiB: Math.floor(totalMemoryBytes() / 1024 / 1024),
        diskFreeMiBAtDataDir: Math.floor(diskFreeBytes(deployConfig.nodeDataDir) / 1024 / 1024),
        uptimeSeconds: Math.floor(process.uptime()),
      },
      serviceStateDirMode: (statSync(deployConfig.stateDir).mode & 0o777).toString(8),
      serviceManagerSocketAdvertised: notifySocketPath,
      serviceManagerNotifierBinaryPresent: existsSync("/usr/bin/systemd-notify"),
      ranAsRoot: false,
    })}\n`,
  );
} finally {
  try {
    deploy(["stop", configPath]);
  } catch {
    /* The check may have failed before the services started. */
  }
  rmSync(root, { recursive: true, force: true });
}
