// Prepare two Agent workspaces on the account that is already running this check, and verify the
// single-account facts a full Agent creation depends on. No root, no container, no service manager,
// and no Mate-specific Linux account: this is the workspace and memory-entry seam behind the node's
// `control.agent.provision` handler, exercised in the real file system.
//
// A macOS run is cross-platform evidence only; record real Linux results separately.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import {
  AgentProvisioningError,
  prepareAgentWorkspace,
  readAgentWorkspaceIdentity,
} from "@mate/node/agent-provisioner";

const launchingUid = typeof process.getuid === "function" ? process.getuid() : undefined;
if (launchingUid === 0)
  throw new Error("Run this check as the ordinary launching account, not as root.");

const root = mkdtempSync(join(tmpdir(), "mate-agent-workspace-"));
const agentAId = randomUUID();
const agentBId = randomUUID();
const mode = (path) => statSync(path).mode & 0o777;

try {
  const agentA = await prepareAgentWorkspace({ agentId: agentAId, workspaceRoot: root });
  const agentB = await prepareAgentWorkspace({ agentId: agentBId, workspaceRoot: root });

  assert.equal(agentA.username, userInfo().username);
  assert.equal(agentA.uid, launchingUid);
  if (typeof process.getgid === "function") assert.equal(agentA.gid, process.getgid());
  // Two Agents, one ordinary account, two separate workspaces.
  assert.notEqual(agentA.workspace, agentB.workspace);
  assert.notEqual(agentA.workspaceMarker, agentB.workspaceMarker);
  assert.deepEqual(
    { username: agentB.username, uid: agentB.uid, gid: agentB.gid },
    { username: agentA.username, uid: agentA.uid, gid: agentA.gid },
  );

  for (const agent of [agentA, agentB]) {
    assert.equal(agent.workspace, join(root, basename(agent.workspace)));
    assert.equal(lstatSync(agent.workspace).isDirectory(), true);
    assert.equal(mode(agent.workspace), 0o700);
    const memory = join(agent.workspace, "MEMORY.md");
    assert.equal(lstatSync(memory).isFile(), true);
    assert.equal(mode(memory), 0o600);
    assert.match(readFileSync(memory, "utf8"), /memory/);
    assert.deepEqual(readAgentWorkspaceIdentity(basename(agent.workspace), root), agent);
  }

  // Retrying the same creation request reuses the workspace and its identity marker.
  writeFileSync(join(agentA.workspace, "notes.md"), "Agent-authored notes\n", { mode: 0o600 });
  const retried = await prepareAgentWorkspace({ agentId: agentAId, workspaceRoot: root });
  assert.deepEqual(retried, agentA);
  assert.equal(readFileSync(join(retried.workspace, "notes.md"), "utf8"), "Agent-authored notes\n");

  // A workspace that no longer carries Mate's marker and holds other content is reported, never
  // adopted or erased, so a failure stays diagnosable instead of silently merging two Agents' data.
  const foreignId = randomUUID();
  const foreign = await prepareAgentWorkspace({ agentId: foreignId, workspaceRoot: root });
  rmSync(join(foreign.workspace, ".mate-workspace-id"));
  writeFileSync(join(foreign.workspace, "foreign.txt"), "not ours\n", { mode: 0o600 });
  await assert.rejects(
    () => prepareAgentWorkspace({ agentId: foreignId, workspaceRoot: root }),
    (error) => error instanceof AgentProvisioningError && error.code === "identity_mismatch",
  );
  assert.equal(readFileSync(join(foreign.workspace, "foreign.txt"), "utf8"), "not ours\n");

  process.stdout.write(
    `${JSON.stringify({
      check: "single-account-agent-workspace",
      kernel: process.platform,
      linuxKernel: process.platform === "linux",
      launchingUid,
      launchingAccount: userInfo().username,
      ranAsRoot: false,
      agentsPrepared: 2,
      sharedAccountAcrossAgents: true,
      distinctWorkspaces: true,
      workspaceMode: mode(agentA.workspace).toString(8),
      memoryEntryMode: mode(join(agentA.workspace, "MEMORY.md")).toString(8),
      retryReusedWorkspace: true,
      foreignDirectoryRejected: true,
    })}\n`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
