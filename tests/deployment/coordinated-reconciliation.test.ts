import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { OwnerAuth } from "../../src/control-plane/owner-auth.js";
import { reconcileCoordinatedState } from "../../src/deployment/reconcile-coordinated-state.js";
import { workspaceReceiptRequestHash } from "../../src/nodes/workspace-receipt.js";
import { initializeCoordinatedRoots } from "../helpers/coordinated-state.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const agentId = "11111111-1111-4111-8111-111111111111";
const otherAgentId = "22222222-2222-4222-8222-222222222222";
const secondLocalAgentId = "66666666-6666-4666-8666-666666666666";
const remoteNodeId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const startedRequestId = "77777777-7777-4777-8777-777777777777";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "mate-coordinated-reconcile-"));
  roots.push(root);
  const paths = {
    controlPlaneDataDir: join(root, "control"),
    nodeDataDir: join(root, "node"),
    agentHomeRoot: join(root, "homes"),
  };
  const node = initializeCoordinatedRoots(paths);
  const localHome = join(paths.agentHomeRoot, agentId);
  mkdirSync(localHome, { recursive: true, mode: 0o700 });
  mkdirSync(join(paths.agentHomeRoot, secondLocalAgentId), { recursive: true, mode: 0o700 });
  const owner = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  owner.db
    .prepare("INSERT INTO nodes(id,public_key,paired_at) VALUES(?,?,?)")
    .run(remoteNodeId, "remote-paired-key", 1);
  for (const [id, assignedNodeId, marker] of [
    [agentId, node.nodeId, "a".repeat(64)],
    [secondLocalAgentId, node.nodeId, "a".repeat(64)],
    [otherAgentId, remoteNodeId, "b".repeat(64)],
  ] as const)
    owner.db
      .prepare(
        `INSERT INTO owner_agents(
          id,node_id,name,role,description,provider,model_id,request_json,request_hash,
          provision_request_id,status,stage,linux_username,uid,gid,home,home_marker,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,'waiting_credentials','complete',?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        assignedNodeId,
        id,
        "",
        "",
        "openai",
        "model",
        "{}",
        "c".repeat(64),
        id,
        `mate_${id.replaceAll("-", "").slice(0, 27)}`,
        id === otherAgentId ? 24_002 : 24_001,
        id === otherAgentId ? 24_002 : 24_001,
        id === otherAgentId ? `/remote/${id}` : join(paths.agentHomeRoot, id),
        marker,
        1,
        1,
      );
  owner.close();
  return { paths, node };
}

function localIdentity(agentId: string, homeRoot: string) {
  return {
    username: `mate_${agentId.replaceAll("-", "").slice(0, 27)}`,
    uid: 24_001,
    gid: 24_001,
    workspace: join(homeRoot, agentId),
    workspaceMarker: "a".repeat(64),
  };
}

function addNewerPrivilegedReceipt(paths: ReturnType<typeof setup>["paths"], nodeId: string) {
  const command = {
    requestId,
    operationId: requestId,
    agentId,
    nodeId,
    program: "/usr/bin/touch",
    args: ["/tmp/fixture"],
    cwd: "/tmp",
    expiresAt: 10_000,
  };
  const commandJson = JSON.stringify(command),
    requestHash = createHash("sha256").update(commandJson).digest("hex"),
    control = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  control.db
    .prepare(
      `INSERT INTO owner_privileged_approvals(
        request_id,operation_id,agent_id,node_id,channel_id,command_json,request_hash,state,
        receipt_json,node_receipt_revision,started_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,'unknown',?,1,100,1,2)`,
    )
    .run(
      requestId,
      requestId,
      agentId,
      nodeId,
      "55555555-5555-4555-8555-555555555555",
      commandJson,
      "d".repeat(64),
      JSON.stringify({ reason: "response unavailable" }),
    );
  control.close();

  const node = new Database(join(paths.nodeDataDir, "privileged-operations.sqlite"));
  node
    .prepare(
      `INSERT INTO node_privileged_operations(
      request_id,operation_id,agent_id,request_hash,state,receipt_json,started_at,revision,created_at,updated_at
    ) VALUES(?,?,?,?,'succeeded',?,100,2,100,200)`,
    )
    .run(requestId, requestId, agentId, requestHash, JSON.stringify({ code: 0 }));
  node.close();
}

function addStartedPrivilegedReceipt(paths: ReturnType<typeof setup>["paths"], nodeId: string) {
  const command = {
    requestId: startedRequestId,
    operationId: startedRequestId,
    agentId,
    nodeId,
    program: "/usr/bin/sleep",
    args: ["1"],
    cwd: "/tmp",
    expiresAt: 10_000,
  };
  const commandJson = JSON.stringify(command),
    requestHash = createHash("sha256").update(commandJson).digest("hex"),
    control = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  control.db
    .prepare(
      `INSERT INTO owner_privileged_approvals(
    request_id,operation_id,agent_id,node_id,channel_id,command_json,request_hash,state,
    receipt_json,node_receipt_revision,started_at,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,'unknown',?,1,100,1,2)`,
    )
    .run(
      startedRequestId,
      startedRequestId,
      agentId,
      nodeId,
      "55555555-5555-4555-8555-555555555555",
      commandJson,
      requestHash,
      JSON.stringify({ reason: "response unavailable" }),
    );
  control.close();
  const node = new Database(join(paths.nodeDataDir, "privileged-operations.sqlite"));
  node
    .prepare(
      `INSERT INTO node_privileged_operations(
    request_id,operation_id,agent_id,request_hash,state,receipt_json,started_at,revision,created_at,updated_at
  ) VALUES(?,?,?,?,'started',NULL,100,1,100,100)`,
    )
    .run(startedRequestId, startedRequestId, agentId, requestHash);
  node.close();
}

function addWorkspaceReceipt(paths: ReturnType<typeof setup>["paths"], nodeId: string) {
  const operationId = "88888888-8888-4888-8888-888888888888",
    runId = "99999999-9999-4999-8999-999999999999",
    channelId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    actionId =
      "mate:cccccccc-cccc-4ccc-8ccc-cccccccccccc:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd:1",
    operation = { kind: "write" as const, path: "note.txt", content: "written" },
    requestHash = workspaceReceiptRequestHash(agentId, operation),
    result = { written: true },
    envelope = {
      state: "succeeded",
      operationId,
      runId,
      channelId,
      operation: "workspace.write",
      nodeRequestHash: requestHash,
      result,
    };
  const owner = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  owner.db
    .prepare(
      `INSERT INTO owner_channels(id,name,description,visibility,created_at,updated_at)
    VALUES(?,?,'','private',1,1)`,
    )
    .run(channelId, "Receipt channel");
  owner.db
    .prepare("INSERT INTO owner_agent_sessions(id,agent_id,created_at) VALUES(?,?,1)")
    .run(sessionId, agentId);
  owner.db
    .prepare(
      `INSERT INTO owner_agent_tool_actions(
    session_id,action_id,agent_id,operation,request_hash,result_json,created_at
  ) VALUES(?,?,?,?,?,?,1)`,
    )
    .run(sessionId, actionId, agentId, "workspace.write", "e".repeat(64), JSON.stringify(envelope));
  owner.close();

  const path = join(paths.nodeDataDir, "workspace-receipts", `${operationId}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      operationId,
      agentId,
      requestHash,
      state: "succeeded",
      result: { code: 0, stdout: JSON.stringify(result), stderr: "", truncated: false },
      revision: 2,
      updatedAt: 200,
    }),
    { mode: 0o600 },
  );
  return operationId;
}

