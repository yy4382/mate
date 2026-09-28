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
  // Two paired nodes, each recording the one account its Agents run under: the local node whose
  // account this host really has, and a remote node whose account belongs to another machine.
  owner.db
    .prepare(
      `INSERT INTO nodes(id,public_key,paired_at,linux_username,uid,gid) VALUES(?,?,?,?,?,?)`,
    )
    .run(
      remoteNodeId,
      "remote-paired-key",
      1,
      `mate_${otherAgentId.replaceAll("-", "").slice(0, 27)}`,
      24_002,
      24_002,
    );
  owner.db
    .prepare("UPDATE nodes SET linux_username=?,uid=?,gid=? WHERE id=?")
    .run(localAccountUsername, 24_001, 24_001, node.nodeId);
  for (const [id, assignedNodeId, marker] of [
    [agentId, node.nodeId, "a".repeat(64)],
    [secondLocalAgentId, node.nodeId, "a".repeat(64)],
    [otherAgentId, remoteNodeId, "b".repeat(64)],
  ] as const)
    owner.db
      .prepare(
        `INSERT INTO owner_agents(
          id,node_id,name,role,description,provider,model_id,request_hash,
          provision_request_id,stage,home,home_marker,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,'complete',?,?,1,1)`,
      )
      .run(
        id,
        assignedNodeId,
        id,
        "",
        "",
        "openai",
        "model",
        "c".repeat(64),
        id,
        id === otherAgentId ? `/remote/${id}` : join(paths.agentHomeRoot, id),
        marker,
      );
  owner.close();
  return { paths, node };
}

/** Every Agent on the one local node runs under this single ordinary account. */
const localAccountUsername = `mate_${agentId.replaceAll("-", "").slice(0, 27)}`;

function localIdentity(agentId: string, homeRoot: string) {
  return {
    username: localAccountUsername,
    uid: 24_001,
    gid: 24_001,
    workspace: join(homeRoot, agentId),
    workspaceMarker: "a".repeat(64),
  };
}

/**
 * Seed one ordinary command on both sides: the control plane's intent for it and the node's own
 * durable receipt. `control` describes what the restored control-plane checkpoint still knew.
 */
