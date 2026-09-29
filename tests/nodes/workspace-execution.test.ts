import { afterEach, expect, it } from "vitest";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExecutionBackend, ExecutionResult, Operation } from "../../src/execution/backend.js";
import { prepareAgentWorkspace } from "../../src/nodes/agent-provisioner.js";
import {
  LinuxWorkspaceExecutor,
  type WorkspaceExecutionRequest,
  type WorkspaceMode,
} from "../../src/nodes/workspace-execution.js";

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "mate-node-workspace-"));
  roots.push(root);
  return root;
};
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const agentId = "6a69f5cb-d52c-44d2-97e9-65cecc461f13";
const operationId = "f045a330-2902-4a92-b9bd-115ee60ec91c";

function setup(run: (operation: Operation) => Promise<ExecutionResult> | ExecutionResult) {
  const root = temp(),
    homeRoot = join(root, "agents"),
    home = join(homeRoot, agentId);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const calls: Operation[] = [],
    backend: ExecutionBackend = {
      execute: async (request) => {
        calls.push(request.operation);
        return run(request.operation);
      },
    },
    dependencies = {
      lookupIdentity: () => ({
        username: "mate_test",
        uid: 51001,
        gid: 51001,
        workspace: home,
        workspaceMarker: "a".repeat(64),
      }),
      createBackend: () => backend,
      now: () => 10,
    };
  return { root, homeRoot, home, calls, dependencies };
}

function action(content = "memo"): WorkspaceExecutionRequest {
  return {
    operationId,
    agentId,
    mode: "agent_action",
    operation: { kind: "write", path: "MEMORY.md", content },
  };
}

const success: ExecutionResult = {
  code: 0,
  stdout: JSON.stringify({ sha256: "known-receipt" }),
  stderr: "",
  truncated: false,
};

it("runs a state-changing operation once and returns its durable receipt after a node restart", async () => {
  const fixture = setup(() => success),
    firstNode = new LinuxWorkspaceExecutor(fixture.homeRoot, fixture.root, fixture.dependencies);
  expect(await firstNode.execute(action())).toEqual(success);
  expect(firstNode.status(agentId, operationId)).toEqual(success);
  expect(await firstNode.execute(action())).toEqual(success);
  const restartedNode = new LinuxWorkspaceExecutor(
    fixture.homeRoot,
    fixture.root,
    fixture.dependencies,
  );
  expect(await restartedNode.execute(action())).toEqual(success);
  expect(restartedNode.status(agentId, operationId)).toEqual(success);
  expect(restartedNode.status("d4086c50-4b83-4118-a4bc-cc5b6aaecb99", operationId)).toBeUndefined();
  expect(fixture.calls).toHaveLength(1);
  const receiptDirectory = join(fixture.root, "workspace-receipts");
  expect(lstatSync(receiptDirectory).mode & 0o777).toBe(0o700);
  expect(lstatSync(join(receiptDirectory, `${operationId}.json`)).mode & 0o777).toBe(0o600);
});

it("passes the verified provisioned identity to workspace execution without marker metadata", async () => {
  const fixture = setup(() => success),
    backendIdentities: unknown[] = [],
    executor = new LinuxWorkspaceExecutor(fixture.homeRoot, fixture.root, {
      ...fixture.dependencies,
      createBackend: (identity) => {
        backendIdentities.push(identity);
        return { execute: async () => success };
      },
    });

  expect(await executor.execute(action())).toEqual(success);
  expect(backendIdentities).toEqual([
    {
      username: "mate_test",
      uid: 51001,
      gid: 51001,
      home: fixture.home,
    },
  ]);
});

it("rejects reusing an operation ID with different input", async () => {
  const fixture = setup(() => success),
    executor = new LinuxWorkspaceExecutor(fixture.homeRoot, fixture.root, fixture.dependencies);
  await executor.execute(action());
  const conflict = await executor.execute(action("changed input"));
  expect(conflict.code).not.toBe(0);
  expect(conflict.stderr).toContain("operation_conflict");
  expect(fixture.calls).toHaveLength(1);
});

it("keeps an interrupted state-changing operation unknown instead of replaying it", async () => {
  const fixture = setup(() => Promise.reject(new Error("connection lost"))),
    executor = new LinuxWorkspaceExecutor(fixture.homeRoot, fixture.root, fixture.dependencies);
  const first = await executor.execute(action()),
    replay = await executor.execute(action());
  expect(first.stderr).toContain("operation_unknown");
  expect(replay.stderr).toContain("operation_unknown");
  expect(fixture.calls).toHaveLength(1);
  expect(executor.status(agentId, operationId)?.stderr).toContain("operation_unknown");
});

