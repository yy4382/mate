import { upgradeWebSocket } from "@hono/node-server";
import type { Hono } from "hono";
import type { NodeDirectory } from "./directory.js";

export function registerNodeRoutes(app: Hono, nodes: NodeDirectory): void {
  app.get(
    "/api/nodes/connect",
    upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        nodes.open(socket);
      },
      onMessage(event, socket) {
        void nodes.receive(socket, event.data).catch(() => {
          nodes.close(socket);
          socket.close(1011, "节点请求处理失败");
        });
      },
      onClose(_event, socket) {
        nodes.close(socket);
      },
      onError(_event, socket) {
        nodes.close(socket);
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
