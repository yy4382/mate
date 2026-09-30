import type { Operation } from "@mate/protocol";

export interface ExecutionRequest {
  root: string;
  operation: Operation;
  timeoutMs: number;
  agentId?: string;
  /** Stable Agent operation identity, so one request is recognised across node restarts. */
  operationId?: string;
}
export interface ExecutionResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}
export interface ExecutionBackend {
  execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult>;
}
