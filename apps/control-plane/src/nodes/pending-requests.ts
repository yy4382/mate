/** Failures of the control plane's node transport, independent of diagnostic wording. */
export class NodeRequestError extends Error {
  constructor(
    readonly code: "offline" | "timeout" | "disconnected" | "send_failed" | "identity_conflict",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NodeRequestError";
  }
}

/** Only in-memory request correlation and cleanup; durable receipts stay with their domain. */
export class PendingNodeRequests<Result, Identity extends { nodeId: string }> {
  private readonly requests = new Map<
    string,
    Identity & {
      promise: Promise<Result>;
      resolve: (result: Result) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  get(requestId: string) {
    return this.requests.get(requestId);
  }
  values() {
    return this.requests.values();
  }

  start(
    requestId: string,
    identity: Identity,
    timeoutMs: number,
    timeoutError: Error,
  ): Promise<Result> {
    const completion = Promise.withResolvers<Result>();
    const timeout = setTimeout(() => this.reject(requestId, timeoutError), timeoutMs);
    this.requests.set(requestId, { ...identity, ...completion, timeout });
    return completion.promise;
  }

  resolve(requestId: string, result: Result): void {
    this.take(requestId)?.resolve(result);
  }

  reject(requestId: string, error: Error): void {
    this.take(requestId)?.reject(error);
  }

  rejectForNode(nodeId: string, error: Error): void {
    for (const [requestId, pending] of this.requests) {
      if (pending.nodeId === nodeId) this.reject(requestId, error);
    }
  }

  private take(requestId: string) {
    const pending = this.requests.get(requestId);
    if (pending) {
      this.requests.delete(requestId);
      clearTimeout(pending.timeout);
    }
    return pending;
  }
}