function addCommandOperation(
  paths: ReturnType<typeof setup>["paths"],
  nodeId: string,
  operationId: string,
  control: {
    state: "executing" | "unknown";
    receiptConfirmed: boolean;
    nodeReceiptRevision: number | null;
  },
  nodeReceipt: {
    state: "started" | "succeeded" | "failed" | "unknown";
    receipt: unknown;
    revision: number;
  },
): void {
  const request = JSON.stringify({
      agentId,
      operation: { kind: "exec", command: "printf done", cwd: "." },
    }),
    requestHash = createHash("sha256").update(request).digest("hex"),
    channelId = randomUUID(),
    messageId = randomUUID(),
    deliveryId = randomUUID(),
    runId = randomUUID(),
    owner = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  owner.db
    .prepare(
      `INSERT INTO owner_channels(id,name,description,visibility,created_at,updated_at)
       VALUES(?,?,'','private',1,1)`,
    )
    .run(channelId, "Command channel");
  owner.db
    .prepare(
      `INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at)
       VALUES(?,'agent',?,1,1)`,
    )
    .run(channelId, agentId);
  owner.db
    .prepare(
      "INSERT INTO owner_messages(id,channel_id,order_seq,text,created_at) VALUES(?,?,1,?,1)",
    )
    .run(messageId, channelId, "run a command");
  owner.db
    .prepare(
      `INSERT INTO owner_message_deliveries(
        id,message_id,channel_id,recipient_kind,recipient_id,state,created_at
      ) VALUES(?,?,?,'agent',?,'pending',1)`,
    )
    .run(deliveryId, messageId, channelId, agentId);
  owner.db
    .prepare(
      `INSERT INTO owner_agent_runs(id,agent_id,node_id,delivery_id,state,started_at)
       VALUES(?,?,?,?,'completed',1)`,
    )
    .run(runId, agentId, nodeId, deliveryId);
  owner.db
    .prepare(
      `INSERT INTO owner_agent_process_operations(
        operation_id,run_id,agent_id,node_id,
        request_hash,request_json,state,receipt_json,node_receipt_confirmed,node_receipt_revision,
        created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,NULL,?,?,1,1)`,
    )
    .run(
      operationId,
      runId,
      agentId,
      nodeId,
      requestHash,
      request,
      control.state,
      control.receiptConfirmed ? 1 : 0,
      control.nodeReceiptRevision,
    );
  owner.close();

  const node = new Database(join(paths.nodeDataDir, "agent-process-operations.sqlite"));
  node
    .prepare(
      `INSERT INTO agent_process_operations(
        operation_id,agent_id,request_hash,request,state,receipt,revision,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,1,1)`,
    )
    .run(
      operationId,
      agentId,
      requestHash,
      request,
      nodeReceipt.state,
      nodeReceipt.receipt === null ? null : JSON.stringify(nodeReceipt.receipt),
      nodeReceipt.revision,
    );
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

it("confirms newer ordinary command receipts on both sides and leaves remote Agents untouched", () => {
  const { paths, node } = setup();
  const succeeded = randomUUID(),
    failed = randomUUID();
  addCommandOperation(
    paths,
    node.nodeId,
    succeeded,
    { state: "executing", receiptConfirmed: true, nodeReceiptRevision: 1 },
    { state: "succeeded", receipt: { code: 0, stdout: "done" }, revision: 2 },
  );
  addCommandOperation(
    paths,
    node.nodeId,
    failed,
    { state: "executing", receiptConfirmed: true, nodeReceiptRevision: 1 },
    { state: "failed", receipt: { code: 9, stderr: "boom" }, revision: 3 },
  );
  const result = reconcileCoordinatedState(paths, {
    lookupAgentIdentity: localIdentity,
    now: () => 300,
  });
  expect(result).toMatchObject({ confirmed: 2, holds: [] });
  const owner = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  expect(
    owner.db
      .prepare(
        `SELECT state,receipt_json,node_receipt_confirmed,node_receipt_revision
         FROM owner_agent_process_operations WHERE operation_id=?`,
      )
      .get(succeeded),
  ).toEqual({
    state: "succeeded",
    receipt_json: JSON.stringify({ code: 0, stdout: "done" }),
    node_receipt_confirmed: 1,
    node_receipt_revision: 2,
  });
  expect(
    owner.db
      .prepare(
        `SELECT state,receipt_json,node_receipt_revision
         FROM owner_agent_process_operations WHERE operation_id=?`,
      )
      .get(failed),
  ).toEqual({
    state: "failed",
    receipt_json: JSON.stringify({ code: 9, stderr: "boom" }),
    node_receipt_revision: 3,
  });
  expect(owner.db.prepare("SELECT agent_id FROM owner_agent_recovery_holds").all()).toEqual([]);
  owner.close();
});

it("accepts the first durable command receipt when a lost response left the revision unknown", () => {
  const { paths, node } = setup();
  const operationId = randomUUID();
  addCommandOperation(
    paths,
    node.nodeId,
    operationId,
    { state: "executing", receiptConfirmed: false, nodeReceiptRevision: null },
    { state: "succeeded", receipt: { code: 0, stdout: "done" }, revision: 2 },
  );
  const result = reconcileCoordinatedState(paths, {
    lookupAgentIdentity: localIdentity,
    now: () => 300,
  });
  expect(result).toMatchObject({ confirmed: 1, holds: [] });
  const owner = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  expect(
    owner.db
      .prepare(
        `SELECT state,node_receipt_confirmed,node_receipt_revision
         FROM owner_agent_process_operations WHERE operation_id=?`,
      )
      .get(operationId),
  ).toEqual({ state: "succeeded", node_receipt_confirmed: 1, node_receipt_revision: 2 });
  expect(owner.db.prepare("SELECT agent_id FROM owner_agent_recovery_holds").all()).toEqual([]);
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

it("holds the Agent for a command whose node receipt never proved a result", () => {
  const { paths, node } = setup();
  const finished = randomUUID(),
    started = randomUUID();
  addCommandOperation(
    paths,
    node.nodeId,
    finished,
    { state: "executing", receiptConfirmed: true, nodeReceiptRevision: 1 },
    { state: "succeeded", receipt: { code: 0, stdout: "done" }, revision: 2 },
  );
  addCommandOperation(
    paths,
    node.nodeId,
    started,
    { state: "executing", receiptConfirmed: true, nodeReceiptRevision: 1 },
    { state: "started", receipt: null, revision: 1 },
  );
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
        "SELECT state,node_receipt_revision FROM owner_agent_process_operations WHERE operation_id=?",
      )
      .get(finished),
  ).toEqual({ state: "succeeded", node_receipt_revision: 2 });
  expect(
    owner.db
      .prepare("SELECT state FROM owner_agent_process_operations WHERE operation_id=?")
      .get(started),
  ).toEqual({ state: "executing" });
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
      .prepare(
        "SELECT json_extract(message_json,'$.content') AS text FROM owner_agent_session_updates WHERE agent_id=?",
      )
      .get(agentId),
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

it("holds a terminal command result when the node checkpoint has no receipt for it", () => {
  const { paths, node } = setup();
  const operationId = randomUUID();
  addCommandOperation(
    paths,
    node.nodeId,
    operationId,
    { state: "unknown", receiptConfirmed: true, nodeReceiptRevision: 1 },
    { state: "succeeded", receipt: { code: 0, stdout: "done" }, revision: 2 },
  );
  const nodeDb = new Database(join(paths.nodeDataDir, "agent-process-operations.sqlite"));
  nodeDb.prepare("DELETE FROM agent_process_operations WHERE operation_id=?").run(operationId);
  nodeDb.close();

  const result = reconcileCoordinatedState(paths, {
    lookupAgentIdentity: localIdentity,
    now: () => 300,
  });
  expect(result.holds).toEqual([{ agentId, reason: "node_receipt_unavailable" }]);
  expect(result.released).not.toContain(agentId);
});
