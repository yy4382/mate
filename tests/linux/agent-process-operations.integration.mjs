import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { AgentProcessOperations } from "../../dist/src/nodes/process-operations.js";
import {
  createLinuxAgentProcessExecutor,
  agentProcessUnit,
} from "../../dist/src/nodes/linux-process-executor.js";
import {
  linuxUsernameForAgentId,
  provisionLinuxAgent,
} from "../../dist/src/nodes/agent-provisioner.js";

if (process.platform !== "linux" || process.geteuid?.() !== 0 || !existsSync("/.dockerenv"))
  throw new Error("Run process isolation checks as root inside a disposable Linux container.");
if (process.env.MATE_PROCESS_TEST_SANDBOX !== "temporary-container")
  throw new Error("Refusing process isolation checks outside an explicitly disposable container.");
if (!existsSync("/run/systemd/system"))
  throw new Error(
    "The disposable Linux container must boot systemd to validate real Agent scopes.",
  );
for (const path of ["/usr/bin/setpriv", "/usr/bin/systemd-run", "/usr/bin/systemctl"])
  if (!existsSync(path)) throw new Error(`Required Linux executable is missing: ${path}`);

function required(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
  });
  if (result.error || result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.error}`);
  return result.stdout.trim();
}

function bestEffort(command, args) {
  spawnSync(command, args, {
    encoding: "utf8",
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
  });
}

function installAgentSlice(uid) {
  const unit = `mate-agent-${uid}.slice`,
    path = `/etc/systemd/system/${unit}`;
  writeFileSync(
    path,
    `[Unit]\nDescription=Mate process validation slice\n\n[Slice]\nMemoryMax=256M\nTasksMax=128\nCPUQuota=50%\n`,
    { mode: 0o644 },
  );
  chmodSync(path, 0o644);
  return { unit, path };
}

async function waitForPidExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(`/proc/${pid}`)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Agent process ${pid} did not exit`);
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

const homeRoot = `/var/lib/mate-process-validation-${randomUUID()}`,
  nodeData = `${homeRoot}-node-data`,
  agentAId = randomUUID(),
  agentBId = randomUUID(),
  agents = [],
  slices = [],
  databasePath = join(nodeData, "operations.sqlite"),
  cpSecretPath = join(nodeData, "control-plane-credentials.json");
let database;

