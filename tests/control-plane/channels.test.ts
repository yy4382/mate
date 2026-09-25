import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/control-plane/http.js";

const password = "owner-password-used-only-by-this-test";
const cases: Array<{ app: ReturnType<typeof createControlPlaneApp>; dataDir: string }> = [];

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
  const app = createControlPlaneApp({ dataDir, passwordFile });
  cases.push({ app, dataDir });
  return app;
}

async function ownerCookie(app: ReturnType<typeof createControlPlaneApp>): Promise<string> {
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  expect(login.status).toBe(204);
  return login.headers.get("set-cookie")!.split(";", 1)[0]!;
}

it("lets the owner create and list a public channel through the control-plane API", async () => {
  const app = setup();
  const anonymous = await app.request("/api/owner/channels");
  const cookie = await ownerCookie(app);

  expect(anonymous.status).toBe(401);

  const createdResponse = await app.request("/api/owner/channels", {
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

  const listResponse = await app.request("/api/owner/channels", { headers: { cookie } });
  expect(listResponse.status).toBe(200);
  expect(await listResponse.json()).toEqual({ channels: [created] });
});

it("lets the owner update and archive a private channel through the control-plane API", async () => {
  const app = setup();
  const cookie = await ownerCookie(app);
  const createResponse = await app.request("/api/owner/channels", {
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

  const updateResponse = await app.request(`/api/owner/channels/${created.id}`, {
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

  const listResponse = await app.request("/api/owner/channels", { headers: { cookie } });
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
