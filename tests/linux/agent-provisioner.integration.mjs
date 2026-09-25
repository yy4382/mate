import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  chownSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  AgentProvisioningError,
  linuxUsernameForAgentId,
  provisionLinuxAgent,
} from "../../dist/src/nodes/agent-provisioner.js";

if (process.platform !== "linux" || process.geteuid?.() !== 0)
  throw new Error("Run this focused validation as root inside a disposable Linux container.");
if (!existsSync("/.dockerenv"))
  throw new Error("Refusing to create test accounts outside an isolated Docker container.");
if (process.env.MATE_AGENT_TEST_SANDBOX !== "temporary-container")
  throw new Error(
    "Refusing to create test accounts without MATE_AGENT_TEST_SANDBOX=temporary-container.",
  );

const homeRoot = `/var/lib/mate-agent-validation-${randomUUID()}`;
const agentAId = "ed1e60c8-bdda-4f46-a857-bbd542f82640";
const agentBId = "a82eb7db-26f7-40f8-9bb8-8baf21dc5c0a";
const collisionAId = "deadbeef-cafe-4bad-a11e-001122334455";
const collisionBId = "deadbeef-cafe-4bad-a11e-001122334499";

function required(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.error}`);
  return result.stdout.trim();
}

function setpriv(username, command, args) {
  const passwd = required("/usr/bin/getent", ["passwd", username]).split(":");
  return spawnSync(
    "/usr/bin/setpriv",
    [`--reuid=${passwd[2]}`, `--regid=${passwd[3]}`, "--clear-groups", command, ...args],
    { encoding: "utf8" },
  );
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

function assertProvisionError(agentId, code) {
  return assert.rejects(
    provisionLinuxAgent({ agentId, homeRoot }),
    (error) => error instanceof AgentProvisioningError && error.code === code,
  );
}

try {
  const [agentA, concurrentRetry] = await Promise.all([
    provisionLinuxAgent({ agentId: agentAId, homeRoot }),
    provisionLinuxAgent({ agentId: agentAId, homeRoot }),
  ]);
  const agentB = await provisionLinuxAgent({ agentId: agentBId, homeRoot });
  assert.deepEqual(concurrentRetry, agentA);
  assert.notEqual(agentA.uid, agentB.uid);
  assert.notEqual(agentA.gid, agentB.gid);
  assert.equal(agentA.username, linuxUsernameForAgentId(agentAId));
  assert.equal(agentB.username, linuxUsernameForAgentId(agentBId));
  assert.equal(mode(homeRoot), 0o755);
  assert.equal(mode(agentA.home), 0o700);
  assert.equal(mode(agentB.home), 0o700);
  assert.equal(mode(join(agentA.home, "MEMORY.md")), 0o600);
  assert.equal(mode(join(agentB.home, "MEMORY.md")), 0o600);
  assert.equal(statSync(agentA.home).uid, agentA.uid);
  assert.equal(statSync(agentA.home).gid, agentA.gid);
  assert.equal(statSync(join(agentA.home, "MEMORY.md")).uid, agentA.uid);
  assert.equal(statSync(join(agentA.home, "MEMORY.md")).gid, agentA.gid);
  assert.equal(statSync(agentB.home).uid, agentB.uid);
  assert.equal(statSync(agentB.home).gid, agentB.gid);

  const marker = join(agentA.home, "peer-private-fixture.txt");
  writeFileSync(marker, "synthetic private fixture\n", { mode: 0o600 });
  chownSync(marker, agentA.uid, agentA.gid);
  chmodSync(marker, 0o600);
  const ownRead = setpriv(agentA.username, "/usr/bin/cat", [marker]);
  const peerRead = setpriv(agentB.username, "/usr/bin/cat", [marker]);
  const peerList = setpriv(agentB.username, "/usr/bin/ls", [agentA.home]);
  assert.equal(ownRead.status, 0, ownRead.stderr);
  assert.equal(ownRead.stdout, "synthetic private fixture\n");
  assert.notEqual(peerRead.status, 0);
  assert.notEqual(peerList.status, 0);

  const accountCountBefore = required("/usr/bin/getent", ["passwd", agentA.username]).split(
    "\n",
  ).length;
  const memoryBefore = readFileSync(join(agentA.home, "MEMORY.md"), "utf8");
  const repeatedA = await provisionLinuxAgent({ agentId: agentAId, homeRoot });
  const accountCountAfter = required("/usr/bin/getent", ["passwd", agentA.username]).split(
    "\n",
  ).length;
  assert.equal(repeatedA.uid, agentA.uid);
  assert.equal(repeatedA.gid, agentA.gid);
  assert.equal(accountCountAfter, accountCountBefore);
  assert.equal(readFileSync(join(agentA.home, "MEMORY.md"), "utf8"), memoryBefore);

  // Simulate a process stopping after a template-prefix write and before chown.
  const interruptedMemory = join(agentA.home, "MEMORY.md");
  writeFileSync(interruptedMemory, memoryBefore.slice(0, Math.floor(memoryBefore.length / 2)), {
    mode: 0o600,
  });
  chownSync(interruptedMemory, 0, 0);
  chmodSync(interruptedMemory, 0o600);
  const recoveredA = await provisionLinuxAgent({ agentId: agentAId, homeRoot });
  assert.equal(recoveredA.uid, agentA.uid);
  assert.equal(recoveredA.gid, agentA.gid);
  assert.equal(readFileSync(interruptedMemory, "utf8"), memoryBefore);
  assert.equal(statSync(interruptedMemory).uid, agentA.uid);
  assert.equal(statSync(interruptedMemory).gid, agentA.gid);
  assert.equal(mode(interruptedMemory), 0o600);

  assert.equal(linuxUsernameForAgentId(collisionAId), linuxUsernameForAgentId(collisionBId));
  const collisionOwner = await provisionLinuxAgent({ agentId: collisionAId, homeRoot });
  await assertProvisionError(collisionBId, "identity_mismatch");
  assert.equal(
    required("/usr/bin/getent", ["passwd", collisionOwner.username]).split("\n").length,
    1,
  );
  assert.equal(existsSync(join(homeRoot, collisionBId)), false);

  const occupiedId = randomUUID();
  const occupiedUsername = linuxUsernameForAgentId(occupiedId);
  required("/usr/sbin/useradd", [
    "--system",
    "--user-group",
    "--no-create-home",
    "--home-dir",
    "/home/unrelated-fixture",
    "--shell",
    "/usr/sbin/nologin",
    "--comment",
    "Unrelated fixture account",
    "--",
    occupiedUsername,
  ]);
  const unrelatedBefore = required("/usr/bin/getent", ["passwd", occupiedUsername]);
  await assertProvisionError(occupiedId, "identity_mismatch");
  assert.equal(required("/usr/bin/getent", ["passwd", occupiedUsername]), unrelatedBefore);
  assert.equal(existsSync(join(homeRoot, occupiedId)), false);

  const pathCollisionId = randomUUID();
  mkdirSync(join(homeRoot, pathCollisionId), { mode: 0o700 });
  await assertProvisionError(pathCollisionId, "account_conflict");
  assert.equal(existsSync(join(homeRoot, pathCollisionId)), true);

  const groupCollisionId = randomUUID();
  const groupCollisionName = linuxUsernameForAgentId(groupCollisionId);
  required("/usr/sbin/groupadd", ["--system", "--", groupCollisionName]);
  await assertProvisionError(groupCollisionId, "account_conflict");
  assert.equal(spawnSync("/usr/bin/getent", ["passwd", groupCollisionName]).status, 2);

  const symlinkRoot = `${homeRoot}-symlink`;
  const symlinkId = randomUUID();
  const symlinkTarget = `${homeRoot}-target`;
  mkdirSync(symlinkTarget, { recursive: true, mode: 0o700 });
  required("/usr/bin/ln", ["-s", symlinkTarget, symlinkRoot]);
  await assert.rejects(
    provisionLinuxAgent({ agentId: symlinkId, homeRoot: symlinkRoot }),
    (error) => error instanceof AgentProvisioningError && error.code === "identity_mismatch",
  );
  await assert.rejects(
    provisionLinuxAgent({ agentId: randomUUID(), homeRoot: "/tmp" }),
    (error) => error instanceof AgentProvisioningError && error.code === "identity_mismatch",
  );

  required("/usr/sbin/useradd", [
    "--system",
    "--user-group",
    "--no-create-home",
    "--uid",
    String(agentA.uid),
    "--non-unique",
    "--home-dir",
    "/home/mate-agent-shared-uid-fixture",
    "--shell",
    "/usr/sbin/nologin",
    "--comment",
    "Synthetic shared UID fixture",
    "--",
    "mate_agent_shared_uid_fixture",
  ]);
  await assertProvisionError(agentAId, "identity_mismatch");
  required("/usr/sbin/groupadd", [
    "--system",
    "--non-unique",
    "--gid",
    String(agentB.gid),
    "--",
    "mate_agent_shared_gid_fixture",
  ]);
  await assertProvisionError(agentBId, "identity_mismatch");

  const memoryCollisionPath = join(agentA.home, "MEMORY.md");
  const memoryCollision = "synthetic unrelated root-owned MEMORY.md\n";
  writeFileSync(memoryCollisionPath, memoryCollision, { mode: 0o600 });
  chownSync(memoryCollisionPath, 0, 0);
  chmodSync(memoryCollisionPath, 0o600);
  await assertProvisionError(agentAId, "identity_mismatch");
  assert.equal(readFileSync(memoryCollisionPath, "utf8"), memoryCollision);

  process.stdout.write(
    `${JSON.stringify({
      mode: "real-linux-container",
      kernel: process.platform,
      homeRoot,
      agentA,
      agentB,
      modes: {
        homeRoot: `0${mode(homeRoot).toString(8)}`,
        home: `0${mode(agentA.home).toString(8)}`,
        memory: `0${mode(join(agentA.home, "MEMORY.md")).toString(8)}`,
      },
      crossRead: { ownRead: ownRead.status, peerRead: peerRead.status, peerList: peerList.status },
      sameIdRetryPreservedUid: repeatedA.uid === agentA.uid,
      conflictingUsernameRejected: true,
      occupiedHomeRejected: true,
      occupiedGroupRejected: true,
      symlinkRootRejected: true,
      sharedWritableHomeRootRejected: true,
      duplicateUidRejected: true,
      duplicateGidRejected: true,
      interruptedMemoryWriteRecovered: true,
      unrelatedMemoryCollisionPreserved: true,
    })}\n`,
  );
} finally {
  rmSync(homeRoot, { recursive: true, force: true });
  rmSync(`${homeRoot}-symlink`, { recursive: true, force: true });
  rmSync(`${homeRoot}-target`, { recursive: true, force: true });
}
