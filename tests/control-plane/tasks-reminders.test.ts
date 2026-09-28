import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/control-plane/http.js";
const fixtures: Array<{ app: ReturnType<typeof createControlPlaneApp>; dir: string }> = [];
afterEach(() => {
  for (const { app, dir } of fixtures.splice(0)) {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mate-task-reminder-"));
  chmodSync(dir, 0o700);
  const passwordFile = join(dir, "password");
  writeFileSync(passwordFile, "test-password\n", { mode: 0o600 });
  const app = createControlPlaneApp({ dataDir: dir, passwordFile, now: () => 1_000 });
  fixtures.push({ app, dir });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
  const channelResponse = await app.request("/api/owner/channels", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "工作", description: "", visibility: "public" }),
  });
  const channel = await channelResponse.json();
  return { app, dir, passwordFile, cookie, channel };
}

it("commits a task with its new message and keeps the message as its unique anchor across restart", async () => {
  const f = await setup();
  const response = await f.app.request(`/api/owner/channels/${f.channel.id}/messages`, {
    method: "POST",
    headers: { cookie: f.cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "整理方案", asTask: true }),
  });
  expect(response.status).toBe(201);
  const message = await response.json();
  const first = await f.app.request("/api/owner/tasks", { headers: { cookie: f.cookie } });
  expect(await first.json()).toMatchObject({
    tasks: [
      expect.objectContaining({
        messageId: message.id,
        channelId: f.channel.id,
        title: "整理方案",
        status: "open",
      }),
    ],
  });
  f.app.close();
  const restarted = createControlPlaneApp({
    dataDir: f.dir,
    passwordFile: f.passwordFile,
    now: () => 1_000,
  });
  fixtures.push({ app: restarted, dir: f.dir });
  const after = await restarted.request("/api/owner/tasks", { headers: { cookie: f.cookie } });
  expect(await after.json()).toMatchObject({
    tasks: [expect.objectContaining({ messageId: message.id, channelId: f.channel.id })],
  });
});

it("creates a task from an existing message once without changing conversation access", async () => {
  const f = await setup();
  const sent = await f.app.request(`/api/owner/channels/${f.channel.id}/messages`, {
    method: "POST",
    headers: { cookie: f.cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "先调查" }),
  });
  const message = await sent.json();
  const create = () =>
    f.app.request("/api/owner/tasks", {
      method: "POST",
      headers: { cookie: f.cookie, "content-type": "application/json" },
      body: JSON.stringify({ messageId: message.id }),
    });
  expect((await create()).status).toBe(201);
  expect((await create()).status).toBe(409);
});

it("rolls back a new message and its deliveries if task creation cannot commit", async () => {
  const f = await setup();
  const db = new Database(join(f.dir, "control-plane.sqlite"));
  db.exec(`CREATE TRIGGER refuse_task BEFORE INSERT ON owner_tasks
    BEGIN SELECT RAISE(ABORT,'synthetic task failure'); END;`);
  const response = await f.app.request(`/api/owner/channels/${f.channel.id}/messages`, {
    method: "POST",
    headers: { cookie: f.cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "This cannot become a task", asTask: true }),
  });
  expect(response.status).toBe(500);
  expect(
    db.prepare("SELECT count(*) AS n FROM owner_messages WHERE channel_id=?").get(f.channel.id),
  ).toEqual({ n: 0 });
  expect(db.prepare("SELECT count(*) AS n FROM owner_tasks").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT count(*) AS n FROM owner_message_deliveries").get()).toEqual({ n: 0 });
  db.close();
});
