import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlane } from "../../src/application.js";

const password = "owner-password-used-only-by-this-test";
const cases: Array<{ app: ReturnType<typeof createControlPlane>; dataDir: string }> = [];

afterEach(() => {
  for (const { app, dataDir } of cases.splice(0)) {
    app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "mate-owner-channels-"));
  chmodSync(dataDir, 0o700);
  const passwordFile = join(dataDir, "owner-password");
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  const app = createControlPlane({ dataDir, passwordFile });
  cases.push({ app, dataDir });
  return app;
}

/** The control-plane database file for a fixture created by {@link setup}. */
function databaseFor(app: ReturnType<typeof createControlPlane>) {
  const fixture = cases.find((entry) => entry.app === app);
  if (!fixture) throw new Error("The fixture was already cleaned up");
  return new Database(join(fixture.dataDir, "control-plane.sqlite"));
}

async function ownerCookie(app: ReturnType<typeof createControlPlane>): Promise<string> {
  const login = await app.http.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  expect(login.status).toBe(204);
  return login.headers.get("set-cookie")!.split(";", 1)[0]!;
}

it("lets the owner create and list a public channel through the control-plane API", async () => {
  const app = setup();
  const anonymous = await app.http.request("/api/owner/channels");
  const cookie = await ownerCookie(app);

  expect(anonymous.status).toBe(401);

  const createdResponse = await app.http.request("/api/owner/channels", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "研究", description: "一起讨论研究进展", visibility: "public" }),
  });
  expect(createdResponse.status).toBe(201);
  const created = await createdResponse.json();
  expect(created).toMatchObject({
    name: "研究",
    description: "一起讨论研究进展",
    visibility: "public",
    archived: false,
  });
  expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);

  const listResponse = await app.http.request("/api/owner/channels", { headers: { cookie } });
  expect(listResponse.status).toBe(200);
  expect(await listResponse.json()).toEqual({ channels: [created] });
});

it("lets the owner update and archive a private channel through the control-plane API", async () => {
  const app = setup();
  const cookie = await ownerCookie(app);
  const createResponse = await app.http.request("/api/owner/channels", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      name: "私人空间",
      description: "只有所有者可见",
      visibility: "private",
    }),
  });
  const created = await createResponse.json();

  expect(createResponse.status).toBe(201);
  expect(created.visibility).toBe("private");

  const updateResponse = await app.http.request(`/api/owner/channels/${created.id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      name: "私人研究",
      description: "仅所有者查看的研究记录",
      archived: true,
    }),
  });

  expect(updateResponse.status).toBe(200);
  expect(await updateResponse.json()).toMatchObject({
    id: created.id,
    name: "私人研究",
    description: "仅所有者查看的研究记录",
    visibility: "private",
    archived: true,
  });

  const listResponse = await app.http.request("/api/owner/channels", { headers: { cookie } });
  expect(await listResponse.json()).toMatchObject({
    channels: [
      {
        id: created.id,
        name: "私人研究",
        visibility: "private",
        archived: true,
      },
    ],
  });
});

it("refuses to publish a direct message as a public channel", async () => {
  const app = setup();
  const cookie = await ownerCookie(app);
  const agentId = randomUUID(),
    db = databaseFor(app);
  try {
    const nodeId = randomUUID();
    db.prepare("INSERT INTO nodes(id,public_key,paired_at) VALUES(?,?,?)").run(
      nodeId,
      `synthetic-${nodeId}`,
      Date.now(),
    );
    app.agents.prepare({
      id: agentId,
      nodeId,
      name: "私信同伴",
      role: "只通过私信交流",
      description: "Synthetic direct-message fixture.",
      model: { provider: "openai", id: "gpt-4.1" },
    });
    // The owner DM channel exists once the Agent's workspace preparation reached `complete`.
    db.prepare("UPDATE owner_agents SET stage='complete' WHERE id=?").run(agentId);
    const direct = app.chat.getOrCreateAgentDirectChannel(agentId);
    if (!direct) throw new Error("The direct message fixture did not create a channel");

    const publish = await app.http.request(`/api/owner/channels/${direct.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ visibility: "public" }),
    });
    expect(publish.status).toBe(400);
    expect(await publish.json()).toEqual({ error: "私信不能改为公开" });
    expect(app.chat.listChannels().find((channel) => channel.id === direct.id)?.visibility).toBe(
      "private",
    );

    // Renaming the same direct message still works.
    const rename = await app.http.request(`/api/owner/channels/${direct.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "改名的私信" }),
    });
    expect(rename.status).toBe(200);
    expect(await rename.json()).toMatchObject({ id: direct.id, name: "改名的私信" });
  } finally {
    db.close();
  }
});
