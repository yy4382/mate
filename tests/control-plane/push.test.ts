import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { OwnerPush } from "../../src/control-plane/owner-push.js";
import { createControlPlaneApp } from "../../src/control-plane/http.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

it("retries a temporary Push failure after durable backoff without duplicating the approval event", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-push-retry-"));
  const path = join(directory, "push.sqlite");
  let db = new Database(path);
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
      push.queue("approval:request-1", "审批请求", "/app?channel=room-1&approval=request-1");
      push.queue("approval:request-1", "审批请求", "/app?channel=room-1&approval=request-1");
    })();
    await push.deliver();
    await push.deliver();
    expect(sent).toEqual(["/app?channel=room-1&approval=request-1"]);
    push.close();
    db.close();
    db = new Database(path);
    push = new OwnerPush(db, sender, () => now);
    now += 5_000;
    await push.deliver();
    expect(sent).toEqual([
      "/app?channel=room-1&approval=request-1",
      "/app?channel=room-1&approval=request-1",
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
  const db = new Database(":memory:");
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
  }
});

it("requires owner login for subscription and enqueues an approval only on its first creation", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mate-push-api-"));
  const app = createControlPlaneApp({ dataDir });
  try {
    expect((await app.request("/api/owner/push/public-key")).status).toBe(401);
    expect(
      (await app.request("/api/owner/push/subscriptions", { method: "POST", body: "{}" })).status,
    ).toBe(401);
    const request = {
      requestId: randomUUID(),
      agentId: randomUUID(),
      nodeId: randomUUID(),
      channelId: randomUUID(),
      program: "/usr/bin/id",
      args: [],
      cwd: "/tmp",
    };
    const seed = new Database(join(dataDir, "control-plane.sqlite"));
    try {
      seed
        .prepare("INSERT INTO nodes(id,public_key,paired_at) VALUES(?,?,?)")
        .run(request.nodeId, "synthetic-node-key", 1);
      seed
        .prepare(
          `INSERT INTO owner_agents(
        id,node_id,name,role,description,provider,model_id,request_json,request_hash,
        provision_request_id,status,stage,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          request.agentId,
          request.nodeId,
          "Synthetic Agent",
          "helper",
          "",
          "openai",
          "test-model",
          "{}",
          "0".repeat(64),
          randomUUID(),
          "waiting_credentials",
          "complete",
          1,
          1,
        );
    } finally {
      seed.close();
    }
    app.approvals.request(request);
    app.approvals.request(request);
    expect(app.push.publicKey).toMatch(/^[\w-]+$/);
    const audit = new Database(join(dataDir, "control-plane.sqlite"), { readonly: true });
    try {
      expect(audit.prepare("SELECT event_key,url FROM owner_push_events").all()).toEqual([
        {
          event_key: `approval:${request.requestId}`,
          url: `/app?channel=${request.channelId}&approval=${request.requestId}`,
        },
      ]);
    } finally {
      audit.close();
    }
    expect(app.approvals.status(request.requestId)?.state).toBe("pending");
  } finally {
    app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
