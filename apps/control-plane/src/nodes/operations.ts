import {
  NodeControlMessageSchema,
  NodeRequestIdSchema,
  type AgentProcessOperation,
  type AgentProvisionStage,
  type ControlWorkspaceOperation,
  type NodeAgentProvisionResult,
  type NodeRequest,
  type NodeWorkspaceOperationResult,
} from "@mate/protocol";
import { randomUUID } from "node:crypto";
import { NodeRequestError, PendingNodeRequests } from "./pending-requests.js";
import { reject, send, type NodeSocket } from "./transport.js";
type ProcessOperationResult = Pick<
  Extract<NodeRequest, { type: "node.process.operation.result" }>,
  "operationId" | "agentId" | "state" | "receipt"
> & {
  revision?: NonNullable<
    Extract<NodeRequest, { type: "node.process.operation.result" }>["revision"]
  >;
};
export type NodeWorkspaceOperationStart = ControlWorkspaceOperation;

export class NodeOperations {
  private readonly pendingAgentProvisions = new PendingNodeRequests<
    NodeAgentProvisionResult,
    { nodeId: string; agentId: string; onProgress: (stage: AgentProvisionStage) => void }
  >();
  private readonly pendingAgentProcessOperations = new PendingNodeRequests<
    ProcessOperationResult,
    { nodeId: string; agentId: string; operationId: string }
  >();
  private readonly pendingWorkspaceOperations = new PendingNodeRequests<
    NodeWorkspaceOperationResult,
    { nodeId: string; agentId: string; operationId: string }
  >();
  private workspaceOperationResultHandler?: (
    nodeId: string,
    result: NodeWorkspaceOperationResult,
  ) => void;
  private processReceiptHandler?: (
    nodeId: string,
    receipt: Omit<ProcessOperationResult, "receipt"> & { receipt: unknown | null },
  ) => void;

  constructor(
    private readonly getConnection: (
      nodeId: string,
      requireReady: boolean,
    ) => NodeSocket | undefined,
    private readonly isCurrent: (nodeId: string, socket: NodeSocket) => boolean,
    private readonly operationTimeoutMs: number,
    private readonly processOperationTimeoutMs: number,
  ) {}
  provisionAgent(
    nodeId: string,
    requestId: string,
    agentId: string,
    onProgress: (stage: AgentProvisionStage) => void,
    verifyOnly = false,
  ): Promise<NodeAgentProvisionResult> {
    const controlMessage = NodeControlMessageSchema.parse({
      type: "control.agent.provision",
      requestId,
      agentId,
      ...(verifyOnly ? { verifyOnly: true } : {}),
    });
    const existing = this.pendingAgentProvisions.get(requestId);
    if (existing) {
      if (existing.nodeId !== nodeId || existing.agentId !== agentId)
        return Promise.reject(
          new NodeRequestError("identity_conflict", "Agent 创建请求标识已被另一请求使用。"),
        );
      return existing.promise;
    }
    const socket = this.getConnection(nodeId, false);
    if (!socket)
      return Promise.reject(
        new NodeRequestError("offline", "所选节点当前离线，Agent 创建尚未开始。"),
      );

    const promise = this.pendingAgentProvisions.start(
      requestId,
      { nodeId, agentId, onProgress },
      this.operationTimeoutMs,
      new NodeRequestError("timeout", "节点执行 Agent 创建超时，结果尚未确认。"),
    );
    try {
      send(socket, controlMessage);
    } catch (error) {
      this.pendingAgentProvisions.reject(
        requestId,
        new NodeRequestError(
          "send_failed",
          error instanceof Error ? error.message : "无法向节点发送 Agent 创建请求。",
          { cause: error },
        ),
      );
    }
    return promise;
  }

