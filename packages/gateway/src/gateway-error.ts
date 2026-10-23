/** A refused node operation changes nothing. */
export type GatewayErrorReason = "invalid-input" | "name-taken" | "unknown-node";

export class GatewayError extends Error {
  readonly reason: GatewayErrorReason;

  constructor(reason: GatewayErrorReason, message: string) {
    super(message);
    this.name = "GatewayError";
    this.reason = reason;
  }
}
