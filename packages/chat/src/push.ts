import type { Clock } from "@mate/clock";
import { z } from "zod";
import type { Actor } from "./accounts.ts";
import {
  ConversationKind,
  PushSubscription,
  type PushAddress,
  type TimelineRef,
} from "./contracts.ts";
import { SqlBoolean, type ChatDatabase } from "./database.ts";
import { Id } from "./identifiers.ts";
import { timelineRefOf } from "./timelines.ts";

/**
 * What a push carries: who wrote where, and where to open it, but never the message body. `tag` is the same for every
 * delivery of one message, so a delivery that is repeated replaces the notification instead of adding a second one.
 */
export type PushNotice = {
  accountId: number;
  tag: string;
  messageId: number;
  conversationId: number;
  timeline: TimelineRef;
  seq: number;
  kind: z.output<typeof ConversationKind>;
  /** The channel's name; null for a DM. */
  name: string | null;
  /** Handle of the message's author. */
  sender: string;
  /** Whether the message mentions the subscription's account; a DM to it may not. */
  mentioned: boolean;
  /** When the message was sent, so a late delivery can say so and the sender can bound the push's lifetime. */
  at: number;
};

/**
 * What one delivery attempt means for the queue: delivered; the subscription is gone for good, so it is removed with
 * its queued pushes; worth retrying later; or refused, so this push is dropped and the subscription kept.
 */
export type PushOutcome = "delivered" | "gone" | "retry" | "refused";

/**
 * Hands one notice to the push service for one subscription and resolves with what the service's answer means for the
 * queue, or rejects when the service could not be reached, which the queue retries. The caller supplies it and reads
 * its transport's answers (the Web shell: Web Push statuses and APNs reasons). It must settle within a bounded time,
 * such as a request timeout: the queue waits for each delivery.
 */
export type PushSender = (
  subscription: PushSubscription,
  notice: PushNotice,
) => Promise<PushOutcome>;

/** The wait after the first failed attempt. Each later failure doubles it. */
const FIRST_RETRY_MS = 30_000;
/** A push whose delivery failed this many times in a row is dropped. */
const MAX_FAILURES = 10;

/**
 * Refresh a transport address or give it to this human. Changing its owner or native binding drops its old queue.
 */
export function subscribePush(
  db: ChatDatabase,
  human: Actor,
  subscription: PushSubscription,
): void {
  const key = subscriptionKey(subscription);
  const json = JSON.stringify(subscription);
  // A new owner or native binding gets a new ID, so a late answer cannot remove its subscription.
  db.run(
    `DELETE FROM push_subscriptions WHERE subscription_key = ? AND
      (account_id != ? OR json_extract(subscription_json, '$.binding') IS NOT ?)`,
    key,
    human.id,
    bindingOf(subscription),
  );
  db.run(
    `INSERT INTO push_subscriptions (account_id, subscription_key, subscription_json) VALUES (?, ?, ?)
     ON CONFLICT (subscription_key) DO UPDATE SET subscription_json = excluded.subscription_json`,
    human.id,
    key,
    json,
  );
}

/** A native registration's binding; a browser subscription has none, which SQL compares as NULL. */
const bindingOf = (address: PushAddress) => (address.transport === "apns" ? address.binding : null);

function subscriptionKey(address: PushAddress): string {
  return address.transport === "apns"
    ? JSON.stringify(["apns", address.environment, address.token])
    : JSON.stringify(["web", address.endpoint]);
}

/** Remove this human's own subscription at the address; a native one only under the same binding. */
export function unsubscribePush(db: ChatDatabase, human: Actor, address: PushAddress): void {
  const key = subscriptionKey(address);
  db.run(
    `DELETE FROM push_subscriptions WHERE subscription_key = ? AND account_id = ?
      AND json_extract(subscription_json, '$.binding') IS ?`,
    key,
    human.id,
    bindingOf(address),
  );
}

/**
 * Queue, in the transaction that appended them, a push to each subscription of an active human for each of that
 * human's inbox events after `mark` whose message is a DM to the human or mentions the human. Pushing only what
 * notifies the human keeps one definition of who is notified (`followed_timelines`); the author is never notified, so
 * a human's own messages never push. Returns how many deliveries were queued.
 */
export function enqueuePushes(db: ChatDatabase, mark: number): number {
  return db.run(
    `INSERT INTO push_deliveries (entry_id, subscription_id, due_at)
     SELECT ev.entry_id, s.id, ? FROM inbox_events ev
     JOIN accounts o ON o.id = ev.account_id AND o.kind = 'human' AND o.active = 1
     JOIN entries e ON e.id = ev.entry_id
     JOIN timelines t ON t.id = e.timeline_id
     JOIN conversations c ON c.id = t.conversation_id
     JOIN push_subscriptions s ON s.account_id = o.id
     WHERE ev.id > ? AND (o.id IN (c.dm_low, c.dm_high)
       OR EXISTS (SELECT 1 FROM mentions m WHERE m.entry_id = e.id AND m.account_id = o.id))`,
    db.now(),
    mark,
  );
}