  workspaceOperation(
    nodeId: string,
    request: NodeWorkspaceOperationStart,
  ): Promise<NodeWorkspaceOperationResult> {
    const controlMessage = NodeControlMessageSchema.parse(request);
    if (controlMessage.type !== "control.workspace.operation")
      throw new Error("Invalid workspace operation");
    const existing = this.pendingWorkspaceOperations.get(request.requestId);
    if (existing) {
      if (
        existing.nodeId !== nodeId ||
        existing.operationId !== request.operationId ||
        existing.agentId !== request.agentId
      )
        return Promise.reject(
          new NodeRequestError(
            "identity_conflict",
            "Workspace operation request identity conflict",
          ),
        );
      return existing.promise;
    }
    const socket = this.getConnection(nodeId, false);
    if (!socket) return Promise.reject(new NodeRequestError("offline", "Selected node is offline"));

    const promise = this.pendingWorkspaceOperations.start(
      request.requestId,
      { nodeId, operationId: request.operationId, agentId: request.agentId },
      this.operationTimeoutMs,
      new NodeRequestError("timeout", "Node file operation timed out; result is unknown"),
    );
    try {
      send(socket, controlMessage);
    } catch (error) {
      this.pendingWorkspaceOperations.reject(
        request.requestId,
        new NodeRequestError("send_failed", "Could not send workspace operation to node", {
          cause: error,
        }),
      );
    }
    return promise;
  }

  executeAgentProcessOperation(
    nodeId: string,
    request: { operationId: string; agentId: string; operation: AgentProcessOperation },
  ): Promise<ProcessOperationResult> {
    const operationId = NodeRequestIdSchema.parse(request.operationId),
      agentId = NodeRequestIdSchema.parse(request.agentId),
      requestId = randomUUID(),
      controlMessage = NodeControlMessageSchema.parse({
        type: "control.process.operation",
        requestId,
        operationId,
        agentId,
        operation: request.operation,
      });
    const existing = this.pendingAgentProcessOperations.get(requestId);
    if (existing) {
      if (
        existing.nodeId !== nodeId ||
        existing.agentId !== agentId ||
        existing.operationId !== operationId
      )
        return Promise.reject(
          new NodeRequestError(
            "identity_conflict",
            "Agent process operation request identity conflict",
          ),
        );
      return existing.promise;
    }
    const socket = this.getConnection(nodeId, true);
    if (!socket) return Promise.reject(new NodeRequestError("offline", "Selected node is offline"));

    const promise = this.pendingAgentProcessOperations.start(
      requestId,
      { nodeId, agentId, operationId },
      this.processOperationTimeoutMs,
      new NodeRequestError("timeout", "Node operation timed out; its result is not confirmed"),
    );
    try {
      send(socket, controlMessage);
    } catch (error) {
      this.pendingAgentProcessOperations.reject(
        requestId,
        new NodeRequestError("send_failed", "Could not send Agent process operation", {
          cause: error,
        }),
      );
    }
    return promise;
  }

  receiveAgentProvisionMessage(
    socket: NodeSocket,
    nodeId: string | undefined,
    request: Extract<
      NodeRequest,
      { type: "node.agent.provision.progress" | "node.agent.provision.result" }
    >,
  ): void {
    if (!nodeId || !this.isCurrent(nodeId, socket))
      return reject(socket, request.requestId, "not_authenticated", "节点尚未完成身份验证。");
    const pending = this.pendingAgentProvisions.get(request.requestId);
    if (!pending) return;
    if (pending.nodeId !== nodeId || pending.agentId !== request.agentId)
      return reject(socket, request.requestId, "invalid_identity", "Agent 创建结果与请求不匹配。");
    if (request.type === "node.agent.provision.progress") {
      pending.onProgress(request.stage);
      return;
    }
    this.pendingAgentProvisions.resolve(request.requestId, request);
  }