it("reads real SQLite and node identity files, accepts a newer matching receipt, and leaves remote Agents untouched", () => {
  const { paths, node } = setup();
  addNewerPrivilegedReceipt(paths, node.nodeId);
  const result = reconcileCoordinatedState(paths, {
    lookupAgentIdentity: localIdentity,
    now: () => 300,
  });
  expect(result).toMatchObject({ confirmed: 1, holds: [] });
  const owner = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  expect(
    owner.db
      .prepare(
        "SELECT state,node_receipt_revision,receipt_json FROM owner_privileged_approvals WHERE request_id=?",
      )
      .get(requestId),
  ).toEqual({
    state: "succeeded",
    node_receipt_revision: 2,
    receipt_json: JSON.stringify({ code: 0 }),
  });
  expect(owner.db.prepare("SELECT agent_id FROM owner_agent_recovery_holds").all()).toEqual([]);
  owner.close();
});

it("accepts the first durable node receipt when a lost response left the control-plane revision unknown", () => {
  const { paths, node } = setup();
  addNewerPrivilegedReceipt(paths, node.nodeId);
  const control = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  control.db
    .prepare("UPDATE owner_privileged_approvals SET node_receipt_revision=NULL WHERE request_id=?")
    .run(requestId);
  control.close();

  const result = reconcileCoordinatedState(paths, {
    lookupAgentIdentity: localIdentity,
    now: () => 300,
  });
  expect(result).toMatchObject({ confirmed: 1, holds: [] });
  const owner = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  expect(
    owner.db
      .prepare(
        "SELECT state,node_receipt_revision,receipt_json FROM owner_privileged_approvals WHERE request_id=?",
      )
      .get(requestId),
  ).toEqual({
    state: "succeeded",
    node_receipt_revision: 2,
    receipt_json: JSON.stringify({ code: 0 }),
  });
  expect(owner.db.prepare("SELECT agent_id FROM owner_agent_recovery_holds").all()).toEqual([]);
  owner.close();
});

