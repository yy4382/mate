import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/control-plane/http.js";

it("reports only the running status through the control-plane HTTP API", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mate-control-plane-http-"));
  const app = createControlPlaneApp({ dataDir });
  try {
    const response = await app.request("/api/status");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "running" });
  } finally {
    app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
