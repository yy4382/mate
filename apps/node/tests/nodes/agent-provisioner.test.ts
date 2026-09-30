import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  AgentProvisioningError,
  agentWorkspacePath,
  nodeAccountIdentity,
  prepareAgentWorkspace,
  readAgentWorkspaceIdentity,
} from "../../src/nodes/agent-provisioner.js";
import { NodeControlMessageSchema, type NodeRequest } from "@mate/protocol";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mate-agent-workspace-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

it("refuses to report a node account when the node runs as root", async () => {
  // The launching account is the Agent's account in this release, and root is not that account.
  // `getuid` is substituted because a test suite might itself be running as root in a container.
  const original = process.getuid;
  Object.defineProperty(process, "getuid", { value: () => 0, configurable: true });
  try {
    expect(() => nodeAccountIdentity()).toThrow(AgentProvisioningError);
  } finally {
    Object.defineProperty(process, "getuid", { value: original, configurable: true });
  }
});

it("creates an Agent workspace under the running account without touching Linux accounts", async () => {
  const workspaceRoot = temporaryRoot(),
    agentId = randomUUID(),
    identity = await prepareAgentWorkspace({ agentId, workspaceRoot });

  expect(identity.workspace).toBe(join(resolve(workspaceRoot), agentId));
  expect(statSync(identity.workspace).isDirectory()).toBe(true);
  expect((statSync(identity.workspace).mode & 0o777).toString(8)).toBe("700");
  // The account facts are the launching account's own, so Mate never creates or switches identity.
  const account = nodeAccountIdentity();
  expect(identity.username).toBe(account.username);
  expect(typeof identity.username).toBe("string");
  expect(identity.workspaceMarker).toMatch(/^[0-9a-f]{64}$/);
  if (typeof process.getuid === "function") expect(identity.uid).toBe(process.getuid());
  if (typeof process.getgid === "function") expect(identity.gid).toBe(process.getgid());
  expect(readAgentWorkspaceIdentity(agentId, workspaceRoot)).toEqual(identity);
});

it("provides a memory entry point that is readable and writable by the Agent", async () => {
  const workspaceRoot = temporaryRoot(),
    agentId = randomUUID(),
    identity = await prepareAgentWorkspace({ agentId, workspaceRoot }),
    memoryPath = join(identity.workspace, "MEMORY.md"),
    memory = statSync(memoryPath);

  expect(memory.isFile()).toBe(true);
  expect(memory.isSymbolicLink()).toBe(false);
  expect((memory.mode & 0o777).toString(8)).toBe("600");
  expect(readFileSync(memoryPath, "utf8")).toContain("memory");
  expect(readdirSync(identity.workspace).sort()).toEqual([".mate-workspace-id", "MEMORY.md"]);
});

it("reuses the same workspace and marker when the same creation request is retried", async () => {
  const workspaceRoot = temporaryRoot(),
    agentId = randomUUID(),
    first = await prepareAgentWorkspace({ agentId, workspaceRoot });
  writeFileSync(join(first.workspace, "notes.md"), "Agent-authored notes\n");

  const retried = await prepareAgentWorkspace({ agentId, workspaceRoot });

  expect(retried).toEqual(first);
  expect(readFileSync(join(retried.workspace, "notes.md"), "utf8")).toBe("Agent-authored notes\n");
  expect(readdirSync(workspaceRoot)).toEqual([agentId]);
});

it("gives two Agents different workspaces under the same single account", async () => {
  const workspaceRoot = temporaryRoot(),
    firstAgent = randomUUID(),
    secondAgent = randomUUID(),
    [first, second] = await Promise.all([
      prepareAgentWorkspace({ agentId: firstAgent, workspaceRoot }),
      prepareAgentWorkspace({ agentId: secondAgent, workspaceRoot }),
    ]);

  expect(first.workspace).not.toBe(second.workspace);
  expect(first.workspaceMarker).not.toBe(second.workspaceMarker);
  // One ordinary account carries both Agents: same username, UID and GID, separate workspaces.
  expect({ username: first.username, uid: first.uid, gid: first.gid }).toEqual({
    username: second.username,
    uid: second.uid,
    gid: second.gid,
  });
  expect(readdirSync(workspaceRoot).sort()).toEqual([firstAgent, secondAgent].sort());
});