it("holds only the local Agent when a same-version receipt conflicts, without rewriting shared facts", () => {
  const { paths, node } = setup();
  addNewerPrivilegedReceipt(paths, node.nodeId);
  const control = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  control.db
    .prepare("UPDATE owner_privileged_approvals SET node_receipt_revision=2 WHERE request_id=?")
    .run(requestId);
  control.close();
  const local = new Database(join(paths.nodeDataDir, "privileged-operations.sqlite"));
  local
    .prepare("UPDATE node_privileged_operations SET receipt_json=? WHERE request_id=?")
    .run(JSON.stringify({ code: 1 }), requestId);
  local.close();

  const result = reconcileCoordinatedState(paths, {
    lookupAgentIdentity: localIdentity,
    now: () => 300,
  });
  expect(result).toMatchObject({
    confirmed: 0,
    holds: [{ agentId, reason: "operation_result_conflict" }],
  });
  const owner = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  expect(
    owner.db
      .prepare("SELECT state FROM owner_privileged_approvals WHERE request_id=?")
      .get(requestId),
  ).toEqual({ state: "unknown" });
  expect(owner.db.prepare("SELECT agent_id FROM owner_agent_recovery_holds").all()).toEqual([
    { agent_id: agentId },
  ]);
  expect(owner.db.prepare("SELECT status FROM owner_agents WHERE id=?").get(otherAgentId)).toEqual({
    status: "waiting_credentials",
  });
  owner.close();
});

it("holds every Agent assigned to a node whose restored key no longer matches its control-plane pairing", () => {
  const { paths, node } = setup();
  const owner = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  owner.db.prepare("UPDATE nodes SET public_key='wrong-key' WHERE id=?").run(node.nodeId);
  owner.close();
  const result = reconcileCoordinatedState(paths, {
    lookupAgentIdentity: localIdentity,
    now: () => 300,
  });
  expect(result.holds).toEqual([
    { agentId, reason: "node_identity_unproven" },
    { agentId: secondLocalAgentId, reason: "node_identity_unproven" },
  ]);
  const control = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  expect(
    control.db.prepare("SELECT agent_id FROM owner_agent_recovery_holds ORDER BY agent_id").all(),
  ).toEqual([{ agent_id: agentId }, { agent_id: secondLocalAgentId }]);
  control.close();
});

it("applies one proven terminal receipt while holding the same Agent for a separate started operation", () => {
  const { paths, node } = setup();
  addNewerPrivilegedReceipt(paths, node.nodeId);
  addStartedPrivilegedReceipt(paths, node.nodeId);
  const result = reconcileCoordinatedState(paths, {
    lookupAgentIdentity: localIdentity,
    now: () => 300,
  });
  expect(result).toMatchObject({
    confirmed: 1,
    holds: [{ agentId, reason: "operation_result_unproven" }],
  });
  const owner = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  expect(
    owner.db
      .prepare(
        "SELECT state,node_receipt_revision FROM owner_privileged_approvals WHERE request_id=?",
      )
      .get(requestId),
  ).toEqual({ state: "succeeded", node_receipt_revision: 2 });
  expect(
    owner.db
      .prepare(
        "SELECT state,node_receipt_revision FROM owner_privileged_approvals WHERE request_id=?",
      )
      .get(startedRequestId),
  ).toEqual({ state: "unknown", node_receipt_revision: 1 });
  expect(owner.db.prepare("SELECT agent_id FROM owner_agent_recovery_holds").all()).toEqual([
    { agent_id: agentId },
  ]);
  owner.close();
});

