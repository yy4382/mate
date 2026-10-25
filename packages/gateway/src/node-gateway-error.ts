/** A refused node operation changes nothing. */
export type NodeGatewayErrorReason = "invalid-input" | "name-taken" | "unknown-node";

export class NodeGatewayError extends Error {
  readonly reason: NodeGatewayErrorReason;

  constructor(reason: NodeGatewayErrorReason, message: string) {
    super(message);
    this.name = "NodeGatewayError";
    this.reason = reason;
  }
}
