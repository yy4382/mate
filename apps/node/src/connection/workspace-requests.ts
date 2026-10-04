import { NodeRequestSchema, type NodeControlMessage } from "@mate/protocol";
import type {
  LinuxWorkspaceExecutor,
  WorkspaceExecutionRequest,
} from "../files/workspace-executor.js";
import { sendWorkspaceOperationResult } from "../files/workspace-result.js";
export type NodeWorkspaceExecutor = Pick<LinuxWorkspaceExecutor, "execute" | "status"> &
  Partial<Pick<LinuxWorkspaceExecutor, "receiptRevision">>;
/** Complete file execution and durable receipt replies for one initiating connection. */
export class NodeWorkspaceRequests {
  constructor(
    private readonly executor: NodeWorkspaceExecutor | undefined,
    private readonly canSend: () => boolean,
    private readonly send: (request: unknown) => void,
  ) {}
  operation(message: Extract<NodeControlMessage, { type: "control.workspace.operation" }>): void {
    const executor = this.executor;
    const { requestId, operationId, agentId, mode, operation } = message,
      request: WorkspaceExecutionRequest = { operationId, agentId, mode, operation };
    if (!executor) {
      this.send({
        type: "node.workspace.operation.result",
        requestId,
        operationId,
        agentId,
        ok: false,
        error: "Linux workspace executor is unavailable",
      });
      return;
    }
    void executor
      .execute(request)
      .then(
        (result) => {
          if (!this.canSend()) return;
          const revision = executor.receiptRevision?.(agentId, operationId);
          sendWorkspaceOperationResult(
            (response) => this.send(response),
            {
              requestId,
              operationId,
              agentId,
              ...(revision !== undefined ? { revision } : {}),
            },
            result,
          );
        },
        () => {
          if (!this.canSend()) return;
          this.send({
            type: "node.workspace.operation.result",
            requestId,
            operationId,
            agentId,
            ok: false,
            error: "Linux workspace operation could not be confirmed",
          });
        },
      )
      .catch(() => undefined);
    return;
  }
  reconcile(message: Extract<NodeControlMessage, { type: "control.workspace.reconcile" }>): void {
    this.send({
      type: "node.workspace.reconcile.result",
      requestId: message.requestId,
      receipts: message.operations.flatMap(({ agentId, operationId, requestHash }) => {
        try {
          const result = this.executor?.status(agentId, operationId, requestHash);
          const revision = this.executor?.receiptRevision?.(agentId, operationId);
          if (!result) return [];
          const receipt = { operationId, agentId, result: { ...result, revision } };
          return NodeRequestSchema.safeParse({
            type: "node.workspace.reconcile.result",
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
    return;
  }
}