it("retains a confirmed failed file receipt across node restart without execution replay", async () => {
  const denied = { code: 7, stdout: "", stderr: "permission_denied: protected", truncated: false };
  const fixture = setup(() => denied),
    executor = new LinuxWorkspaceExecutor(fixture.homeRoot, fixture.root, fixture.dependencies);
  expect(await executor.execute(action())).toEqual(denied);
  const restarted = new LinuxWorkspaceExecutor(
    fixture.homeRoot,
    fixture.root,
    fixture.dependencies,
  );
  expect(restarted.status(agentId, operationId)).toEqual(denied);
  expect(await restarted.execute(action())).toEqual(denied);
  expect(fixture.calls).toHaveLength(1);
});

it("does not wait for a running file operation when reading persisted status", async () => {
  const fixture = setup(() => new Promise<ExecutionResult>(() => {})),
    executor = new LinuxWorkspaceExecutor(fixture.homeRoot, fixture.root, fixture.dependencies);
  const running = executor.execute(action());
  expect(executor.status(agentId, operationId)).toBeUndefined();
  void running;
});

/**
 * Two real Agents on the one account, provisioned in the real file system, with the real file
 * helper in a child process. Nothing about identities, backends or paths is stubbed, so a refusal
 * here is the same refusal a running Agent would observe. Only the operation receipt store is new.
 */
async function twoRealAgents() {
  const root = temp(),
    homeRoot = join(root, "agents"),
    dataDirectory = join(root, "node-data");
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const readerId = randomUUID(),
    peerId = randomUUID(),
    reader = await prepareAgentWorkspace({ agentId: readerId, workspaceRoot: homeRoot }),
    peer = await prepareAgentWorkspace({ agentId: peerId, workspaceRoot: homeRoot }),
    executor = new LinuxWorkspaceExecutor(homeRoot, dataDirectory),
    run = (mode: WorkspaceMode, operation: Operation) =>
      executor.execute({ operationId: randomUUID(), agentId: readerId, mode, operation });
  writeFileSync(join(peer.workspace, "peer-notes.md"), "peer notes\n", { mode: 0o600 });
  // A link inside the reader's own workspace, pointing at the peer's file, is the cheapest way to
  // try to make a confined read leave the selected directory.
  symlinkSync(join(peer.workspace, "peer-notes.md"), join(reader.workspace, "peer-link"));
  return { root, homeRoot, readerId, peerId, reader, peer, executor, run };
}

it("reads a peer Agent's workspace file through the Agent file path", async () => {
  const fixture = await twoRealAgents(),
    peerFile = join(fixture.peer.workspace, "peer-notes.md");

  // The Agent's own file tools are not bound to its own directory: Mate asks it not to browse a
  // peer's workspace and then leaves the judgement to it, so a readable peer file is readable.
  expect(
    await fixture.run("agent_read", { kind: "read", path: `../${fixture.peerId}/peer-notes.md` }),
  ).toMatchObject({
    code: 0,
    stdout: "peer notes\n",
  });
  expect(await fixture.run("agent_read", { kind: "read", path: peerFile })).toMatchObject({
    code: 0,
    stdout: "peer notes\n",
  });
  const listing = await fixture.run("agent_read", {
    kind: "workspace_list",
    path: `../${fixture.peerId}`,
    offset: 0,
    limit: 32,
  });
  expect(listing.code).toBe(0);
  expect(JSON.parse(listing.stdout).entries).toContainEqual({
    name: "peer-notes.md",
    type: "file",
    size: expect.any(Number),
  });

  // Only Agent workspaces are reachable this way. The shared root itself, a file that sits beside
  // the workspaces and a file merely named like an Agent are not a peer workspace, so a root that
  // also holds the node's own files — a node identity document here — stays unreadable through the
  // file tools.
  writeFileSync(join(fixture.homeRoot, "node-identity.json"), "{}\n", { mode: 0o600 });
  const impostorId = randomUUID(),
    linkedId = randomUUID();
  writeFileSync(join(fixture.homeRoot, impostorId), "not a workspace\n", { mode: 0o600 });
  symlinkSync(fixture.peer.workspace, join(fixture.homeRoot, linkedId));
  for (const path of [
    "..",
    "../node-identity.json",
    `../${impostorId}`,
    `../${linkedId}/peer-notes.md`,
    `../${fixture.readerId.toUpperCase()}/MEMORY.md`,
  ]) {
    const refused = await fixture.run("agent_read", { kind: "read", path });
    expect(refused.code, `agent_read must not reach ${path}`).not.toBe(0);
    expect(refused.stderr).toContain("unsafe_path");
  }
  const rootListing = await fixture.run("agent_read", {
    kind: "workspace_list",
    path: "..",
    offset: 0,
    limit: 32,
  });
  expect(rootListing.code).not.toBe(0);
  expect(rootListing.stderr).toContain("unsafe_path");

  // A relative path still starts from the Agent's own workspace, so ordinary use is unchanged.
  const ownMemory = await fixture.run("agent_read", { kind: "workspace_stat", path: "MEMORY.md" });
  expect(ownMemory.code).toBe(0);
  expect(JSON.parse(ownMemory.stdout).type).toBe("file");
  // A path that resolves inside the Agent's own workspace is not refused for its spelling either.
  const spelled = await fixture.run("agent_read", {
    kind: "workspace_stat",
    path: `../${fixture.readerId}/MEMORY.md`,
  });
  expect(spelled.code).toBe(0);
  expect(JSON.parse(spelled.stdout).type).toBe("file");

  // Symbolic links are still not followed anywhere: the Agent reads a peer file by its real path.
  const linked = await fixture.run("agent_read", {
    kind: "workspace_read_chunk",
    path: "peer-link",
    offset: 0,
    length: 8192,
  });
  expect(linked.code).not.toBe(0);
  expect(linked.stderr).toContain("unsafe_path");
});

