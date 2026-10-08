import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlane } from "../../src/application.js";

const ownerPassword = "owner-password-used-only-by-this-test";
const fixtures: Array<{ app: ReturnType<typeof createControlPlane>; directory: string }> = [];

afterEach(() => {
  for (const { app, directory } of fixtures.splice(0)) {
    app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "mate-node-pairing-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${ownerPassword}\n`, { mode: 0o600 });
  const app = createControlPlane({
    dataDir: join(directory, "control-plane"),
    passwordFile,
  });
  fixtures.push({ app, directory });
  return app;
}

async function login(app: ReturnType<typeof createControlPlane>): Promise<string> {
  const response = await app.http.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: ownerPassword }),
  });
  expect(response.status).toBe(204);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  return cookie!;
}

it("lets only the signed-in owner create a one-time node pairing token", async () => {
  const app = setup();

  const rejected = await app.http.request("/api/owner/nodes/pairing-tokens", { method: "POST" });
  const anonymousList = await app.http.request("/api/owner/nodes");
  const anonymousPage = await app.http.request("/app/nodes", { redirect: "manual" });
  const publicStatus = await app.http.request("/api/status");
  const cookie = await login(app);
  const created = await app.http.request("/api/owner/nodes/pairing-tokens", {
    method: "POST",
    headers: { cookie },
  });
  expect(rejected.status).toBe(401);
  expect(anonymousList.status).toBe(401);
  expect(anonymousPage.status).toBe(302);
  expect(anonymousPage.headers.get("location")).toBe("/login?next=%2Fapp%2Fnodes");
  expect(await publicStatus.json()).toEqual({ status: "running" });
  expect(created.status).toBe(201);
  const token = (await created.json()) as { pairingToken?: unknown; expiresAt?: unknown };
  const nodes = await app.http.request("/api/owner/nodes", { headers: { cookie } });
  const nodesBody = await nodes.text();

  expect(typeof token.pairingToken).toBe("string");
  expect(token.pairingToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  expect(typeof token.expiresAt).toBe("string");
  expect(Number.isNaN(Date.parse(token.expiresAt as string))).toBe(false);
  expect(nodes.status).toBe(200);
  expect(nodes.headers.get("cache-control")).toBe("no-store");
  expect(JSON.parse(nodesBody)).toEqual({ nodes: [] });
  expect(nodesBody).not.toContain(token.pairingToken);
});
