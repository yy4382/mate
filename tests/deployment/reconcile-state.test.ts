import { expect, it } from "vitest";
import {
  reconcileRecoveryState,
  type RecoveryState,
  type NodeRecoveryState,
} from "../../src/deployment/reconcile-state.js";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const nodeId = "33333333-3333-4333-8333-333333333333";

function states(): { control: RecoveryState; node: NodeRecoveryState } {
  const agents = [first, second].map((id, index) => ({
    id,
    nodeId,
    uid: 24001 + index,
    gid: 24001 + index,
    home: `/var/lib/mate-agents/${id}`,
    homeMarker: `${index + 1}`.repeat(64),
  }));
  return {
    control: { nodeId, nodePublicKey: "paired-key", agents, operations: [] },
    node: { nodeId, nodePublicKey: "paired-key", agents, operations: [] },
  };
}

it("reports an operation absent from the control-plane checkpoint without holding its Agent", () => {
  const { control, node } = states();
  node.operations.push({
    operationId: "44444444-4444-4444-8444-444444444444",
    agentId: first,
    kind: "process",
    requestHash: "a".repeat(64),
    state: "succeeded",
    receipt: { code: 0 },
    sequence: 7,
  });
  expect(reconcileRecoveryState(control, node)).toMatchObject({
    holds: [],
    uncertainties: [{ agentId: first, reason: "node_operation_without_intent" }],
    confirmed: [],
  });
});

it("accepts a higher durable node result for the matching operation and leaves the other Agent runnable", () => {
  const { control, node } = states();
  const operationId = "55555555-5555-4555-8555-555555555555";
  control.operations.push({
    operationId,
    agentId: first,
    nodeId,
    kind: "process",
    requestHash: "b".repeat(64),
    state: "unknown",
    receiptConfirmed: false,
    nodeReceiptRevision: 7,
    receipt: { reason: "response_unavailable" },
  });
  const receipt = {
    operationId,
    agentId: first,
    kind: "process" as const,
    requestHash: "b".repeat(64),
    state: "succeeded" as const,
    receipt: { code: 0 },
    sequence: 8,
  };
  node.operations.push(receipt);
  expect(reconcileRecoveryState(control, node)).toMatchObject({ holds: [], confirmed: [receipt] });
});

it("accepts a first durable receipt for an unconfirmed unknown intent without a control-plane revision", () => {
  const { control, node } = states();
  const intent = {
    operationId: "abababab-abab-4bab-8bab-abababababab",
    agentId: first,
    nodeId,
    kind: "process" as const,
    requestHash: "b".repeat(64),
    state: "unknown" as const,
    receiptConfirmed: false,
    nodeReceiptRevision: null,
    receipt: { reason: "node_response_unavailable" },
  };
  const receipt = {
    operationId: intent.operationId,
    agentId: first,
    kind: "process" as const,
    requestHash: intent.requestHash,
    state: "succeeded" as const,
    receipt: { code: 0 },
    sequence: 2,
  };
  control.operations.push(intent);
  node.operations.push(receipt);

  expect(reconcileRecoveryState(control, node)).toMatchObject({ holds: [], confirmed: [receipt] });
});

it("does not overwrite an unversioned but confirmed terminal control-plane receipt with a conflict", () => {
  const { control, node } = states();
  const intent = {
    operationId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
    agentId: first,
    nodeId,
    kind: "process" as const,
    requestHash: "e".repeat(64),
    state: "succeeded" as const,
    receiptConfirmed: true,
    nodeReceiptRevision: null,
    receipt: { code: 0 },
  };
  control.operations.push(intent);
  node.operations.push({
    operationId: intent.operationId,
    agentId: first,
    kind: intent.kind,
    requestHash: intent.requestHash,
    state: "failed",
    receipt: { code: 1 },
    sequence: 2,
  });

  expect(reconcileRecoveryState(control, node)).toMatchObject({
    holds: [],
    uncertainties: [{ agentId: first, reason: "node_receipt_version_unproven" }],
    confirmed: [],
  });
});

it("reports stale and conflicting historical receipts without holding the Agent", () => {
  const { control, node } = states();
  const operationId = "77777777-7777-4777-8777-777777777777";
  control.operations.push({
    operationId,
    agentId: first,
    nodeId,
    kind: "process",
    requestHash: "d".repeat(64),
    state: "succeeded",
    receiptConfirmed: true,
    nodeReceiptRevision: 4,
    receipt: { code: 0 },
  });
  node.operations.push({
    operationId,
    agentId: first,
    kind: "process",
    requestHash: "d".repeat(64),
    state: "failed",
    receipt: { code: 1 },
    sequence: 4,
  });
  expect(reconcileRecoveryState(control, node)).toMatchObject({
    holds: [],
    uncertainties: [{ agentId: first, reason: "operation_result_conflict" }],
    confirmed: [],
  });
  node.operations[0]!.sequence = 3;
  expect(reconcileRecoveryState(control, node)).toMatchObject({
    holds: [],
    uncertainties: [{ agentId: first, reason: "node_receipt_stale" }],
    confirmed: [],
  });
});

it("holds only Agents assigned to a node when its restored pairing key cannot be proven", () => {
  const { control, node } = states();
  node.nodePublicKey = "different-key";
  expect(reconcileRecoveryState(control, node)).toMatchObject({
    holds: [
      { agentId: first, reason: "node_identity_unproven" },
      { agentId: second, reason: "node_identity_unproven" },
    ],
    confirmed: [],
  });
});

it("keeps mismatched operation evidence unknown without holding either Agent", () => {
  const { control, node } = states();
  const operationId = "66666666-6666-4666-8666-666666666666";
  control.operations.push({
    operationId,
    agentId: first,
    nodeId,
    kind: "process",
    requestHash: "c".repeat(64),
    state: "unknown",
    receiptConfirmed: false,
  });
  node.operations.push({
    operationId,
    agentId: second,
    kind: "process",
    requestHash: "c".repeat(64),
    state: "succeeded",
    receipt: { code: 0 },
    sequence: 9,
  });
  expect(reconcileRecoveryState(control, node)).toMatchObject({
    holds: [],
    uncertainties: [
      { agentId: first, reason: "operation_identity_conflict" },
      { agentId: second, reason: "operation_identity_conflict" },
    ],
    confirmed: [],
  });
});