it("keeps owner workspace preview inside the selected Agent workspace for paths and symbolic links", async () => {
  const fixture = await twoRealAgents(),
    readerWorkspace = realpathSync(fixture.reader.workspace),
    peerWorkspace = realpathSync(fixture.peer.workspace),
    inside = await fixture.run("owner_read", {
      kind: "workspace_read_chunk",
      path: `${readerWorkspace}/MEMORY.md`,
      offset: 0,
      length: 8192,
    });

  // The owner may browse the selected Agent's workspace, including by absolute path.
  expect(inside.code).toBe(0);

  for (const path of [
    `../${fixture.peerId}/peer-notes.md`,
    `${peerWorkspace}/peer-notes.md`,
    "../../etc/passwd",
    "/etc/hosts",
    "..",
    "peer-link",
  ]) {
    const attempts: Array<Operation> = [
      { kind: "workspace_list", path, offset: 0, limit: 32 },
      { kind: "workspace_stat", path },
      { kind: "workspace_read_chunk", path, offset: 0, length: 8192 },
    ];
    for (const operation of attempts) {
      const refused = await fixture.run("owner_read", operation);
      expect(refused.code, `${operation.kind} must not preview ${path}`).not.toBe(0);
      // The refusal is the selected workspace's boundary, not an unrelated failure.
      expect(refused.stderr).toContain("unsafe_path");
      expect(refused.stdout).toBe("");
    }
  }

  // The link is still listed as a link, but never followed into the peer's workspace.
  const listing = await fixture.run("owner_read", {
    kind: "workspace_list",
    path: "",
    offset: 0,
    limit: 32,
  });
  expect(listing.code).toBe(0);
  expect(JSON.parse(listing.stdout).entries).toContainEqual({
    name: "peer-link",
    type: "symlink",
    size: expect.any(Number),
  });

  // The widening belongs to Agent reads alone: writing and publishing keep the Agent's own
  // workspace as their root, so an Agent cannot turn a read into a change somewhere else.
  const write = await fixture.run("agent_action", {
    kind: "write",
    path: `../${fixture.peerId}/planted.md`,
    content: "planted\n",
  });
  expect(write.code).not.toBe(0);
  expect(() => lstatSync(join(fixture.peer.workspace, "planted.md"))).toThrow();
  const publish = await fixture.run("agent_publish", {
    kind: "workspace_read_chunk",
    path: `../${fixture.peerId}/peer-notes.md`,
    offset: 0,
    length: 8192,
  });
  expect(publish.code).not.toBe(0);
});

it("does not receipt read-only owner browsing and refuses owner write operations", async () => {
  const fixture = setup(() => success),
    executor = new LinuxWorkspaceExecutor(fixture.homeRoot, fixture.root, fixture.dependencies),
    read: WorkspaceExecutionRequest = {
      operationId,
      agentId,
      mode: "owner_read",
      operation: { kind: "workspace_stat", path: "MEMORY.md" },
    };
  await executor.execute(read);
  await executor.execute(read);
  expect(fixture.calls).toHaveLength(2);
  expect(() =>
    executor.execute({
      ...read,
      operation: { kind: "write", path: "MEMORY.md", content: "no" },
    }),
  ).toThrow("Owner browsing and file publishing allow read operations only");
});

it("keeps a receipt for a different historical file request unproven during reconciliation", async () => {
  const fixture = setup(() => success);
  const executor = new LinuxWorkspaceExecutor(fixture.homeRoot, fixture.root, fixture.dependencies);
  await executor.execute(action());
  expect(executor.status(agentId, operationId, "different request")?.stderr).toContain(
    "operation_unknown",
  );
  expect(fixture.calls).toHaveLength(1);
});
