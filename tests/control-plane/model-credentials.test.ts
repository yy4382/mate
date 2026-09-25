import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/control-plane/http.js";

const password = "owner-password-used-only-by-this-test";
const fixtures: Array<{ app: ReturnType<typeof createControlPlaneApp>; directory: string }> = [];

afterEach(() => {
  for (const { app, directory } of fixtures.splice(0)) {
    app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "mate-model-credentials-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  const dataDir = join(directory, "control-plane-data");
  const app = createControlPlaneApp({ dataDir, passwordFile });
  fixtures.push({ app, directory });
  return { app, directory, dataDir, passwordFile };
}

async function login(app: ReturnType<typeof createControlPlaneApp>): Promise<string> {
  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  expect(response.status).toBe(204);
  return response.headers.get("set-cookie")!.split(";", 1)[0]!;
}

it("stores one API key per supported provider without returning it and keeps only its presence visible", async () => {
  const fixture = setup();
  const cookie = await login(fixture.app);
  const syntheticKey = `fixture-${crypto.randomUUID()}`;

  const anonymousWrite = await fixture.app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: syntheticKey }),
  });
  expect(anonymousWrite.status).toBe(401);

  const write = await fixture.app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: syntheticKey }),
  });
  expect(write.status).toBe(204);
  const writeBody = await write.text();
  expect(writeBody.includes(syntheticKey)).toBe(false);

  const listing = await fixture.app.request("/api/owner/model-credentials", {
    headers: { cookie },
  });
  const listingBody = await listing.text();
  expect(listing.status).toBe(200);
  expect(JSON.parse(listingBody)).toMatchObject({
    credentials: [{ provider: "openai", configured: true }],
  });
  expect(listingBody.includes(syntheticKey)).toBe(false);
  expect(statSync(fixture.dataDir).mode & 0o777).toBe(0o700);
  expect(statSync(join(fixture.dataDir, "control-plane.sqlite")).mode & 0o777).toBe(0o600);

  const unsupportedProvider = await fixture.app.request(
    "/api/owner/model-credentials/unknown-service",
    {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ apiKey: syntheticKey }),
    },
  );
  expect(unsupportedProvider.status).toBe(400);
  expect((await unsupportedProvider.text()).includes(syntheticKey)).toBe(false);

  fixture.app.close();
  const restarted = createControlPlaneApp({
    dataDir: fixture.dataDir,
    passwordFile: fixture.passwordFile,
  });
  fixtures.push({ app: restarted, directory: fixture.directory });
  const afterRestart = await restarted.request("/api/owner/model-credentials", {
    headers: { cookie },
  });
  const restartedBody = await afterRestart.text();
  expect(afterRestart.status).toBe(200);
  expect(JSON.parse(restartedBody)).toMatchObject({
    credentials: [{ provider: "openai", configured: true }],
  });
  expect(restartedBody.includes(syntheticKey)).toBe(false);
});
