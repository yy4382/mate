import { serve, type ServerType } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createControlPlaneApp } from "./http.js";

export function startControlPlane(
  port = parsePort(process.env.MATE_CONTROL_PLANE_PORT ?? "8787"),
  webRoot = fileURLToPath(new URL("../../web/", import.meta.url)),
): ServerType {
  const app = createControlPlaneApp({ webRoot });
  const server = serve({
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port,
  });

  server.once("listening", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      process.stderr.write("Control-plane HTTP server did not report a network address\n");
      process.exitCode = 1;
      server.close();
      app.close();
      return;
    }
    process.stdout.write(`MATE_CONTROL_PLANE_LISTENING ${address.port}\n`);
  });

  const shutdown = () => {
    server.close((error) => {
      if (error) {
        process.stderr.write(`Control-plane HTTP shutdown failed: ${error.message}\n`);
        process.exitCode = 1;
      }
      app.close();
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  startControlPlane();
