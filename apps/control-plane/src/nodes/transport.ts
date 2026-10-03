import type { NodeControlMessage } from "@mate/protocol";
export interface NodeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface SocketSession {
  nonce: string;
  lastHeartbeatAt: number;
  nodeId?: string;
  ready?: boolean;
  reconcile?: {
    requestId: string;
    operations: Map<string, string>;
    cursor: string;
    blocking: boolean;
  };
  workspaceReconcile?: {
    requestId: string;
    operations: Map<string, string>;
    cursor: string;
    blocking: boolean;
  };
  handshakeTimeout?: ReturnType<typeof setTimeout>;
}

export function send(socket: NodeSocket, message: NodeControlMessage): void {
  socket.send(JSON.stringify(message));
}
export function reject(
  socket: NodeSocket,
  requestId: string | undefined,
  code: Extract<NodeControlMessage, { type: "control.error" }>["code"],
  message: string,
): void {
  send(socket, {
    type: "control.error",
    ...(requestId ? { requestId } : {}),
    code,
    message,
  });
  socket.close(1008, code);
}
