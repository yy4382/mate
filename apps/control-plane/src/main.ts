import { serve, type ServerType, type WebSocketServerLike } from "@hono/node-server";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";
import {
  createControlPlaneApp,
  type ControlPlaneAppOptions,
  type ControlPlaneTestDependencies,
} from "./http.js";
import { MAX_NODE_MESSAGE_BYTES } from "@mate/protocol";
import { webRoot as builtWebRoot } from "@mate/web/assets";

export function startControlPlane(
  port = parsePort(process.env.MATE_CONTROL_PLANE_PORT ?? "8787"),
  webRoot = builtWebRoot,
  appOptions: ControlPlaneAppOptions = {},
  testDependencies: ControlPlaneTestDependencies = {},
): ServerType {
  const app = createControlPlaneApp({ ...appOptions, webRoot }, testDependencies);
  // Ordinary command receipts carry bounded stdout and stderr with the protocol metadata.
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_NODE_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  // The Hono adapter documents ws directly, but its type differs on noServer and send options.
  const websocketServerAdapter = websocketServer as WebSocketServerLike;
  const server = serve({
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port,
    websocket: { server: websocketServerAdapter },
  });

  server.once("listening", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      process.stderr.write("Control-plane HTTP server did not report a network address\n");
      process.exitCode = 1;
      app.close();
      websocketServer.close();
      server.close();
      return;
    }
    process.stdout.write(`MATE_CONTROL_PLANE_LISTENING ${address.port}\n`);
  });

  const shutdown = () => {
    app.close();
    websocketServer.close();
    server.close((error) => {
      if (error) {
        process.stderr.write(`Control-plane HTTP shutdown failed: ${error.message}\n`);
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}

function parsePort(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value))
    throw new Error("MATE_CONTROL_PLANE_PORT must be an integer");
  const port = Number(value);
  if (port > 65535) throw new Error("MATE_CONTROL_PLANE_PORT must be between 0 and 65535");
  return port;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url))
  startControlPlane();
