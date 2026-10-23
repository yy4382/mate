import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FakeClock, temporaryDirectory } from "@mate/testkit";
import { describe, expect, it } from "vitest";
import {
  FakePushService,
  openAppAt,
  refusalReason,
  rid,
  settled,
  subscription,
} from "./support.ts";

/**
 * A chat app whose storage rejects the write of one request's receipt. The receipt is the last row a send writes,
 * after the message, its thread, its inbox events, its task and its task entry, so a failure there is the latest
 * failure a send can meet. The fault is injected from a second connection to the same file, as a failing disk would
 * be: the chat app's own code is untouched.
 */
function appFailingAtReceipt(requestId: string, options: Parameters<typeof openAppAt>[1] = {}) {
  const file = join(temporaryDirectory(), "chat.sqlite");
  const app = openAppAt(file, options);
  const storage = new DatabaseSync(file);
  storage.exec(
    `CREATE TRIGGER fail_receipt BEFORE INSERT ON receipts WHEN NEW.request_id = '${requestId}'
     BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END`,
  );
  return {
    app,
    heal: () => storage.exec("DROP TRIGGER fail_receipt"),
    close: () => {
      storage.close();
      app.close();
    },
  };
}

describe("3.5 atomic commit", () => {
  it("a send whose task title the schema rejects is refused before anything is written", () => {
    const app = openAppAt(join(temporaryDirectory(), "chat.sqlite"));
    const alice = app.ensureAccount({
      externalId: "alice",
      displayName: "Alice",
      handle: "alice",
      kind: "agent",
    });
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    const reason = refusalReason(() =>
      app.send(
        alice,
        { conversation: channel.conversationId },
        { requestId: "s1", body: "msg", createTask: { title: "" } },
      ),
    );
    expect(reason).toBe("invalid-input");
    expect(app.readHistory(alice, { conversation: channel.conversationId })).toEqual([]);
    app.close();
  });

  it("a send mentioning an account that does not exist is refused before anything is written", () => {
    const app = openAppAt(join(temporaryDirectory(), "chat.sqlite"));
    const alice = app.ensureAccount({
      externalId: "alice",
      displayName: "Alice",
      handle: "alice",
      kind: "agent",
    });
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    const reason = refusalReason(() =>
      app.send(
        alice,
        { conversation: channel.conversationId },
        { requestId: "s1", body: "ghost", mentions: [999_999] },
      ),
    );
    expect(reason).toBe("unknown-account");
    expect(app.readHistory(alice, { conversation: channel.conversationId })).toEqual([]);
    app.close();
  });

  it("a send that fails after its message, inbox events and task were written leaves none of them, and no signal", () => {
    const { app, heal, close } = appFailingAtReceipt("doomed");
    const alice = app.ensureAccount({
      externalId: "alice",
      displayName: "Alice",
      handle: "alice",
      kind: "agent",
    });
    const bob = app.ensureAccount({
      externalId: "bob",
      displayName: "Bob",
      handle: "bob",
      kind: "agent",
    });
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    const timeline = { conversation: channel.conversationId };
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    const signals: (readonly number[])[] = [];
    app.watchInbox((accounts) => signals.push(accounts));

    expect(() =>
      app.send(alice, timeline, {
        requestId: "doomed",
        body: "will not survive",
        mentions: [bob],
        createTask: { title: "Will not survive" },
      }),
    ).toThrow("injected storage failure");

    expect.soft(app.readHistory(alice, timeline), "no message and no task entry").toEqual([]);
    expect.soft(app.inboxEvents(bob), "no inbox event").toEqual([]);
    expect.soft(app.unreadSummary(bob).total, "nothing unread").toBe(0);
    // The attempt would have created the store's first task.
    expect
      .soft(
        refusalReason(() =>
          app.changeTask(bob, { requestId: rid(), taskId: 1, change: { kind: "claim" } }),
        ),
        "no task",
      )
      .toBe("not-found");
    expect.soft(signals, "no inbox signal").toEqual([]);

    // The rolled-back attempt consumed no sequence number: the next message is the timeline's first.
    heal();
    const retried = app.send(alice, timeline, { requestId: "doomed", body: "will not survive" });
    expect(retried).toMatchObject({ status: "sent", seq: 1 });
    close();
  });

  it("a DM to the owner that fails at its receipt queues no push, records no live event and signals nothing", async () => {
    const clock = new FakeClock();
    const service = new FakePushService(clock);
    const { app, heal, close } = appFailingAtReceipt("doomed", { clock, push: service.send });
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
    app.subscribePush(owner, subscription("phone"));
    const dm = { conversation: app.openDm(ada, { requestId: rid(), other: owner }).conversationId };
    const cursor = app.liveSnapshot(owner).cursor;
    let signals = 0;
    app.watchLive(() => {
      signals += 1;
    });
    const doomed = { requestId: "doomed", body: "will not survive", mentions: [owner] };

    expect(() => app.send(ada, dm, doomed)).toThrow("injected storage failure");
    await settled();
    expect.soft(service.requests, "no push").toEqual([]);
    expect
      .soft(app.liveEvents(owner, cursor), "no live event")
      .toEqual(expect.objectContaining({ status: "events", events: [] }));
    expect.soft(signals, "no live signal").toBe(0);

    heal();
    app.send(ada, dm, doomed);
    await service.received(1);
    expect(service.requests, "the same send, committed, pushes").toHaveLength(1);
    expect(signals, "and signals").toBe(1);
    close();
  });
});