it("finishes a creation that crashed after staging the workspace marker", async () => {
  const workspaceRoot = temporaryRoot(),
    agentId = randomUUID();
  // The exact state an interrupted create leaves: the workspace directory with one staged marker
  // file that was never published under its final name. Retrying must finish, not refuse.
  const workspace = agentWorkspacePath(workspaceRoot, agentId);
  mkdirSync(workspace, { mode: 0o700 });
  writeFileSync(
    join(workspace, `.mate-workspace-id.tmp-${"a".repeat(32)}`),
    `${"b".repeat(64)}\n`,
    {
      mode: 0o600,
    },
  );

  const identity = await prepareAgentWorkspace({ agentId, workspaceRoot });

  expect(identity.workspace).toBe(workspace);
  expect(identity.workspaceMarker).toMatch(/^[0-9a-f]{64}$/);
  expect(readdirSync(workspace).sort()).toEqual([".mate-workspace-id", "MEMORY.md"]);
  expect(readAgentWorkspaceIdentity(agentId, workspaceRoot)).toEqual(identity);
});

it("finishes a creation that crashed between creating the staging file and writing it", async () => {
  const workspaceRoot = temporaryRoot(),
    agentId = randomUUID(),
    workspace = agentWorkspacePath(workspaceRoot, agentId);
  mkdirSync(workspace, { mode: 0o700 });
  writeFileSync(join(workspace, `.mate-workspace-id.tmp-${"d".repeat(32)}`), "", { mode: 0o600 });

  const identity = await prepareAgentWorkspace({ agentId, workspaceRoot });

  expect(identity.workspace).toBe(workspace);
  expect(readdirSync(workspace).sort()).toEqual([".mate-workspace-id", "MEMORY.md"]);
});

it("reports, and never deletes, staging-named content that is not Mate's own staging file", async () => {
  const workspaceRoot = temporaryRoot(),
    agentId = randomUUID(),
    workspace = agentWorkspacePath(workspaceRoot, agentId),
    impostor = join(workspace, `.mate-workspace-id.tmp-${"e".repeat(32)}`);
  mkdirSync(workspace, { mode: 0o700 });
  // A name Mate recognises is not a licence to remove whatever now sits under it.
  writeFileSync(impostor, "somebody else's notes\n", { mode: 0o600 });

  await expect(prepareAgentWorkspace({ agentId, workspaceRoot })).rejects.toMatchObject({
    code: "identity_mismatch",
  });
  expect(readFileSync(impostor, "utf8")).toBe("somebody else's notes\n");
});

it("finishes a creation that crashed between publishing the marker and removing its staging name", async () => {
  const workspaceRoot = temporaryRoot(),
    agentId = randomUUID(),
    first = await prepareAgentWorkspace({ agentId, workspaceRoot }),
    markerPath = join(first.workspace, ".mate-workspace-id"),
    stagingPath = join(first.workspace, `.mate-workspace-id.tmp-${"c".repeat(32)}`);
  // Re-create the published marker's second link, as a crash before `unlink` would leave it.
  const { linkSync } = await import("node:fs");
  linkSync(markerPath, stagingPath);

  const retried = await prepareAgentWorkspace({ agentId, workspaceRoot });

  expect(retried).toEqual(first);
  expect(readdirSync(first.workspace).sort()).toEqual([".mate-workspace-id", "MEMORY.md"]);
});

it("refuses to adopt an existing directory that Mate did not create for this Agent", async () => {
  const workspaceRoot = temporaryRoot(),
    agentId = randomUUID();
  mkdirSync(agentWorkspacePath(workspaceRoot, agentId), { mode: 0o700 });
  writeFileSync(join(agentWorkspacePath(workspaceRoot, agentId), "foreign.txt"), "not ours\n");

  await expect(prepareAgentWorkspace({ agentId, workspaceRoot })).rejects.toMatchObject({
    code: "identity_mismatch",
  });
  // The foreign directory is reported, never repaired or erased.
  expect(existsSync(join(agentWorkspacePath(workspaceRoot, agentId), "foreign.txt"))).toBe(true);
});

it("reports a diagnosable failure when it cannot write the workspace root", async () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const parent = temporaryRoot(),
    workspaceRoot = join(parent, "locked");
  mkdirSync(workspaceRoot, { mode: 0o500 });
  chmodSync(workspaceRoot, 0o500);

  await expect(
    prepareAgentWorkspace({ agentId: randomUUID(), workspaceRoot }),
  ).rejects.toMatchObject({ code: "permission_denied" });
});

