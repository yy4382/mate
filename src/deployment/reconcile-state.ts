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

export type RecoveryOperationKind = "process" | "workspace" | "stop";
export interface RecoveryOperation {
  operationId: string;
  agentId: string;
  nodeId: string;
  kind: RecoveryOperationKind;
  requestHash: string;
  request?: unknown;
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
  request?: unknown;
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
  uncertainties: Array<{
    agentId: string;
    operationId: string;
    kind: RecoveryOperationKind;
    reason: string;
    request?: unknown;
    evidence?: unknown;
  }>;
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
  const receipts = new Map<string, NodeRecoveryOperation[]>();
  const confirmed: NodeRecoveryOperation[] = [];
  const uncertainties: RecoveryDecision["uncertainties"] = [];
  const uncertain = (
    operation: RecoveryOperation | NodeRecoveryOperation,
    reason: string,
    evidence?: unknown,
  ) => {
    uncertainties.push({
      agentId: operation.agentId,
      operationId: operation.operationId,
      kind: operation.kind,
      request: operation.request,
      reason,
      evidence,
    });
  };
  for (const receipt of node.operations) {
    const key = receipt.kind + ":" + receipt.operationId;
    receipts.set(key, [...(receipts.get(key) ?? []), receipt]);
  }
  for (const [key, entries] of receipts) {
    const receipt = entries[0]!;
    const intent = intents.get(key);
    if (entries.length > 1) {
      for (const entry of entries) uncertain(entry, "node_receipt_version_conflict");
      if (intent) uncertain(intent, "node_receipt_version_conflict");
      continue;
    }
    if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) {
      uncertain(intent ?? receipt, "node_receipt_version_invalid");
      continue;
    }
    if (!intent) {
      uncertain(receipt, "node_operation_without_intent");
      continue;
    }
    if (
      intent.agentId !== receipt.agentId ||
      intent.nodeId !== node.nodeId ||
      intent.requestHash !== receipt.requestHash
    ) {
      uncertain(intent, "operation_identity_conflict");
      if (receipt.agentId !== intent.agentId) uncertain(receipt, "operation_identity_conflict");
      continue;
    }
    if (receipt.state === "started" || receipt.state === "unknown") {
      uncertain(intent, "operation_result_unproven", receipt.receipt);
      continue;
    }
    const controlRevision = intent.nodeReceiptRevision ?? null,
      sameResult =
        intent.state === receipt.state &&
        stableJson(intent.receipt ?? null) === stableJson(receipt.receipt);
    if (controlRevision === receipt.sequence && sameResult) continue;
    if (
      (controlRevision === null &&
        (sameResult ||
          (!intent.receiptConfirmed &&
            ["executing", "unknown", "expired"].includes(intent.state)))) ||
      (controlRevision !== null && receipt.sequence > controlRevision)
    ) {
      confirmed.push(receipt);
      continue;
    }
    uncertain(
      intent,
      controlRevision !== null && receipt.sequence < controlRevision
        ? "node_receipt_stale"
        : controlRevision === null
          ? "node_receipt_version_unproven"
          : "operation_result_conflict",
    );
  }
  for (const intent of control.operations)
    if (!receipts.has(intent.kind + ":" + intent.operationId) && intent.state !== "expired")
      uncertain(intent, "node_receipt_unavailable");
  return {
    holds: [...holds].map(([agentId, reason]) => ({ agentId, reason })),
    uncertainties,
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