const DueRow = z.object({
  entry_id: Id,
  subscription_id: Id,
  failures: z.number(),
  due_at: z.number(),
  account_id: Id,
  subscription_json: z.string(),
  active: SqlBoolean,
  seq: z.number(),
  created_at: z.number(),
  conversation_id: Id,
  root_entry_id: Id.nullable(),
  kind: ConversationKind,
  name: z.string().nullable(),
  sender: z.string(),
  mentioned: SqlBoolean,
});
type DueRow = z.output<typeof DueRow>;

/** The delivery that falls due first, with the notice it sends. */
function nextDelivery(db: ChatDatabase): DueRow | undefined {
  return db.get(
    DueRow,
    `SELECT d.entry_id, d.subscription_id, d.failures, d.due_at, s.account_id, s.subscription_json,
       (SELECT o.active FROM accounts o WHERE o.id = s.account_id) AS active,
       e.seq, e.created_at, t.conversation_id, t.root_entry_id, c.kind, c.name, a.handle AS sender,
       EXISTS (SELECT 1 FROM mentions m
               WHERE m.entry_id = e.id AND m.account_id = s.account_id) AS mentioned
     FROM push_deliveries d
     JOIN push_subscriptions s ON s.id = d.subscription_id
     JOIN entries e ON e.id = d.entry_id
     JOIN timelines t ON t.id = e.timeline_id
     JOIN conversations c ON c.id = t.conversation_id
     JOIN accounts a ON a.id = e.author_id
     ORDER BY d.due_at, d.entry_id, d.subscription_id LIMIT 1`,
  );
}

const subscriptionOf = (row: DueRow): PushSubscription =>
  PushSubscription.parse(JSON.parse(row.subscription_json));

const noticeOf = (row: DueRow): PushNotice => ({
  accountId: row.account_id,
  tag: `message-${row.entry_id}`,
  messageId: row.entry_id,
  conversationId: row.conversation_id,
  timeline: timelineRefOf(row),
  seq: row.seq,
  kind: row.kind,
  name: row.name,
  sender: row.sender,
  mentioned: row.mentioned,
  at: row.created_at,
});

async function attempt(send: PushSender, row: DueRow): Promise<PushOutcome> {
  try {
    return await send(subscriptionOf(row), noticeOf(row));
  } catch {
    return "retry";
  }
}

function settle(db: ChatDatabase, row: DueRow, outcome: PushOutcome): void {
  const key = [row.entry_id, row.subscription_id] as const;
  if (outcome === "gone") {
    db.run("DELETE FROM push_subscriptions WHERE id = ?", row.subscription_id);
  } else if (outcome === "retry" && row.failures + 1 < MAX_FAILURES) {
    db.run(
      "UPDATE push_deliveries SET failures = ?, due_at = ? WHERE entry_id = ? AND subscription_id = ?",
      row.failures + 1,
      db.now() + FIRST_RETRY_MS * 2 ** row.failures,
      ...key,
    );
  } else {
    db.run("DELETE FROM push_deliveries WHERE entry_id = ? AND subscription_id = ?", ...key);
  }
}

/**
 * Delivers the push queue, one delivery at a time, in the order they fall due. Everything it knows is in the queue,
 * so a restart picks up each retry where it was scheduled. A delivery only ever changes the queue and the
 * subscriptions: the message it is about is already committed.
 */
export class PushDelivery {
  readonly #db: ChatDatabase;
  readonly #clock: Clock;
  readonly #send: PushSender;
  #closed = false;
  #wake = new AbortController();

  constructor(db: ChatDatabase, clock: Clock, send: PushSender) {
    this.#db = db;
    this.#clock = clock;
    this.#send = send;
    void this.#deliver();
  }

  /** Look at the queue again: a write has just queued a push. */
  wake(): void {
    this.#wake.abort();
  }

  /** Stop. A delivery in flight is abandoned and stays queued, so the next start sends it again under the same tag. */
  close(): void {
    this.#closed = true;
    this.#wake.abort();
  }

  async #deliver(): Promise<void> {
    while (!this.#closed) {
      try {
        await this.#step();
      } catch (error) {
        // The queue is intact, since a failed transaction changes nothing; try again later rather than stop pushing.
        console.error("chat push delivery failed", error);
        await this.#sleep(FIRST_RETRY_MS);
      }
    }
  }

  /** Send the delivery that is due, or wait until one is. */
  async #step(): Promise<void> {
    const due = this.#db.transaction("read", () => nextDelivery(this.#db));
    if (due === undefined) return this.#sleep(undefined);
    const wait = due.due_at - this.#clock.now();
    if (wait > 0) return this.#sleep(wait);
    if (!due.active) return this.#db.transaction("write", () => settle(this.#db, due, "refused"));
    const outcome = await attempt(this.#send, due);
    if (this.#closed) return;
    this.#db.transaction("write", () => settle(this.#db, due, outcome));
  }

  /** Sleep for `ms` (until woken, without it), or until a write queues a push or the queue closes. */
  #sleep(ms: number | undefined): Promise<void> {
    this.#wake = new AbortController();
    return this.#clock.sleep(ms, this.#wake.signal);
  }
}
