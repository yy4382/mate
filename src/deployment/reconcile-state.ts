/** Facts read from separate stopped control-plane and node checkpoints. */
export interface RecoveryAgent {
  id: string;
  nodeId: string;
  uid: number;
  gid: number;
  home: string;
  homeMarker: string;
}

export type RecoveryOperationKind = "process" | "workspace" | "privileged" | "stop";
export interface RecoveryOperation {
  operationId: string;
  agentId: string;
  nodeId: string;
  kind: RecoveryOperationKind;
  requestHash: string;
  state: "executing" | "unknown" | "succeeded" | "failed";
  receiptConfirmed: boolean;
}

export interface NodeRecoveryOperation {
  operationId: string;
  agentId: string;
  kind: RecoveryOperationKind;
  requestHash: string;
  state: "started" | "unknown" | "succeeded" | "failed";
  receipt: unknown | null;
  /** Durable per-node sequence; wall-clock time is never a version. */
  sequence: number;
}

export interface RecoveryState {
  nodeId: string;
  nodePublicKey: string;
  agents: RecoveryAgent[];
  operations: RecoveryOperation[];
}

export interface NodeRecoveryState {
  nodeId: string;
  nodePublicKey: string;
  agents: RecoveryAgent[];
  operations: NodeRecoveryOperation[];
}

export interface RecoveryDecision {
  holds: Array<{ agentId: string; reason: string }>;
  confirmed: NodeRecoveryOperation[];
}

/** A node result is accepted only for the same object and immutable operation request. */
export function reconcileRecoveryState(
  control: RecoveryState,
  node: NodeRecoveryState,
): RecoveryDecision {
  if (control.nodeId !== node.nodeId || control.nodePublicKey !== node.nodePublicKey)
    throw new Error("Restored node identity does not match the control-plane pairing");
  const holds = new Map<string, string>();
  const localAgents = new Map(node.agents.map((agent) => [agent.id, agent]));
  for (const agent of control.agents) {
    const local = localAgents.get(agent.id);
    if (
      !local ||
      local.nodeId !== agent.nodeId ||
      local.uid !== agent.uid ||
      local.gid !== agent.gid ||
      local.home !== agent.home ||
      local.homeMarker !== agent.homeMarker
    )
      holds.set(agent.id, "agent_identity_unproven");
  }
  const intents = new Map(
    control.operations.map((operation) => [
      operation.kind + ":" + operation.operationId,
      operation,
    ]),
  );
  const receipts = new Map<string, NodeRecoveryOperation>();
  const confirmed: NodeRecoveryOperation[] = [];
  for (const receipt of node.operations) {
    if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1)
      throw new Error("Node operation sequence is not monotonic");
    const key = receipt.kind + ":" + receipt.operationId;
    const old = receipts.get(key);
    if (old && old.sequence >= receipt.sequence)
      throw new Error("Node operation sequence moved backward");
    receipts.set(key, receipt);
    const intent = intents.get(key);
    if (!intent) {
      if (localAgents.has(receipt.agentId))
        holds.set(receipt.agentId, "node_operation_without_intent");
      continue;
    }
    if (
      intent.agentId !== receipt.agentId ||
      intent.nodeId !== node.nodeId ||
      intent.requestHash !== receipt.requestHash
    ) {
      holds.set(intent.agentId, "operation_identity_conflict");
      if (localAgents.has(receipt.agentId))
        holds.set(receipt.agentId, "operation_identity_conflict");
      continue;
    }
    if (receipt.state === "started" || receipt.state === "unknown") {
      if (intent.state === "executing" || intent.state === "unknown")
        holds.set(intent.agentId, "operation_result_unproven");
      continue;
    }
    if (intent.state !== "succeeded" && intent.state !== "failed") confirmed.push(receipt);
    else if (intent.state !== receipt.state) holds.set(intent.agentId, "operation_result_conflict");
  }
  for (const intent of control.operations) {
    const key = intent.kind + ":" + intent.operationId;
    if (!receipts.has(key) && (intent.state === "executing" || intent.state === "unknown"))
      holds.set(intent.agentId, "node_receipt_unavailable");
  }
  return {
    holds: [...holds].map(([agentId, reason]) => ({ agentId, reason })),
    confirmed: confirmed.filter((receipt) => !holds.has(receipt.agentId)),
  };
}
