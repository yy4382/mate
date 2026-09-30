import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/http.js";

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

it("answers Agent readiness from the credential row instead of writing Agent state", async () => {
  const fixture = setup();
  const nodeId = randomUUID(),
    agentId = randomUUID(),
    databasePath = join(fixture.dataDir, "control-plane.sqlite");
  const db = new Database(databasePath);
  db.prepare("INSERT INTO nodes(id,public_key,paired_at) VALUES(?,?,?)").run(
    nodeId,
    "synthetic-public-key",
    Date.now(),
  );
  db.close();
  fixture.app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Waiting partner",
    role: "Waits for credentials",
    description: "Synthetic credential readiness fixture.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  fixture.app.agents.complete(
    agentId,
    {
      username: "mate_" + agentId.replaceAll("-", "").slice(0, 27),
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${agentId}`,
      workspaceMarker: "a".repeat(64),
    },
    fixture.app.chat,
  );
  const before = fixture.app.agents.get(agentId)!;
  expect(before.status).toBe("waiting_credentials");

  // Configuring a key is only a credential fact. If it also patched the Agent, this trigger would
  // abort the write, so the request succeeding is the evidence that readiness is derived.
  const faultDb = new Database(databasePath);
  faultDb.exec(`
    CREATE TRIGGER reject_agent_update
    BEFORE UPDATE ON owner_agents
    BEGIN SELECT RAISE(ABORT, 'synthetic Agent write'); END;
  `);
  faultDb.close();

  const cookie = await login(fixture.app);
  const configured = await fixture.app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-derived-readiness-key" }),
  });
  expect(configured.status).toBe(204);
  const withKey = fixture.app.agents.get(agentId)!;
  expect(withKey.status).toBe("ready");
  expect(withKey.updatedAt).toBe(before.updatedAt);

  // Removing it moves the same derived answer back, again without touching the Agent row.
  const removed = await fixture.app.request("/api/owner/model-credentials/openai", {
    method: "DELETE",
    headers: { cookie },
  });
  expect(removed.status).toBe(204);
  expect(fixture.app.agents.get(agentId)?.status).toBe("waiting_credentials");

  // The list endpoint answers from the same rule after a restart, with no readiness row to read.
  fixture.app.close();
  const repairDb = new Database(databasePath);
  repairDb.exec("DROP TRIGGER reject_agent_update");
  repairDb.close();
  const restarted = createControlPlaneApp({
    dataDir: fixture.dataDir,
    passwordFile: fixture.passwordFile,
  });
  fixtures.push({ app: restarted, directory: fixture.directory });
  const restartCookie = await login(restarted);
  expect(restarted.agents.get(agentId)?.status).toBe("waiting_credentials");
  const retried = await restarted.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie: restartCookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-transaction-key" }),
  });
  expect(retried.status).toBe(204);
  expect(restarted.agents.get(agentId)?.status).toBe("ready");
});
