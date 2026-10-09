import type { NodeWorkspaceOperationResult, WorkspaceOperation } from "@mate/protocol";

export interface ExecutionRequest {
  root: string;
  operation: WorkspaceOperation;
  timeoutMs: number;
  agentId?: string;
  /** Stable Agent operation identity, so one request is recognised across node restarts. */
  operationId?: string;
}
export type ExecutionResult = Extract<NodeWorkspaceOperationResult, { ok: true }>["result"];
export interface ExecutionBackend {
  execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult>;
}
