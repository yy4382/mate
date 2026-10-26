import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FakeClock, temporaryDirectory } from "@mate/testkit";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ChatApp, TimelineRef } from "../src/index.ts";
import {
  FakePushService,
  openAppAt,
  refusalReason,
  rid,
  settled,
  subscription,
} from "./support.ts";

const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
/** The documented retry schedule: 30 seconds after the first failure, twice as long after each later one. */
const FIRST_RETRY = 30 * SECOND;
/** A push is dropped after this many failed attempts. */
const ATTEMPTS = 10;

/** An owner subscribed on `devices`, and two Agents, Ada and Bo, on a store a test can reopen. */
function ownerWithAgents(devices: string[] = ["phone"]) {
  const clock = new FakeClock();
  const service = new FakePushService(clock);
  const file = join(temporaryDirectory(), "chat.sqlite");
  const open = () => openAppAt(file, { clock, push: service.send });
  const app = open();
  const owner = app.ensureAccount({
    externalId: "owner",
    displayName: "Owner",
    handle: "owner",
    kind: "human",
  });
  const ada = app.ensureAccount({
    externalId: "ada",
    displayName: "Ada",
    handle: "ada",
    kind: "agent",
  });
  const bo = app.ensureAccount({
    externalId: "bo",
    displayName: "Bo",
    handle: "bo",
    kind: "agent",
  });
  for (const device of devices) app.subscribePush(owner, subscription(device));
  return { app, file, open, clock, service, owner, ada, bo };
}

