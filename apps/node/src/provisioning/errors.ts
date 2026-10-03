import type { NodeAgentProvisionResult } from "@mate/protocol";
export type AgentProvisionFailureCode = Extract<NodeAgentProvisionResult, { ok: false }>["code"];

export class AgentProvisioningError extends Error {
  constructor(
    readonly code: AgentProvisionFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentProvisioningError";
  }
}
