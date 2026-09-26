/** Facts read from separate stopped control-plane and node checkpoints. */
export interface RecoveryAgent {
  id: string;
  nodeId: string;
  uid: number;
  gid: number;
  home: string;
  homeMarker: string;
  username?: string;
}

export type RecoveryOperationKind = "process" | "workspace" | "privileged" | "stop";
export interface RecoveryOperation {
  operationId: string;
  agentId: string;
  nodeId: string;
  kind: RecoveryOperationKind;
  requestHash: string;
  state: "executing" | "unknown" | "succeeded" | "failed" | "expired";
  receiptConfirmed: boolean;
  nodeReceiptRevision?: number | null;
  receipt?: unknown | null;
}

export interface NodeRecoveryOperation {
  operationId: string;
  agentId: string;
  kind: RecoveryOperationKind;
  requestHash: string;
  state: "started" | "unknown" | "succeeded" | "failed";
  receipt: unknown | null;
  startedAt?: number;
  /** Durable per-operation sequence; wall-clock time is never a version. */
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
  const holds = new Map<string, string>();
  const localAgents = new Map(node.agents.map((agent) => [agent.id, agent]));
  const localControlAgents = control.agents.filter((agent) => agent.nodeId === control.nodeId);
  const nodeIdentityTrusted =
    control.nodeId === node.nodeId && control.nodePublicKey === node.nodePublicKey;
  if (!nodeIdentityTrusted)
    for (const agent of localControlAgents) holds.set(agent.id, "node_identity_unproven");
  const trustedAgentIds = new Set<string>();
  for (const agent of control.agents) {
    if (agent.nodeId !== node.nodeId) continue;
    const local = localAgents.get(agent.id);
    if (
      !local ||
      local.nodeId !== agent.nodeId ||
      local.uid !== agent.uid ||
      local.gid !== agent.gid ||
      local.home !== agent.home ||
      local.homeMarker !== agent.homeMarker ||
      (agent.username !== undefined && local.username !== agent.username)
    ) {
      holds.set(agent.id, "agent_identity_unproven");
    } else {
      trustedAgentIds.add(agent.id);
    }
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
    if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) {
      if (localAgents.has(receipt.agentId))
        holds.set(receipt.agentId, "node_receipt_version_invalid");
      continue;
    }
    const key = receipt.kind + ":" + receipt.operationId;
    const old = receipts.get(key);
    if (old) {
      for (const agentId of new Set([old.agentId, receipt.agentId]))
        if (localAgents.has(agentId)) holds.set(agentId, "node_receipt_version_conflict");
      if (old.sequence >= receipt.sequence) continue;
    }
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
      holds.set(intent.agentId, "operation_result_unproven");
      continue;
    }
    const controlRevision = intent.nodeReceiptRevision ?? null,
      sameResult =
        intent.state === receipt.state &&
        stableJson(intent.receipt ?? null) === stableJson(receipt.receipt);
    if (controlRevision === receipt.sequence && sameResult) continue;
    if (
      controlRevision === null &&
      (sameResult ||
        (!intent.receiptConfirmed &&
          (intent.state === "executing" ||
            intent.state === "unknown" ||
            intent.state === "expired")))
    ) {
      confirmed.push(receipt);
      continue;
    }
    if (controlRevision !== null && receipt.sequence > controlRevision) {
      confirmed.push(receipt);
      continue;
    }
    holds.set(
      intent.agentId,
      controlRevision !== null && receipt.sequence < controlRevision
        ? "node_receipt_stale"
        : controlRevision === null
          ? "node_receipt_version_unproven"
          : "operation_result_conflict",
    );
  }
  for (const intent of control.operations) {
    const key = intent.kind + ":" + intent.operationId;
    if (
      !receipts.has(key) &&
      (intent.state === "executing" ||
        intent.state === "unknown" ||
        (intent.state !== "expired" &&
          (intent.receiptConfirmed ||
            intent.nodeReceiptRevision !== null ||
            intent.state === "succeeded" ||
            intent.state === "failed")))
    )
      holds.set(intent.agentId, "node_receipt_unavailable");
  }
  return {
    holds: [...holds].map(([agentId, reason]) => ({ agentId, reason })),
    // Operation uncertainty blocks new work for its Agent but does not invalidate a separate,
    // independently matched terminal receipt. Only untrusted node or Agent identity does that.
    confirmed: confirmed.filter(
      (receipt) => nodeIdentityTrusted && trustedAgentIds.has(receipt.agentId),
    ),
  };
}

function stableJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (typeof item !== "object" || item === null) return item;
    return Object.fromEntries(
      Object.entries(item)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  };
  return JSON.stringify(canonical(value));
}
