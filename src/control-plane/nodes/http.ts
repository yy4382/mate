import { upgradeWebSocket } from "@hono/node-server";
import type { Hono } from "hono";
import type { NodeDirectory, NodeSocket } from "./directory.js";

export function registerNodeRoutes(app: Hono, nodes: NodeDirectory): void {
  const adapters = new WeakMap<object, NodeSocket>();
  app.get(
    "/api/nodes/connect",
    upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        nodes.open(asNodeSocket(socket, adapters));
      },
      onMessage(event, socket) {
        const nodeSocket = asNodeSocket(socket, adapters);
        void nodes.receive(nodeSocket, event.data).catch(() => {
          nodes.close(nodeSocket);
          nodeSocket.terminate();
        });
      },
      onClose(_event, socket) {
        nodes.close(asNodeSocket(socket, adapters));
      },
      onError(_event, socket) {
        nodes.close(asNodeSocket(socket, adapters));
      },
    })),
  );

  app.post("/api/owner/nodes/pairing-tokens", (context) => {
    context.header("Cache-Control", "no-store");
    return context.json(nodes.createPairingToken(), 201);
  });

  app.get("/api/owner/nodes", (context) => {
    context.header("Cache-Control", "no-store");
    return context.json({ nodes: nodes.list() });
  });
}

function asNodeSocket(
  socket: {
    send(data: string): void;
    close(code?: number, reason?: string): void;
    raw?: unknown;
  },
  adapters: WeakMap<object, NodeSocket>,
): NodeSocket {
  const existing = adapters.get(socket);
  if (existing) return existing;
  const rawSocket = socket.raw as { terminate?: () => void } | undefined;
  if (!rawSocket?.terminate) throw new Error("节点 WebSocket 适配器没有提供强制终止能力");
  const forceTerminate = rawSocket.terminate.bind(rawSocket);
  const adapter: NodeSocket = {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    terminate: forceTerminate,
  };
  adapters.set(socket, adapter);
  return adapter;
}
