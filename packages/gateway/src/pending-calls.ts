import type { Clock } from "@mate/clock";
import type { ToolResult } from "@mate/node-protocol";
import type { WebSocket } from "ws";

interface Pending {
  /** The connection the call was sent on. Only that connection may answer it. */
  socket: WebSocket;
  agentId: string;
  onOutput: (chunk: string) => void;
  resolve: (result: ToolResult) => void;
  /** Aborted once the call settles, which cancels its timeout. */
  settled: AbortController;
}

/**
 * In-flight requests from the gateway to its nodes, keyed by request ID and bound to the connection that carried them.
 * Binding to the connection rather than the node means a call ends when its connection ends, and an answer arriving on
 * any other connection (a reconnect, a displaced connection) is dropped without a separate check.
 */
export class PendingCalls {
  readonly #calls = new Map<string, Pending>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  add(
    requestId: string,
    socket: WebSocket,
    agentId: string,
    onOutput: (chunk: string) => void,
    timeoutMs: number,
    onTimeout: () => ToolResult,
  ): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve) => {
      const settled = new AbortController();
      this.#calls.set(requestId, { socket, agentId, onOutput, resolve, settled });
      void this.#clock.sleep(timeoutMs, settled.signal).then(() => {
        if (!settled.signal.aborted) this.settle(requestId, onTimeout());
      });
    });
  }

  receiveOutput(socket: WebSocket, requestId: string, chunk: string): void {
    const call = this.#calls.get(requestId);
    if (call?.socket === socket) call.onOutput(chunk);
  }

  receiveResult(socket: WebSocket, requestId: string, result: ToolResult): void {
    if (this.#calls.get(requestId)?.socket === socket) this.settle(requestId, result);
  }

  /** End every call carried by a connection that has gone away. */
  settleForSocket(socket: WebSocket, result: () => ToolResult): void {
    for (const [requestId, call] of this.#calls) {
      if (call.socket === socket) this.settle(requestId, result());
    }
  }

  /** End every call of one agent carried by a connection. */
  settleForAgent(socket: WebSocket, agentId: string, result: () => ToolResult): void {
    for (const [requestId, call] of this.#calls) {
      if (call.socket === socket && call.agentId === agentId) this.settle(requestId, result());
    }
  }

  /** Resolve one call; a call that has already settled is left alone. */
  settle(requestId: string, result: ToolResult): void {
    const call = this.#calls.get(requestId);
    if (!call) return;
    this.#calls.delete(requestId);
    call.settled.abort();
    call.resolve(result);
  }
}

export function unknownResult(): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: "The result is unknown and was not retried: the node connection was lost while the tool call was in flight.",
      },
    ],
    isError: true,
  };
}

export function offlineResult(): ToolResult {
  return {
    content: [{ type: "text", text: "Node offline: the node is not currently connected." }],
    isError: true,
  };
}

export function stoppedResult(): ToolResult {
  return {
    content: [{ type: "text", text: "Tool call stopped by stopAgent." }],
    isError: true,
  };
}

export function prepareWorkspaceOfflineResult(): ToolResult {
  return {
    content: [
      { type: "text", text: "Node offline: cannot prepare workspace while node is disconnected." },
    ],
    isError: true,
  };
}
