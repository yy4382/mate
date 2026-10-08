import { NodeRequestSchema, type NodeControlMessage } from "@mate/protocol";
import type { AgentProcessOperations } from "../processes/operation-ledger.js";

/** Complete process execution and durable receipt replies for one initiating connection. */
export class NodeProcessRequests {
  constructor(
    private readonly operations: AgentProcessOperations,
    private readonly canSend: () => boolean,
    private readonly send: (request: unknown) => void,
  ) {}

  operation(message: Extract<NodeControlMessage, { type: "control.process.operation" }>): void {
    const { requestId, operationId, agentId, operation } = message;
    // Execution outlives the socket; durable receipts serve later reconnection.
    void this.operations
      .execute(agentId, operationId, operation)
      .then((result) => {
        if (!this.canSend()) return;
        this.send({
          type: "node.process.operation.result",
          requestId,
          operationId,
          agentId,
          state: result.state === "started" ? "unknown" : result.state,
          receipt: result.receipt,
          revision: result.revision,
        });
      })
      .catch(() => {
        if (!this.canSend()) return;
        this.send({
          type: "node.process.operation.result",
          requestId,
          operationId,
          agentId,
          state: "unknown",
          receipt: { reason: "node_operation_result_unavailable" },
        });
      });
  }

  reconcile(message: Extract<NodeControlMessage, { type: "control.process.reconcile" }>): void {
    this.send({
      type: "node.process.reconcile.result",
      requestId: message.requestId,
      receipts: message.operations.flatMap(({ agentId, operationId, requestHash }) => {
        try {
          const result = this.operations.status(agentId, operationId, requestHash);
          if (!result || result.state === "started") return [];
          const receipt = {
            operationId,
            agentId,
            state: result.state,
            receipt: result.receipt,
            revision: result.revision,
          };
          return NodeRequestSchema.safeParse({
            type: "node.process.reconcile.result",
            requestId: message.requestId,
            receipts: [receipt],
          }).success
            ? [receipt]
            : [];
        } catch {
          return [];
        }
      }),
    });
  }
}
