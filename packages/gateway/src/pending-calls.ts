import type { ToolResult } from "@mate/node-protocol";
import type { WebSocket } from "ws";

interface Pending {
  /** The connection the call was sent on. Only that connection may answer it. */
  socket: WebSocket;
  onOutput: (chunk: string) => void;
  resolve: (result: ToolResult) => void;
}

/**
 * In-flight requests from the gateway to its nodes, keyed by the request ID the gateway chose for each and bound to the
 * connection that carried it. Binding to the connection rather than the node means a call ends when its connection
 * ends, and an answer arriving on any other connection (a reconnect, a displaced connection) is dropped without a
 * separate check. A call has no deadline of its own: a dead link is found by the heartbeat, and a command's duration is
 * its own `timeout`.
 */
export class PendingCalls {
  readonly #calls = new Map<string, Pending>();

  add(
    requestId: string,
    socket: WebSocket,
    onOutput: (chunk: string) => void,
  ): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve) => {
      this.#calls.set(requestId, { socket, onOutput, resolve });
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

  /** Resolve one call. Returns false, and changes nothing, when it has already settled. */
  settle(requestId: string, result: ToolResult): boolean {
    const call = this.#calls.get(requestId);
    if (!call) return false;
    this.#calls.delete(requestId);
    call.resolve(result);
    return true;
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
    content: [
      {
        type: "text",
        text: "The tool call was stopped before it finished; whatever it already did stays done. It was not retried.",
      },
    ],
    isError: true,
  };
}