try {
  mkdirSync(homeRoot, { mode: 0o755 });
  mkdirSync(nodeData, { mode: 0o700 });
  chmodSync(homeRoot, 0o755);
  chmodSync(nodeData, 0o700);
  for (const agentId of [agentAId, agentBId]) {
    const agent = await provisionLinuxAgent({ agentId, homeRoot });
    agents.push(agent);
    slices.push(installAgentSlice(agent.uid));
  }
  required("/usr/bin/systemctl", ["daemon-reload"]);
  for (const slice of slices) required("/usr/bin/systemctl", ["start", slice.unit]);

  writeFileSync(cpSecretPath, "synthetic-control-plane-credential\n", { mode: 0o600 });
  chmodSync(cpSecretPath, 0o600);
  database = new Database(databasePath);
  chmodSync(databasePath, 0o600);
  const executor = createLinuxAgentProcessExecutor(homeRoot, { commandTimeoutMs: 60_000 }),
    operations = new AgentProcessOperations(database, executor),
    [agentA, agentB] = agents;
  assert.ok(agentA && agentB);
  assert.equal(mode(homeRoot), 0o755);
  assert.equal(mode(agentA.home), 0o700);
  assert.equal(mode(agentB.home), 0o700);
  assert.equal(mode(nodeData), 0o700);
  assert.equal(mode(cpSecretPath), 0o600);

  const identityOperation = {
      kind: "exec",
      cwd: ".",
      command: `printf '%s\\n' "$(id -u)" "$(id -g)" "$(id -G)"; if [ "$(id -u)" -eq 0 ]; then exit 70; fi; if cat '${agentB.home}/MEMORY.md' >/dev/null 2>&1; then exit 71; fi; if cat '${cpSecretPath}' >/dev/null 2>&1; then exit 72; fi; printf isolated`,
    },
    identityReceipt = await operations.execute(agentAId, randomUUID(), identityOperation);
  assert.equal(identityReceipt.state, "succeeded");
  const identityOutput = identityReceipt.receipt.stdout.trim().split("\n");
  assert.deepEqual(identityOutput.slice(0, 3), [
    String(agentA.uid),
    String(agentA.gid),
    String(agentA.gid),
  ]);
  assert.equal(identityOutput.at(-1), "isolated");

  const operationId = randomUUID(),
    background = await operations.execute(agentAId, operationId, {
      kind: "exec",
      cwd: ".",
      command: "sleep 300 >/dev/null 2>&1 & printf '%s' \"$!\"",
    });
  assert.equal(background.state, "succeeded");
  assert.equal(background.receipt.processUnit, agentProcessUnit(agentA.uid, operationId));
  const backgroundPid = Number(background.receipt.stdout);
  assert.ok(Number.isSafeInteger(backgroundPid) && backgroundPid > 1);
  const processStatus = readFileSync(`/proc/${backgroundPid}/status`, "utf8"),
    processUid = Number(processStatus.match(/^Uid:\s+(\d+)/m)?.[1]),
    processGid = Number(processStatus.match(/^Gid:\s+(\d+)/m)?.[1]);
  assert.equal(processUid, agentA.uid);
  assert.equal(processGid, agentA.gid);

  const listA = await operations.execute(agentAId, randomUUID(), { kind: "process.list" });
  assert.equal(listA.state, "succeeded");
  assert.ok(listA.receipt.processes.some((process) => process.operationId === operationId));
  const inspected = await operations.execute(agentAId, randomUUID(), {
    kind: "process.inspect",
    targetOperationId: operationId,
  });
  assert.equal(inspected.receipt.operationId, operationId);
  assert.equal(inspected.receipt.state, "running");
  assert.ok(inspected.receipt.pids.includes(backgroundPid));

  const peerOperationId = randomUUID(),
    peerBackground = await operations.execute(agentBId, peerOperationId, {
      kind: "exec",
      cwd: ".",
      command: "sleep 300 >/dev/null 2>&1 & printf '%s' \"$!\"",
    }),
    peerPid = Number(peerBackground.receipt.stdout);
  assert.equal(peerBackground.state, "succeeded");
  const listB = await operations.execute(agentBId, randomUUID(), { kind: "process.list" });
  assert.ok(listB.receipt.processes.some((process) => process.operationId === peerOperationId));
  assert.ok(!listA.receipt.processes.some((process) => process.operationId === peerOperationId));

  const stopResult = await operations.execute(agentAId, randomUUID(), {
    kind: "process.stop",
    targetOperationId: operationId,
  });
  assert.equal(stopResult.state, "succeeded");
  await waitForPidExit(backgroundPid);
  assert.ok(existsSync(`/proc/${peerPid}`), "Stopping Agent A must leave Agent B's process alive");

  const onceId = randomUUID(),
    onceCommand = {
      kind: "exec",
      cwd: ".",
      command: 'printf x >> "$HOME/once-marker"; printf once',
    },
    once = await operations.execute(agentAId, onceId, onceCommand);
  assert.equal(once.state, "succeeded");
  database.close();
  database = new Database(databasePath);
  const recovered = new AgentProcessOperations(database, executor),
    replay = await recovered.execute(agentAId, onceId, onceCommand);
  assert.deepEqual(replay, once);
  assert.equal(readFileSync(join(agentA.home, "once-marker"), "utf8"), "x");
  await assert.rejects(
    recovered.execute(agentAId, onceId, {
      ...onceCommand,
      command: 'printf y >> "$HOME/once-marker"',
    }),
    /identity conflict/,
  );

  const output = await recovered.execute(agentAId, randomUUID(), {
    kind: "exec",
    cwd: ".",
    command: "head -c 100000 /dev/zero | tr '\\000' x",
  });
  assert.equal(output.state, "succeeded");
  assert.equal(output.receipt.stdout.length, 65_536);
  assert.equal(output.receipt.truncated, true);

  const timeoutDatabase = new Database(":memory:"),
    timeoutOperations = new AgentProcessOperations(
      timeoutDatabase,
      createLinuxAgentProcessExecutor(homeRoot, { commandTimeoutMs: 1000 }),
    ),
    timedOut = await timeoutOperations.execute(agentAId, randomUUID(), {
      kind: "exec",
      cwd: ".",
      command: "sleep 300 >/dev/null 2>&1 & echo $! > timeout-pid; wait",
    }),
    timeoutPid = Number(readFileSync(join(agentA.home, "timeout-pid"), "utf8").trim());
  try {
    assert.equal(timedOut.state, "unknown");
    await waitForPidExit(timeoutPid);
  } finally {
    timeoutDatabase.close();
  }

  await recovered.execute(agentBId, randomUUID(), {
    kind: "process.stop",
    targetOperationId: peerOperationId,
  });
  await waitForPidExit(peerPid);
  process.stdout.write(
    `${JSON.stringify({
      mode: "real-linux-container",
      agentA: { uid: agentA.uid, gid: agentA.gid },
      agentB: { uid: agentB.uid, gid: agentB.gid },
      credentialAndPeerHomeDenied: true,
      peerProcessSurvivedOtherAgentStop: true,
      scopePersistedAndStopped: true,
      duplicateOperationReplayedReceipt: true,
      outputLimitBytes: output.receipt.stdout.length,
      commandDeadlineState: timedOut.state,
      resourceQuotaVerified: true,
    })}\n`,
  );
} finally {
  if (database?.open) database.close();
  for (const agent of agents)
    bestEffort("/usr/bin/systemctl", ["stop", `mate-agent-${agent.uid}.slice`]);
  for (const slice of slices) rmSync(slice.path, { force: true });
  bestEffort("/usr/bin/systemctl", ["daemon-reload"]);
  for (const agentId of [agentAId, agentBId]) {
    const username = linuxUsernameForAgentId(agentId);
    bestEffort("/usr/sbin/userdel", ["--remove", username]);
    bestEffort("/usr/sbin/groupdel", [username]);
  }
  rmSync(homeRoot, { recursive: true, force: true });
  rmSync(nodeData, { recursive: true, force: true });
}
