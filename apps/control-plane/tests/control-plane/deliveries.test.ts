import Database from "better-sqlite3";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/http.js";
import { OwnerChat } from "../../src/conversations/service.js";

const password = "owner-password-used-only-by-this-test";
const cases: Array<{ app: ReturnType<typeof createControlPlaneApp>; dataDir: string }> = [];
const syntheticAgent = "fixture-agent-with-channel-membership";

afterEach(() => {
  for (const { app, dataDir } of cases.splice(0)) {
    app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "mate-owner-deliveries-"));
  chmodSync(dataDir, 0o700);
  const passwordFile = join(dataDir, "owner-password");
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  const app = createControlPlaneApp({ dataDir, passwordFile });
  cases.push({ app, dataDir });
  return { app, dataDir };
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

async function createChannel(app: ReturnType<typeof createControlPlaneApp>, cookie: string) {
  const response = await app.request("/api/owner/channels", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "投递验证", description: "", visibility: "private" }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string }>;
}

function addSyntheticMember(dataDir: string, channelId: string): void {
  // Test fixture only: #73 exposes no Agent membership management HTTP endpoint.
  const db = new Database(join(dataDir, "control-plane.sqlite"));
  db.pragma("foreign_keys = ON");
  db.prepare(
    "INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at) VALUES(?,'agent',?,1,?)",
  ).run(channelId, syntheticAgent, Date.now());
  db.close();
}

function pendingDeliveries(dataDir: string) {
  const db = new Database(join(dataDir, "control-plane.sqlite"));
  try {
    return new OwnerChat(db).listPendingDeliveries("agent", syntheticAgent).deliveries;
  } finally {
    db.close();
  }
}

function pendingOwnerDeliveries(dataDir: string) {
  const db = new Database(join(dataDir, "control-plane.sqlite"));
  try {
    return new OwnerChat(db).listPendingDeliveries("human", "owner").deliveries;
  } finally {
    db.close();
  }
}

it("persists one delivery per member in the message transaction and resumes the same pending ID", async () => {
  const fixture = setup();
  const cookie = await ownerCookie(fixture.app);
  const channel = await createChannel(fixture.app, cookie);
  addSyntheticMember(fixture.dataDir, channel.id);

  const response = await fixture.app.request(`/api/owner/channels/${channel.id}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "等待成员处理" }),
  });
  const message = await response.json();
  expect(response.status).toBe(201);
  expect(message.author).toEqual({ kind: "human", id: "owner" });

  fixture.app.close();
  const restarted = createControlPlaneApp({
    dataDir: fixture.dataDir,
    passwordFile: join(fixture.dataDir, "owner-password"),
  });
  cases.push({ app: restarted, dataDir: fixture.dataDir });

  const firstRead = pendingDeliveries(fixture.dataDir);
  const retryRead = pendingDeliveries(fixture.dataDir);
  expect(firstRead).toHaveLength(1);
  expect(pendingOwnerDeliveries(fixture.dataDir)).toEqual([]);
  expect(firstRead[0]).toMatchObject({
    messageId: message.id,
    channelId: channel.id,
    recipient: { kind: "agent", id: syntheticAgent },
    state: "pending",
    message: { text: "等待成员处理", order: "1" },
  });
  expect(retryRead).toEqual(firstRead);

  const db = new Database(join(fixture.dataDir, "control-plane.sqlite"));
  try {
    const chat = new OwnerChat(db);
    expect(chat.acknowledgeDelivery(firstRead[0]!.id, "agent", syntheticAgent)).toBe(true);
    expect(chat.acknowledgeDelivery(firstRead[0]!.id, "agent", syntheticAgent)).toBe(false);
    expect(chat.listPendingDeliveries("agent", syntheticAgent).deliveries).toEqual([]);
  } finally {
    db.close();
  }
});

it("does not backfill a message to an Agent who joins after that message", async () => {
  const fixture = setup();
  const cookie = await ownerCookie(fixture.app);
  const channel = await createChannel(fixture.app, cookie);
  const earlier = await fixture.app.request(`/api/owner/channels/${channel.id}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "加入前的消息" }),
  });
  const earlierMessage = await earlier.json();
  addSyntheticMember(fixture.dataDir, channel.id);
  expect(pendingDeliveries(fixture.dataDir)).toEqual([]);

  const later = await fixture.app.request(`/api/owner/channels/${channel.id}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "加入后的消息" }),
  });
  const laterMessage = await later.json();

  expect(later.status).toBe(201);
  expect(earlier.status).toBe(201);
  expect(pendingDeliveries(fixture.dataDir)).toMatchObject([
    { messageId: laterMessage.id, message: { text: "加入后的消息" } },
  ]);
  expect(
    pendingDeliveries(fixture.dataDir).some(({ messageId }) => messageId === earlierMessage.id),
  ).toBe(false);
});

it("rolls back both the message and its delivery if durable delivery persistence fails", async () => {
  const fixture = setup();
  const cookie = await ownerCookie(fixture.app);
  const channel = await createChannel(fixture.app, cookie);
  addSyntheticMember(fixture.dataDir, channel.id);
  const db = new Database(join(fixture.dataDir, "control-plane.sqlite"));
  db.exec(`
    CREATE TRIGGER fail_delivery_fixture
    BEFORE INSERT ON owner_message_deliveries
    BEGIN
      SELECT RAISE(ABORT, 'fixture delivery persistence failure');
    END;
  `);
  db.close();

  const response = await fixture.app.request(`/api/owner/channels/${channel.id}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "不能留下半次提交" }),
  });
  expect(response.status).toBe(500);
  const history = await fixture.app.request(`/api/owner/channels/${channel.id}/messages`, {
    headers: { cookie },
  });
  expect(await history.json()).toEqual({ messages: [], nextBefore: null });
  expect(pendingDeliveries(fixture.dataDir)).toEqual([]);
});