/** Every unexpected failure the delivery loop reports goes to console.error; a test that expects one clears it. */
let consoleErrors: MockInstance<typeof console.error>;
beforeEach(() => {
  consoleErrors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  expect(consoleErrors, "the push delivery reported no failure").not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

function dm(app: ChatApp, from: number, to: number): TimelineRef {
  return { conversation: app.openDm(from, { requestId: rid(), other: to }).conversationId };
}

/** Send without the freshness check, for setup that is not about who has read what. Returns the sent message. */
function post(
  app: ChatApp,
  from: number,
  timeline: TimelineRef,
  body: string,
  mentions?: number[],
) {
  const result = app.send(from, timeline, {
    requestId: rid(),
    body,
    freshness: false,
    ...(mentions === undefined ? {} : { mentions }),
  });
  if (result.status !== "sent") throw new Error("expected sent");
  return result;
}

describe("3.8 push", () => {
  it("a late invalid-token answer and an old unsubscribe cannot remove a newer native binding", async () => {
    const { app, service, owner, ada } = ownerWithAgents([]);
    const first = {
      transport: "apns",
      token: "ab".repeat(32),
      environment: "sandbox",
      binding: "11111111-1111-4111-8111-111111111111",
    } as const;
    const next = { ...first, binding: "22222222-2222-4222-8222-222222222222" };
    app.subscribePush(owner, first);
    service.answer(first.token, "hang");
    const timeline = dm(app, ada, owner);
    post(app, ada, timeline, "first registration");
    await service.received(1);
    app.subscribePush(owner, next);
    app.unsubscribePush(owner, first);
    service.release(410);
    await settled();
    const sent = post(app, ada, timeline, "new registration");
    await service.received(2);
    expect(service.requests[1]?.subscription).toEqual(next);
    expect(service.requests[1]?.notice.messageId).toBe(sent.messageId);
    app.close();
  });

  it("an Agent's DM to the owner pushes to every subscription, pointing at the message without its body", async () => {
    const { app, clock, service, owner, ada } = ownerWithAgents(["phone", "laptop"]);
    const timeline = dm(app, ada, owner);
    const sentAt = clock.now();
    const sent = post(app, ada, timeline, "the secret plan");
    await service.received(2);

    expect(service.endpoints().sort(), "one push per subscription").toEqual(
      [subscription("laptop").endpoint, subscription("phone").endpoint].sort(),
    );
    for (const { notice } of service.requests) {
      expect(notice, "where the message is, and who wrote it").toEqual({
        accountId: owner,
        tag: expect.any(String),
        messageId: sent.messageId,
        conversationId: sent.conversationId,
        timeline,
        seq: sent.seq,
        kind: "dm",
        name: null,
        sender: "ada",
        mentioned: false,
        at: sentAt,
      });
      expect(JSON.stringify(notice), "no message body").not.toContain("secret");
    }
    app.close();
  });

  it("a message that mentions the owner pushes, at the top of a channel and in a thread", async () => {
    const { app, service, owner, ada } = ownerWithAgents();
    const general = app.createChannel(owner, {
      requestId: rid(),
      name: "general",
      visibility: "public",
    });
    app.join(ada, { requestId: rid(), conversationId: general.conversationId });
    const top = { conversation: general.conversationId };

    const mention = post(app, ada, top, "@owner please look", [owner]);
    await service.received(1);
    const root = post(app, owner, top, "plan");
    const thread = { thread: root.messageId };
    post(app, ada, thread, "a reply without a mention");
    const reply = post(app, ada, thread, "@owner done", [owner]);
    await service.received(2);
    await settled();

    expect(service.requests.map((request) => request.notice)).toEqual([
      expect.objectContaining({
        messageId: mention.messageId,
        timeline: top,
        kind: "public",
        name: "general",
        mentioned: true,
      }),
      expect.objectContaining({
        messageId: reply.messageId,
        timeline: thread,
        seq: reply.seq,
        name: "general",
        mentioned: true,
      }),
    ]);
    app.close();
  });

  it("messages that neither DM the owner nor mention it do not push, an '@owner' inside an email address included", async () => {
    const { app, service, owner, ada, bo } = ownerWithAgents();
    const general = app.createChannel(owner, {
      requestId: rid(),
      name: "general",
      visibility: "public",
    });
    for (const agent of [ada, bo])
      app.join(agent, { requestId: rid(), conversationId: general.conversationId });
    const top = { conversation: general.conversationId };

    post(app, ada, top, "write to chris@owner.example");
    post(app, ada, top, "@bo over to you", [bo]);
    post(app, owner, top, "a note to myself, @owner", [owner]);
    post(app, owner, dm(app, owner, ada), "the owner's own DM");
    post(app, ada, dm(app, ada, bo), "a DM between two Agents");
    await settled();
    expect(service.requests, "none of these push").toEqual([]);

    const control = post(app, ada, top, "@owner now you", [owner]);
    await service.received(1);
    expect(service.requests.map((request) => request.notice.messageId)).toEqual([
      control.messageId,
    ]);
    app.close();
  });

  it("a mention of the owner that does not notify it, at the top of a channel it never joined, does not push", async () => {
    const { app, service, owner, ada } = ownerWithAgents();
    const dev = app.createChannel(ada, { requestId: rid(), name: "dev", visibility: "public" });
    const top = { conversation: dev.conversationId };
    post(app, ada, top, "@owner fyi", [owner]);
    await settled();
    expect(app.inboxEvents(owner), "the owner is not notified").toEqual([]);
    expect(service.requests, "so it is not pushed either").toEqual([]);

    app.join(owner, { requestId: rid(), conversationId: dev.conversationId });
    post(app, ada, top, "@owner now you are here", [owner]);
    await service.received(1);
    expect(service.requests).toHaveLength(1);
    app.close();
  });

  it("a held DM to the owner pushes nothing", async () => {
    const { app, service, owner, ada } = ownerWithAgents();
    const timeline = dm(app, ada, owner);
    post(app, owner, timeline, "are you there?");
    const held = app.send(ada, timeline, { requestId: "a1", body: "status update" });
    expect(held.status, "Ada had not read the owner's message").toBe("held");
    await settled();
    expect(service.requests).toEqual([]);

    app.send(ada, timeline, { requestId: "a2", body: "status update" });
    await service.received(1);
    expect(service.requests).toHaveLength(1);
    app.close();
  });

  it("a transient failure is retried 30 seconds later, then after twice as long, and the retries go on after a restart", async () => {
    const { app, open, clock, service, owner, ada } = ownerWithAgents();
    service.answer(subscription("phone").endpoint, "unreachable", 503);
    const start = clock.now();
    post(app, ada, dm(app, ada, owner), "ping");
    await service.received(1);

    clock.advance(FIRST_RETRY - 1);
    await settled();
    expect(service.requests, "not retried before the wait is over").toHaveLength(1);
    clock.advance(1);
    await service.received(2);

    app.close();
    const restarted = open();
    await settled();
    expect(service.requests, "the restart does not retry early").toHaveLength(2);
    clock.advance(2 * FIRST_RETRY - 1);
    await settled();
    expect(service.requests).toHaveLength(2);
    clock.advance(1);
    await service.received(3);

    clock.advance(DAY);
    await settled();
    expect(
      service.requests.map((request) => request.at - start),
      "attempts at 0, 30 and 90 seconds, then delivered",
    ).toEqual([0, FIRST_RETRY, 3 * FIRST_RETRY]);
    restarted.close();
  });

  it("a push waiting for its retry does not hold up a later message's push", async () => {
    const { app, service, owner, ada } = ownerWithAgents();
    service.answer(subscription("phone").endpoint, 503);
    const timeline = dm(app, ada, owner);
    post(app, ada, timeline, "first");
    await service.received(1);
    const second = post(app, ada, timeline, "second");
    await service.received(2);
    expect(service.requests[1]?.notice.messageId, "sent before the first one's retry").toBe(
      second.messageId,
    );
    app.close();
  });

  it("a push in flight when the chat app closes is sent again after the restart, under the same tag, and its late answer is ignored", async () => {
    const { app, open, service, owner, ada } = ownerWithAgents();
    service.answer(subscription("phone").endpoint, "hang");
    post(app, ada, dm(app, ada, owner), "ping");
    await service.received(1);
    app.close();
    service.release(201);
    await settled();

    const restarted = open();
    await service.received(2);
    const [first, again] = service.requests.map((request) => request.notice.tag);
    expect(again, "the resend replaces the notification the first attempt may have shown").toBe(
      first,
    );
    restarted.close();
  });

  it("a storage failure while recording a delivery is reported, and the delivery is tried again later", async () => {
    const { app, file, clock, service, owner, ada } = ownerWithAgents();
    const storage = new DatabaseSync(file);
    storage.exec(`CREATE TRIGGER fail_settle BEFORE DELETE ON push_deliveries
      BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END`);
    post(app, ada, dm(app, ada, owner), "ping");
    await service.received(1);
    expect(consoleErrors, "the failure is reported").toHaveBeenCalled();
    consoleErrors.mockClear();

    storage.exec("DROP TRIGGER fail_settle");
    storage.close();
    clock.advance(FIRST_RETRY);
    await service.received(2);
    clock.advance(DAY);
    await settled();
    expect(service.requests, "delivered once recorded, and not again").toHaveLength(2);
    app.close();
  });

  it("a push that keeps failing is tried ten times, each wait twice the last, and then dropped", async () => {
    const { app, clock, service, owner, ada } = ownerWithAgents();
    service.answer(subscription("phone").endpoint, ...Array<number>(ATTEMPTS + 5).fill(500));
    post(app, ada, dm(app, ada, owner), "ping");
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      await service.received(attempt);
      clock.advance(FIRST_RETRY * 2 ** (attempt - 1));
    }
    clock.advance(30 * DAY);
    await settled();

    const gaps = service.requests.slice(1).map((request, index) => {
      const previous = service.requests[index];
      if (previous === undefined) throw new Error("no previous request");
      return request.at - previous.at;
    });
    expect(gaps).toEqual(
      Array.from({ length: ATTEMPTS - 1 }, (_, index) => FIRST_RETRY * 2 ** index),
    );
    app.close();
  });

  it("a 404 or 410 deletes the subscription: it is not retried and gets no later pushes", async () => {
    const { app, clock, service, owner, ada } = ownerWithAgents(["phone", "tablet", "laptop"]);
    service.answer(subscription("phone").endpoint, 404);
    service.answer(subscription("tablet").endpoint, 410);
    service.answer(subscription("laptop").endpoint, 503);
    const timeline = dm(app, ada, owner);
    post(app, ada, timeline, "first");
    await service.received(3);
    clock.advance(FIRST_RETRY);
    await service.received(4);
    clock.advance(DAY);
    await settled();
    expect(service.endpoints().slice(3), "only the transient failure is retried").toEqual([
      subscription("laptop").endpoint,
    ]);

    post(app, ada, timeline, "second");
    await service.received(5);
    clock.advance(DAY);
    await settled();
    expect(service.endpoints().slice(4), "the deleted subscriptions get nothing").toEqual([
      subscription("laptop").endpoint,
    ]);
    app.close();
  });

  it("any other refusal drops that push but keeps the subscription", async () => {
    const { app, clock, service, owner, ada } = ownerWithAgents();
    service.answer(subscription("phone").endpoint, 400);
    const timeline = dm(app, ada, owner);
    post(app, ada, timeline, "first");
    await service.received(1);
    clock.advance(DAY);
    await settled();
    expect(service.requests, "a refused push is not retried").toHaveLength(1);

    post(app, ada, timeline, "second");
    await service.received(2);
    expect(service.requests).toHaveLength(2);
    app.close();
  });

  it("a failed push leaves the message as it was", async () => {
    const { app, clock, service, owner, ada } = ownerWithAgents(["phone", "laptop"]);
    service.answer(subscription("phone").endpoint, 410);
    service.answer(subscription("laptop").endpoint, ...Array<number>(ATTEMPTS).fill(503));
    const timeline = dm(app, ada, owner);
    const sent = app.send(ada, timeline, { requestId: "s1", body: "still here" });
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      await service.received(attempt + 1);
      clock.advance(FIRST_RETRY * 2 ** (attempt - 1));
    }
    await settled();

    expect(app.readHistory(owner, timeline), "the message is readable").toEqual([
      expect.objectContaining({ kind: "message", body: "still here" }),
    ]);
    expect(app.unreadSummary(owner).total, "and still unread for the owner").toBe(1);
    expect(app.inboxEvents(owner), "its inbox event is still there").toHaveLength(1);
    expect(
      app.send(ada, timeline, { requestId: "s1", body: "still here" }),
      "its receipt still answers",
    ).toEqual(sent);
    app.close();
  });

  it("every delivery of one message carries the same tag, and another message carries another", async () => {
    const { app, clock, service, owner, ada } = ownerWithAgents();
    service.answer(subscription("phone").endpoint, 503);
    const timeline = dm(app, ada, owner);
    post(app, ada, timeline, "first");
    await service.received(1);
    clock.advance(FIRST_RETRY);
    await service.received(2);
    post(app, ada, timeline, "second");
    await service.received(3);

    const [first, retry, second] = service.requests.map((request) => request.notice.tag);
    expect(retry, "the retry replaces the first notification").toBe(first);
    expect(second, "a new message is a new notification").not.toBe(first);
    app.close();
  });

  it("subscribing an endpoint again refreshes its keys without adding a second subscription", async () => {
    const { app, service, owner, ada } = ownerWithAgents();
    const renewed = { ...subscription("phone"), keys: { p256dh: "renewed-key", auth: "renewed" } };
    app.subscribePush(owner, renewed);
    post(app, ada, dm(app, ada, owner), "ping");
    await service.received(1);
    await settled();
    expect(service.requests.map((request) => request.subscription)).toEqual([renewed]);
    app.close();
  });

  it("after unsubscribing, the endpoint gets no further pushes, pending retries included", async () => {
    const { app, clock, service, owner, ada } = ownerWithAgents();
    service.answer(subscription("phone").endpoint, "unreachable");
    const timeline = dm(app, ada, owner);
    post(app, ada, timeline, "first");
    await service.received(1);
    app.unsubscribePush(owner, { endpoint: subscription("phone").endpoint });
    clock.advance(DAY);
    post(app, ada, timeline, "second");
    await settled();
    expect(service.requests, "neither the retry nor the new message").toHaveLength(1);

    app.subscribePush(owner, subscription("phone"));
    post(app, ada, timeline, "third");
    await service.received(2);
    expect(service.requests).toHaveLength(2);
    app.close();
  });

  it("an endpoint another human subscribes takes none of the previous human's queued pushes along", async () => {
    const { app, clock, service, owner, ada } = ownerWithAgents();
    const sam = app.ensureAccount({
      externalId: "sam",
      displayName: "Sam",
      handle: "sam",
      kind: "human",
    });
    service.answer(subscription("phone").endpoint, "unreachable");
    post(app, ada, dm(app, ada, owner), "for the owner");
    await service.received(1);

    app.subscribePush(sam, subscription("phone"));
    clock.advance(FIRST_RETRY);
    await settled();
    expect(service.requests, "the owner's retry is not sent to Sam's browser").toHaveLength(1);

    post(app, ada, dm(app, ada, sam), "for Sam");
    await service.received(2);
    expect(service.requests).toHaveLength(2);
    expect(service.requests[1]?.notice.messageId, "Sam's own message").not.toBe(
      service.requests[0]?.notice.messageId,
    );
    app.close();
  });

  it("a push waiting for its retry is not sent once its account is deactivated", async () => {
    const { app, clock, service, owner, ada } = ownerWithAgents();
    service.answer(subscription("phone").endpoint, "unreachable");
    post(app, ada, dm(app, ada, owner), "for the owner");
    await service.received(1);

    app.deactivateAccount(owner, { requestId: rid() });
    clock.advance(DAY);
    await settled();

    expect(service.requests).toHaveLength(1);
    app.close();
  });

  it("a human cannot unsubscribe another human's endpoint, and is answered as for an unknown one", async () => {
    const { app, service, owner, ada } = ownerWithAgents();
    const sam = app.ensureAccount({
      externalId: "sam",
      displayName: "Sam",
      handle: "sam",
      kind: "human",
    });

    app.unsubscribePush(sam, { endpoint: subscription("phone").endpoint });
    post(app, ada, dm(app, ada, owner), "for the owner");
    await service.received(1);
    expect(service.endpoints(), "the owner's subscription stayed").toEqual([
      subscription("phone").endpoint,
    ]);
    app.close();
  });

  it("only the owner manages push subscriptions, and only for https endpoints", () => {
    const { app, owner, ada } = ownerWithAgents([]);
    expect(refusalReason(() => app.subscribePush(ada, subscription("ada-phone")))).toBe(
      "human-only",
    );
    expect(
      refusalReason(() =>
        app.unsubscribePush(ada, { endpoint: subscription("ada-phone").endpoint }),
      ),
    ).toBe("human-only");
    expect(
      refusalReason(() =>
        app.subscribePush(owner, { ...subscription("phone"), endpoint: "http://push.example/x" }),
      ),
    ).toBe("invalid-input");
    app.close();
  });
});
