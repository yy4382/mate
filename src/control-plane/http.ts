import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

/** The public status contract deliberately contains no deployment or Agent details. */
export function createControlPlaneApp(webRoot?: string) {
  const app = new Hono();

  app.get("/api/status", (context) => context.json({ status: "running" as const }));

  if (webRoot) {
    app.get("/", serveStatic({ root: webRoot, path: "index.html" }));
    app.get("/assets/*", serveStatic({ root: webRoot }));
  }

  return app;
}
