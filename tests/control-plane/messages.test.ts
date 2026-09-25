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
  const dataDir = mkdtempSync(join(tmpdir(), "mate-owner-messages-"));
  chmodSync(dataDir, 0o700);
  const passwordFile = join(dataDir, "owner-password");
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  const app = createControlPlaneApp({ dataDir, passwordFile });
  cases.push({ app, dataDir });
  return { app, dataDir, passwordFile };
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

it("persists top-level messages with Mate identity, revision and channel order", async () => {
  const fixture = setup();
  const cookie = await ownerCookie(fixture.app);
  const channelResponse = await fixture.app.request("/api/owner/channels", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "日常", description: "", visibility: "public" }),
  });
  const channel = await channelResponse.json();

  expect(channelResponse.status).toBe(201);

  async function send(text: string) {
    const response = await fixture.app.request(`/api/owner/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    expect(response.status).toBe(201);
    return response.json();
  }

  const first = await send("先确认安排"),
    second = await send("下午三点再同步");

  expect(first).toMatchObject({
    channelId: channel.id,
    rootId: null,
    author: { kind: "human", id: "owner" },
    text: "先确认安排",
    order: "1",
    revision: "1",
  });
  expect(first.id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(second).toMatchObject({ text: "下午三点再同步", order: "2", revision: "1" });
  expect(second.id).not.toBe(first.id);

  fixture.app.close();
  const restarted = createControlPlaneApp({
    dataDir: fixture.dataDir,
    passwordFile: fixture.passwordFile,
  });
  cases.push({ app: restarted, dataDir: fixture.dataDir });
  const history = await restarted.request(`/api/owner/channels/${channel.id}/messages`, {
    headers: { cookie },
  });

  expect(history.status).toBe(200);
  expect(await history.json()).toEqual({ messages: [first, second], nextBefore: null });
});

it("pages back to older top-level messages using the channel order cursor", async () => {
  const { app } = setup();
  const cookie = await ownerCookie(app);
  const channelResponse = await app.request("/api/owner/channels", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "历史", description: "", visibility: "public" }),
  });
  const channel = await channelResponse.json();

  for (let index = 1; index <= 51; index++) {
    const response = await app.request(`/api/owner/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: `第 ${index} 条` }),
    });
    expect(response.status).toBe(201);
  }

  const latest = await app.request(`/api/owner/channels/${channel.id}/messages`, {
    headers: { cookie },
  });
  const latestPage = await latest.json();
  expect(latestPage.messages).toHaveLength(50);
  expect(latestPage.messages[0]).toMatchObject({ text: "第 2 条", order: "2" });
  expect(latestPage.messages.at(-1)).toMatchObject({ text: "第 51 条", order: "51" });
  expect(latestPage.nextBefore).toBe("2");

  const older = await app.request(
    `/api/owner/channels/${channel.id}/messages?before=${latestPage.nextBefore}&limit=50`,
    { headers: { cookie } },
  );
  expect(await older.json()).toMatchObject({
    messages: [expect.objectContaining({ text: "第 1 条", order: "1" })],
    nextBefore: null,
  });
});
