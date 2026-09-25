import { expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/control-plane/http.js";

it("reports only the running status through the control-plane HTTP API", async () => {
  const app = createControlPlaneApp(),
    response = await app.request("/api/status");

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({ status: "running" });
});
