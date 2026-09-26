import { afterEach, expect, it } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionBackend, ExecutionResult, Operation } from "../../src/execution/backend.js";
import {
  LinuxWorkspaceExecutor,
  type WorkspaceExecutionRequest,
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
        home,
        homeMarker: "a".repeat(64),
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
      createBackend: (_agentId, identity) => {
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
