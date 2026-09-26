import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { OwnerAuth } from "../../src/control-plane/owner-auth.js";
import { reconcileCoordinatedState } from "../../src/deployment/reconcile-coordinated-state.js";
import { initializeCoordinatedRoots } from "../helpers/coordinated-state.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const agentId = "11111111-1111-4111-8111-111111111111";
const otherAgentId = "22222222-2222-4222-8222-222222222222";
const remoteNodeId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";

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
  const owner = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  owner.db
    .prepare("INSERT INTO nodes(id,public_key,paired_at) VALUES(?,?,?)")
    .run(remoteNodeId, "remote-paired-key", 1);
  for (const [id, assignedNodeId, marker] of [
    [agentId, node.nodeId, "a".repeat(64)],
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
        id === agentId ? 24_001 : 24_002,
        id === agentId ? 24_001 : 24_002,
        id === agentId ? localHome : `/remote/${id}`,
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
    home: join(homeRoot, agentId),
    homeMarker: "a".repeat(64),
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
    .run(requestId, requestId, agentId, nodeId, "55555555-5555-4555-8555-555555555555", commandJson, "d".repeat(64), JSON.stringify({ reason: "response unavailable" }));
  control.close();

  const node = new Database(join(paths.nodeDataDir, "privileged-operations.sqlite"));
  node.prepare(
    `INSERT INTO node_privileged_operations(
      request_id,operation_id,agent_id,request_hash,state,receipt_json,started_at,revision,created_at,updated_at
    ) VALUES(?,?,?,?,'succeeded',?,100,2,100,200)`,
  ).run(requestId, requestId, agentId, requestHash, JSON.stringify({ code: 0 }));
  node.close();
}

it("reads real SQLite and node identity files, accepts a newer matching receipt, and leaves remote Agents untouched", () => {
  const { paths, node } = setup();
  addNewerPrivilegedReceipt(paths, node.nodeId);
  const result = reconcileCoordinatedState(paths, { lookupAgentIdentity: localIdentity, now: () => 300 });
  expect(result).toMatchObject({ confirmed: 1, holds: [] });
  const owner = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  expect(
    owner.db
      .prepare("SELECT state,node_receipt_revision,receipt_json FROM owner_privileged_approvals WHERE request_id=?")
      .get(requestId),
  ).toEqual({ state: "succeeded", node_receipt_revision: 2, receipt_json: JSON.stringify({ code: 0 }) });
  expect(owner.db.prepare("SELECT agent_id FROM owner_agent_recovery_holds").all()).toEqual([]);
  owner.close();
});

it("holds only the local Agent when a same-version receipt conflicts, without rewriting shared facts", () => {
  const { paths, node } = setup();
  addNewerPrivilegedReceipt(paths, node.nodeId);
  const control = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  control.db.prepare("UPDATE owner_privileged_approvals SET node_receipt_revision=2 WHERE request_id=?").run(requestId);
  control.close();
  const local = new Database(join(paths.nodeDataDir, "privileged-operations.sqlite"));
  local.prepare("UPDATE node_privileged_operations SET receipt_json=? WHERE request_id=?").run(
    JSON.stringify({ code: 1 }),
    requestId,
  );
  local.close();

  const result = reconcileCoordinatedState(paths, { lookupAgentIdentity: localIdentity, now: () => 300 });
  expect(result).toMatchObject({ confirmed: 0, holds: [{ agentId, reason: "operation_result_conflict" }] });
  const owner = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  expect(owner.db.prepare("SELECT state FROM owner_privileged_approvals WHERE request_id=?").get(requestId))
    .toEqual({ state: "unknown" });
  expect(owner.db.prepare("SELECT agent_id FROM owner_agent_recovery_holds").all()).toEqual([{ agent_id: agentId }]);
  expect(owner.db.prepare("SELECT status FROM owner_agents WHERE id=?").get(otherAgentId)).toEqual({ status: "waiting_credentials" });
  owner.close();
});

it("holds every Agent assigned to a node whose restored key no longer matches its control-plane pairing", () => {
  const { paths, node } = setup();
  const owner = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  owner.db.prepare("UPDATE nodes SET public_key='wrong-key' WHERE id=?").run(node.nodeId);
  owner.close();
  const result = reconcileCoordinatedState(paths, { lookupAgentIdentity: localIdentity, now: () => 300 });
  expect(result.holds).toEqual([{ agentId, reason: "node_identity_unproven" }]);
});