  receiveAgentProcessOperationResult(
    socket: NodeSocket,
    nodeId: string | undefined,
    request: Extract<NodeRequest, { type: "node.process.operation.result" }>,
  ): void {
    if (!nodeId || !this.isCurrent(nodeId, socket))
      return reject(socket, request.requestId, "not_authenticated", "节点尚未完成身份验证。");
    const pending = this.pendingAgentProcessOperations.get(request.requestId);
    if (!pending) {
      const { revision, ...value } = request;
      this.processReceiptHandler?.(nodeId, {
        operationId: value.operationId,
        agentId: value.agentId,
        state: value.state,
        receipt: value.receipt,
        ...(revision !== undefined ? { revision } : {}),
      });
      return;
    }
    if (
      pending.nodeId !== nodeId ||
      pending.agentId !== request.agentId ||
      pending.operationId !== request.operationId
    )
      return reject(
        socket,
        request.requestId,
        "invalid_identity",
        "普通操作收据与节点请求不匹配。",
      );
    this.pendingAgentProcessOperations.resolve(request.requestId, {
      operationId: request.operationId,
      agentId: request.agentId,
      state: request.state,
      receipt: request.receipt,
      ...(request.revision !== undefined ? { revision: request.revision } : {}),
    });
  }

  receiveWorkspaceOperationResult(
    socket: NodeSocket,
    nodeId: string | undefined,
    request: Extract<NodeRequest, { type: "node.workspace.operation.result" }>,
  ): void {
    if (!nodeId || !this.isCurrent(nodeId, socket))
      return reject(socket, request.requestId, "not_authenticated", "节点尚未完成身份验证。");
    const pending = this.pendingWorkspaceOperations.get(request.requestId);
    if (!pending) {
      this.deliverWorkspaceOperationResult(nodeId, request);
      return; // A late receipt may resolve a durable action that already timed out.
    }
    if (
      pending.nodeId !== nodeId ||
      pending.operationId !== request.operationId ||
      pending.agentId !== request.agentId
    )
      return reject(
        socket,
        request.requestId,
        "invalid_identity",
        "文件操作结果与控制面请求不匹配。",
      );
    this.deliverWorkspaceOperationResult(nodeId, request);
    this.pendingWorkspaceOperations.resolve(request.requestId, request);
  }

  deliverWorkspaceOperationResult(nodeId: string, result: NodeWorkspaceOperationResult): void {
    try {
      this.workspaceOperationResultHandler?.(nodeId, result);
    } catch {
      // A receipt write failure does not make the node protocol unauthenticated; a replay can recover it.
    }
  }

  setWorkspaceOperationResultHandler(
    handler: (nodeId: string, result: NodeWorkspaceOperationResult) => void,
  ): void {
    this.workspaceOperationResultHandler = handler;
  }
  setProcessReceiptHandler(handler: NonNullable<NodeOperations["processReceiptHandler"]>): void {
    this.processReceiptHandler = handler;
  }
  rejectForNode(nodeId: string): void {
    this.pendingAgentProvisions.rejectForNode(
      nodeId,
      new NodeRequestError("disconnected", "节点连接已断开，Agent 创建结果尚未确认。"),
    );
    this.pendingAgentProcessOperations.rejectForNode(
      nodeId,
      new NodeRequestError("disconnected", "节点连接已断开，普通操作结果尚未确认。"),
    );
    this.pendingWorkspaceOperations.rejectForNode(
      nodeId,
      new NodeRequestError("disconnected", "节点连接已断开，文件操作结果尚未确认。"),
    );
  }
  hasPendingProcess(nodeId: string, agentId: string, operationId: string): boolean {
    return [...this.pendingAgentProcessOperations.values()].some(
      (p) => p.nodeId === nodeId && p.agentId === agentId && p.operationId === operationId,
    );
  }
  hasPendingWorkspace(nodeId: string, agentId: string, operationId: string): boolean {
    return [...this.pendingWorkspaceOperations.values()].some(
      (p) => p.nodeId === nodeId && p.agentId === agentId && p.operationId === operationId,
    );
  }
  deliverProcessReceipt(
    nodeId: string,
    receipt: Parameters<NonNullable<NodeOperations["processReceiptHandler"]>>[1],
  ): void {
    this.processReceiptHandler?.(nodeId, receipt);
  }
}