it("rejects a workspace root that is not an absolute real directory", async () => {
  await expect(
    prepareAgentWorkspace({ agentId: randomUUID(), workspaceRoot: "relative/agents" }),
  ).rejects.toBeInstanceOf(AgentProvisioningError);

  const parent = temporaryRoot(),
    real = join(parent, "real"),
    link = join(parent, "link");
  mkdirSync(real, { mode: 0o700 });
  try {
    const { symlinkSync } = await import("node:fs");
    symlinkSync(real, link);
  } catch {
    return;
  }
  await expect(
    prepareAgentWorkspace({ agentId: randomUUID(), workspaceRoot: link }),
  ).rejects.toMatchObject({ code: "identity_mismatch" });
});

it("handles only the constrained provision request and returns verified workspace facts", async () => {
  const agentId = "ed1e60c8-bdda-4f46-a857-bbd542f82640",
    command = NodeControlMessageSchema.parse({
      type: "control.agent.provision",
      requestId: "3c7f7fc3-b613-4d26-9696-4aecac8565b8",
      agentId,
    }) as Extract<
      ReturnType<typeof NodeControlMessageSchema.parse>,
      { type: "control.agent.provision" }
    >,
    sent: NodeRequest[] = [];
  const accepted = await handleProvision(command, sent, async (requestedAgent, progress) => {
    expect(requestedAgent).toBe(agentId);
    progress("checking_account");
    progress("preparing_workspace");
    return {
      username: "mate-node-account",
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${agentId}`,
      workspaceMarker: "a".repeat(64),
    };
  });

  expect(accepted).toBe(true);
  expect(sent).toEqual([
    {
      type: "node.agent.provision.progress",
      requestId: command.requestId,
      agentId,
      stage: "checking_account",
    },
    {
      type: "node.agent.provision.progress",
      requestId: command.requestId,
      agentId,
      stage: "preparing_workspace",
    },
    {
      type: "node.agent.provision.result",
      requestId: command.requestId,
      agentId,
      ok: true,
      identity: {
        username: "mate-node-account",
        uid: 23001,
        gid: 23001,
        workspace: `/var/lib/mate/agents/${agentId}`,
        workspaceMarker: "a".repeat(64),
      },
    },
  ]);
});

it("reports a bounded, diagnosable failure without exposing arbitrary host error text", async () => {
  const agentId = "ed1e60c8-bdda-4f46-a857-bbd542f82640",
    command = NodeControlMessageSchema.parse({
      type: "control.agent.provision",
      requestId: "5b782025-b80f-4cb5-b855-aad347c0d8db",
      agentId,
    }) as Extract<
      ReturnType<typeof NodeControlMessageSchema.parse>,
      { type: "control.agent.provision" }
    >,
    sent: NodeRequest[] = [];
  const accepted = await handleProvision(command, sent, async () => {
    throw new AgentProvisioningError("permission_denied", "节点无法创建 Agent 工作区根路径。");
  });

  expect(accepted).toBe(true);
  expect(sent).toEqual([
    {
      type: "node.agent.provision.result",
      requestId: command.requestId,
      agentId,
      ok: false,
      code: "permission_denied",
      message: "节点无法创建 Agent 工作区根路径。",
    },
  ]);
});

/** The node's own handler, kept behind the same public seam the WebSocket client uses. */
async function handleProvision(
  command: Extract<
    ReturnType<typeof NodeControlMessageSchema.parse>,
    { type: "control.agent.provision" }
  >,
  sent: NodeRequest[],
  prepare: Parameters<
    typeof import("../../src/nodes/agent-provisioner.js").handleAgentProvisionRequest
  >[2],
): Promise<boolean> {
  const { handleAgentProvisionRequest } = await import("../../src/nodes/agent-provisioner.js");
  return handleAgentProvisionRequest(command, (message) => sent.push(message), prepare);
}

it("never reads or creates a Linux account for the Agent", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../src/nodes/agent-provisioner.ts", import.meta.url)),
    "utf8",
  );
  for (const forbidden of ["useradd", "getent", "setpriv", "systemd", "fchownSync", "geteuid"])
    expect(source).not.toContain(forbidden);
  expect(
    existsSync(fileURLToPath(new URL("../../src/nodes/agent-provisioner.ts", import.meta.url))),
  ).toBe(true);
  expect(
    lstatSync(
      fileURLToPath(new URL("../../src/nodes/agent-provisioner.ts", import.meta.url)),
    ).isFile(),
  ).toBe(true);
  // The running account is reported, not invented from the Agent ID.
  expect(source).not.toContain("linuxUsernameForAgentId");
  expect(userInfo().username.length).toBeGreaterThan(0);
});
