import type Database from "better-sqlite3";
import webpush, { type PushSubscription } from "web-push";

interface PushPayload {
  title: string;
  url: string;
  tag: string;
}

type Sender = (subscription: PushSubscription, payload: PushPayload) => Promise<unknown>;

interface DeliveryRow {
  event_key: string;
  endpoint: string;
  subscription_json: string;
  title: string;
  url: string;
}

/**
 * A durable, best-effort notification outbox. Domain transactions enqueue; HTTP delivery never runs in
 * them. The four `owner_push_*` tables are part of the control-plane format (see `push-schema.ts`), so
 * this service never creates or extends them: it only writes to the structure startup already built.
 */
export class OwnerPush {
  private readonly keys: { publicKey: string; privateKey: string };
  private readonly timer: NodeJS.Timeout;
  private delivering = false;
  private closed = false;
  private lastPruned = 0;

  constructor(
    private readonly db: Database.Database,
    private readonly sender: Sender = async (subscription, payload) => {
      await webpush.sendNotification(subscription, JSON.stringify(payload), {
        vapidDetails: {
          subject: process.env.MATE_PUBLIC_ORIGIN ?? "mailto:owner@mate.invalid",
          publicKey: this.keys.publicKey,
          privateKey: this.keys.privateKey,
        },
        TTL: 3600,
        timeout: 10_000,
      });
    },
    private readonly now: () => number = Date.now,
  ) {
    // Requeue deliveries an earlier release left failed so they are retried instead of stranded.
    // This release writes only 'pending' and 'sent'; the tables and retry columns come from the
    // control-plane format, which this service does not create or extend.
    db.prepare("UPDATE owner_push_deliveries SET state='pending' WHERE state='failed'").run();
    let keys = db.prepare("SELECT public_key,private_key FROM owner_push_keys WHERE id=1").get() as
      { public_key: string; private_key: string } | undefined;
    if (!keys) {
      const generated = webpush.generateVAPIDKeys();
      db.prepare(
        "INSERT OR IGNORE INTO owner_push_keys(id,public_key,private_key) VALUES(1,?,?)",
      ).run(generated.publicKey, generated.privateKey);
      keys = db
        .prepare("SELECT public_key,private_key FROM owner_push_keys WHERE id=1")
        .get() as typeof keys;
    }
    this.keys = { publicKey: keys!.public_key, privateKey: keys!.private_key };
    this.timer = setInterval(() => void this.deliver().catch(() => undefined), 5000);
    this.timer.unref();
  }

  get publicKey(): string {
    return this.keys.publicKey;
  }

  subscribe(subscription: PushSubscription): void {
    const endpoint = new URL(subscription.endpoint);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      !endpoint.hostname.includes(".") ||
      subscription.endpoint.length > 4096 ||
      !subscription.keys?.p256dh ||
      !subscription.keys.auth ||
      subscription.keys.p256dh.length > 256 ||
      subscription.keys.auth.length > 256
    )
      throw new Error("Invalid push subscription");
    this.db
      .prepare(
        `INSERT INTO owner_push_subscriptions(endpoint,subscription_json,created_at)
      VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET subscription_json=excluded.subscription_json`,
      )
      .run(subscription.endpoint, JSON.stringify(subscription), this.now());
  }

  unsubscribe(endpoint: string): void {
    this.db.prepare("DELETE FROM owner_push_subscriptions WHERE endpoint=?").run(endpoint);
    this.db
      .prepare("DELETE FROM owner_push_deliveries WHERE endpoint=? AND state='pending'")
      .run(endpoint);
  }

  /** Must be called inside the transaction that creates the message it points at. */
  queue(key: string, title: string, url: string): void {
    if (!this.db.inTransaction) throw new Error("Push enqueue requires the fact transaction");
    if (!url.startsWith("/app?") || url.length > 2048) throw new Error("Invalid push target");
    const now = this.now();
    const inserted = this.db
      .prepare(
        "INSERT OR IGNORE INTO owner_push_events(event_key,title,url,created_at) VALUES(?,?,?,?)",
      )
      .run(key, title, url, now);
    if (!inserted.changes) return;
    this.db
      .prepare(
        `INSERT INTO owner_push_deliveries(event_key,endpoint,state,updated_at)
      SELECT ?,endpoint,'pending',? FROM owner_push_subscriptions`,
      )
      .run(key, now);
  }

  async deliver(): Promise<void> {
    if (this.delivering || this.closed) return;
    this.delivering = true;
    try {
      if (this.now() - this.lastPruned > 3_600_000) {
        const now = this.now();
        this.db
          .prepare("DELETE FROM owner_push_deliveries WHERE updated_at<?")
          .run(now - 7 * 86_400_000);
        this.db
          .prepare(
            `DELETE FROM owner_push_events WHERE created_at<? AND NOT EXISTS (
          SELECT 1 FROM owner_push_deliveries d WHERE d.event_key=owner_push_events.event_key
        )`,
          )
          .run(now - 7 * 86_400_000);
        this.lastPruned = now;
      }
      const rows = this.db
        .prepare(
          `SELECT d.event_key,d.endpoint,s.subscription_json,e.title,e.url
        FROM owner_push_deliveries d JOIN owner_push_events e ON e.event_key=d.event_key
        JOIN owner_push_subscriptions s ON s.endpoint=d.endpoint
        WHERE d.state='pending' AND d.next_attempt_at<=? ORDER BY e.created_at,d.event_key LIMIT 50`,
        )
        .all(this.now()) as DeliveryRow[];
      for (const row of rows) {
        if (this.closed) break;
        try {
          await this.sender(JSON.parse(row.subscription_json) as PushSubscription, {
            title: row.title,
            url: row.url,
            tag: row.event_key,
          });
          if (!this.closed)
            this.db
              .prepare(
                "UPDATE owner_push_deliveries SET state='sent',updated_at=? WHERE event_key=? AND endpoint=? AND state='pending'",
              )
              .run(this.now(), row.event_key, row.endpoint);
        } catch (error) {
          if (
            !this.closed &&
            error &&
            typeof error === "object" &&
            "statusCode" in error &&
            (error.statusCode === 404 || error.statusCode === 410)
          ) {
            this.unsubscribe(row.endpoint);
            continue;
          }
          if (this.closed) break;
          this.db
            .prepare(
              `UPDATE owner_push_deliveries SET attempts=attempts+1,
              next_attempt_at=? + MIN(3600000,5000 * (1 << MIN(attempts,10))),updated_at=?
              WHERE event_key=? AND endpoint=? AND state='pending'`,
            )
            .run(this.now(), this.now(), row.event_key, row.endpoint);
        }
      }
    } finally {
      this.delivering = false;
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
  }
}
