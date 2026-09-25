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
  const dataDir = mkdtempSync(join(tmpdir(), "mate-owner-events-"));
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

async function readEvent(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  let timeout: ReturnType<typeof setTimeout>;
  const chunk = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("SSE event timed out")), 3000);
    }),
  ]);
  clearTimeout(timeout!);
  expect(chunk.done).toBe(false);
  const text = new TextDecoder().decode(chunk.value);
  await reader.cancel();
  return text;
}

it("replays committed events after a restart and fills a disconnect gap by event ID", async () => {
  const fixture = setup();
  let app = fixture.app;
  const cookie = await ownerCookie(app);
  const channelResponse = await app.request("/api/owner/channels", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "交接", description: "", visibility: "public" }),
  });
  const channel = await channelResponse.json();
  const snapshotResponse = await app.request("/api/owner/snapshot", { headers: { cookie } });
  const snapshot = await snapshotResponse.json();

  expect(snapshotResponse.status).toBe(200);
  expect(snapshot.channels[0].id).toBe(channel.id);

  const firstResponse = await app.request(`/api/owner/channels/${channel.id}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "控制面已提交" }),
  });
  const firstMessage = await firstResponse.json();
  app.close();
  app = createControlPlaneApp({ dataDir: fixture.dataDir, passwordFile: fixture.passwordFile });
  cases.push({ app, dataDir: fixture.dataDir });

  const replay = await app.request("/api/owner/events", {
    headers: { cookie, "last-event-id": String(snapshot.cursor) },
  });
  expect(replay.status).toBe(200);
  expect(replay.headers.get("content-type")).toContain("text/event-stream");
  const firstEvent = await readEvent(replay);
  const firstEventId = firstEvent.match(/^id: (\d+)$/m)?.[1];
  expect(firstEvent).toContain("event: message.created");
  expect(firstEvent).toContain(firstMessage.id);
  expect(Number(firstEventId)).toBeGreaterThan(snapshot.cursor);

  await app.request(`/api/owner/channels/${channel.id}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "断开期间发出" }),
  });
  const reconnect = await app.request("/api/owner/events", {
    headers: { cookie, "last-event-id": firstEventId! },
  });
  const secondEvent = await readEvent(reconnect);
  expect(secondEvent).toContain("event: message.created");
  expect(secondEvent).toContain("断开期间发出");
  expect(Number(secondEvent.match(/^id: (\d+)$/m)?.[1])).toBe(Number(firstEventId) + 1);
});

it("tells a client with an expired event cursor to fetch a fresh snapshot", async () => {
  const { app } = setup();
  const cookie = await ownerCookie(app);
  const channelResponse = await app.request("/api/owner/channels", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "大量消息", description: "", visibility: "public" }),
  });
  const channel = await channelResponse.json();

  for (let index = 0; index < 1000; index++) {
    const response = await app.request(`/api/owner/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: `消息 ${index}` }),
    });
    expect(response.status).toBe(201);
  }

  const stale = await app.request("/api/owner/events", {
    headers: { cookie, "last-event-id": "0" },
  });
  const notice = await readEvent(stale);

  expect(stale.status).toBe(200);
  expect(notice).toContain("event: snapshot_required");
  expect(notice).toContain('"reason":"cursor_too_old"');
  expect(notice).toContain('"snapshotUrl":"/api/owner/snapshot"');
});