it("persists a matching newer workspace receipt without decoding the business result as raw stdout", () => {
  const { paths, node } = setup();
  addWorkspaceReceipt(paths, node.nodeId);
  const result = reconcileCoordinatedState(paths, {
    lookupAgentIdentity: localIdentity,
    now: () => 300,
  });
  expect(result).toMatchObject({ confirmed: 1, holds: [] });
  const owner = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  const action = owner.db
    .prepare("SELECT result_json FROM owner_agent_tool_actions WHERE agent_id=?")
    .get(agentId) as { result_json: string };
  expect(JSON.parse(action.result_json)).toMatchObject({
    state: "succeeded",
    revision: 2,
    result: { written: true },
  });
  expect(
    owner.db
      .prepare("SELECT text FROM owner_agent_session_journal WHERE run_id=?")
      .get("99999999-9999-4999-8999-999999999999"),
  ).toMatchObject({ text: expect.stringContaining('"written":true') });
  owner.close();
});

it("holds only the owning Agent when a stored workspace envelope has an invalid state", () => {
  const { paths, node } = setup();
  addWorkspaceReceipt(paths, node.nodeId);
  const owner = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  const action = owner.db
    .prepare(
      "SELECT session_id,action_id,result_json FROM owner_agent_tool_actions WHERE agent_id=?",
    )
    .get(agentId) as { session_id: string; action_id: string; result_json: string };
  owner.db
    .prepare("UPDATE owner_agent_tool_actions SET result_json=? WHERE session_id=? AND action_id=?")
    .run(
      JSON.stringify({ ...JSON.parse(action.result_json), state: "done" }),
      action.session_id,
      action.action_id,
    );
  owner.close();

  const result = reconcileCoordinatedState(paths, {
    lookupAgentIdentity: localIdentity,
    now: () => 300,
  });
  expect(result.holds).toEqual([{ agentId, reason: "control_receipt_identity_unproven" }]);
  expect(result.released).toContain(secondLocalAgentId);
});

it("holds only the operation owner when its named workspace receipt is malformed JSON", () => {
  const { paths, node } = setup();
  const operationId = addWorkspaceReceipt(paths, node.nodeId);
  writeFileSync(join(paths.nodeDataDir, "workspace-receipts", `${operationId}.json`), "{", {
    mode: 0o600,
  });

  const result = reconcileCoordinatedState(paths, {
    lookupAgentIdentity: localIdentity,
    now: () => 300,
  });
  expect(result.holds).toEqual([{ agentId, reason: "node_receipt_identity_unproven" }]);
  expect(result.released).toContain(secondLocalAgentId);
});

it("holds a terminal privileged result when the node checkpoint has no versioned receipt", () => {
  const { paths, node } = setup();
  addNewerPrivilegedReceipt(paths, node.nodeId);
  const owner = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  owner.db
    .prepare(
      `UPDATE owner_privileged_approvals
    SET state='succeeded',receipt_json=?,node_receipt_revision=NULL WHERE request_id=?`,
    )
    .run(JSON.stringify({ code: 0 }), requestId);
  owner.close();
  const nodeDb = new Database(join(paths.nodeDataDir, "privileged-operations.sqlite"));
  nodeDb.prepare("DELETE FROM node_privileged_operations WHERE request_id=?").run(requestId);
  nodeDb.close();

  const result = reconcileCoordinatedState(paths, {
    lookupAgentIdentity: localIdentity,
    now: () => 300,
  });
  expect(result.holds).toEqual([{ agentId, reason: "node_receipt_unavailable" }]);
  expect(result.released).not.toContain(agentId);
});
