import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { OwnerPush } from "../../src/owner-push.js";
import { createControlPlaneApp, mentionsOwner } from "../../src/http.js";
import { controlPlaneSchema } from "../../src/schema.js";
import { openControlPlaneDatabase } from "../../src/storage/initialize.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tempDatabasePath(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "mate-push-"));
  return { directory, path: join(directory, "control-plane.sqlite") };
}

function schemaObjects(database: Database.Database): unknown[] {
  return database
    .prepare(
      "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
}

it("recognizes owner mentions beside punctuation without treating email or longer names as mentions", () => {
  expect(mentionsOwner("请看(@所有者)和 @owner！")).toBe(true);
  expect(mentionsOwner("提醒：@所有者，看一下这条消息")).toBe(true);
  expect(mentionsOwner("请联系 a@owner.example 和 @所有者们")).toBe(false);
});

it("retries a temporary Push failure after durable backoff without duplicating the event", async () => {
  const { directory, path } = tempDatabasePath();
  let db = openControlPlaneDatabase(path, controlPlaneSchema);
  let now = 1_000;
  const sent: string[] = [];
  const sender = async (_subscription: { endpoint: string }, payload: { url: string }) => {
    sent.push(payload.url);
    if (sent.length === 1) throw new Error("push unavailable");
  };
  let push = new OwnerPush(db, sender, () => now);
  try {
    push.subscribe({
      endpoint: "https://push.example.test/send/1",
      keys: { p256dh: "key", auth: "auth" },
    });
    db.transaction(() => {
      push.queue("message:message-1", "Agent 发来消息", "/app?channel=room-1&message=message-1");
      push.queue("message:message-1", "Agent 发来消息", "/app?channel=room-1&message=message-1");
    })();
    await push.deliver();
    await push.deliver();
    expect(sent).toEqual(["/app?channel=room-1&message=message-1"]);
    push.close();
    db.close();
    db = openControlPlaneDatabase(path, controlPlaneSchema);
    push = new OwnerPush(db, sender, () => now);
    now += 5_000;
    await push.deliver();
    expect(sent).toEqual([
      "/app?channel=room-1&message=message-1",
      "/app?channel=room-1&message=message-1",
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM owner_push_events").get()).toEqual({
      count: 1,
    });
  } finally {
    push.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("drops a permanently gone Push endpoint without retrying it", async () => {
  const { directory, path } = tempDatabasePath();
  const db = openControlPlaneDatabase(path, controlPlaneSchema);
  let now = 1_000;
  const sent: string[] = [];
  const push = new OwnerPush(
    db,
    async (subscription) => {
      sent.push(subscription.endpoint);
      throw { statusCode: 410 };
    },
    () => now,
  );
  try {
    push.subscribe({
      endpoint: "https://push.example.test/gone",
      keys: { p256dh: "key", auth: "auth" },
    });
    db.transaction(() => push.queue("message:1", "消息", "/app?channel=room-1&message=1"))();
    await push.deliver();
    now += 100_000;
    await push.deliver();
    expect(sent).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM owner_push_subscriptions").get()).toEqual({
      count: 0,
    });
  } finally {
    push.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("writes to the unified schema without creating or altering the tables it uses", () => {
  const { directory, path } = tempDatabasePath();
  const db = openControlPlaneDatabase(path, controlPlaneSchema);
  try {
    const before = schemaObjects(db);
    const push = new OwnerPush(
      db,
      async () => undefined,
      () => 1_000,
    );
    push.close();
    expect(schemaObjects(db)).toEqual(before);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("refuses a database the unified schema did not initialize", () => {
  const db = new Database(":memory:");
  try {
    expect(
      () =>
        new OwnerPush(
          db,
          async () => undefined,
          () => 1_000,
        ),
    ).toThrow(/no such table/);
  } finally {
    db.close();
  }
});

it("requires owner login for subscription and exposes a usable Push public key", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mate-push-api-"));
  const app = createControlPlaneApp({ dataDir });
  try {
    expect((await app.request("/api/owner/push/public-key")).status).toBe(401);
    expect(
      (await app.request("/api/owner/push/subscriptions", { method: "POST", body: "{}" })).status,
    ).toBe(401);
    expect(app.push.publicKey).toMatch(/^[\w-]+$/);
  } finally {
    app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
