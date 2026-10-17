import { FakeClock } from "@mate/testkit";
import { describe, expect, it } from "vitest";
import {
  FakePushService,
  newAppWithOwner,
  newAppWithTwo,
  refusalReason,
  rid,
  settled,
  subscription,
} from "./support.ts";
import { ChatError } from "../src/index.ts";

describe("3.4 idempotency", () => {
  it("a DM to the owner sent twice with the same requestId pushes once and records one live event", async () => {
    const clock = new FakeClock();
    const service = new FakePushService(clock);
    const { app, ownerId } = newAppWithOwner({ clock, push: service.send });
    const ada = app.ensureAccount({ externalId: "ada", displayName: "Ada", handle: "ada" });
    app.subscribePush(ownerId, subscription("phone"));
    const dm = {
      conversation: app.openDm(ada, { requestId: rid(), other: ownerId }).conversationId,
    };
    const cursor = app.liveSnapshot(ownerId).cursor;

    app.send(ada, dm, { requestId: "s1", body: "once" });
    app.send(ada, dm, { requestId: "s1", body: "once" });
    await service.received(1);
    clock.advance(24 * 60 * 60 * 1000);
    await settled();
    expect(service.requests, "one push").toHaveLength(1);
    expect(app.liveEvents(ownerId, cursor), "one live event").toEqual(
      expect.objectContaining({
        status: "events",
        events: [expect.objectContaining({ type: "entry" })],
      }),
    );
    app.close();
  });

  it("sending twice with the same requestId produces exactly one message and returns the same result", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    const first = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "hello" },
    );
    const second = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "hello" },
    );
    expect(first).toEqual(second);
    const history = app.readHistory(alice, { conversation: channel.conversationId });
    const messages = history.filter((e) => e.kind === "message");
    expect(messages.length).toBe(1);
    app.close();
  });

  it("the same requestId with different content is refused with request-conflict", () => {
    const { app, alice } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.send(alice, { conversation: channel.conversationId }, { requestId: "s1", body: "hello" });
    expect(() =>
      app.send(
        alice,
        { conversation: channel.conversationId },
        { requestId: "s1", body: "different" },
      ),
    ).toThrow(ChatError);
    app.close();
  });

  it("a held send is stored as a receipt so the same requestId returns the same held result", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    app.send(bob, { conversation: channel.conversationId }, { requestId: "b1", body: "first" });
    const held = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "a1", body: "blocked" },
    );
    expect(held.status).toBe("held");
    // Retry with same requestId must return the held result, not try again
    const held2 = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "a1", body: "blocked" },
    );
    expect(held2.status).toBe("held");
    app.close();
  });
  it("the same requestId used by two accounts is two separate operations", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    const first = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "shared", body: "from alice" },
    );
    const second = app.send(
      bob,
      { conversation: channel.conversationId },
      {
        requestId: "shared",
        body: "from bob",
        freshness: false,
      },
    );
    expect(first.status).toBe("sent");
    expect(second.status).toBe("sent");
    app.close();
  });

  it("repeating a join with the same requestId leaves the membership unchanged", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    const first = app.join(bob, { requestId: "j1", conversationId: channel.conversationId });
    const second = app.join(bob, { requestId: "j1", conversationId: channel.conversationId });
    expect(second).toEqual(first);
    expect(second.members).toEqual([alice, bob]);
    app.close();
  });

  it("a lifecycle requestId reused for a different channel is refused", () => {
    const { app, alice } = newAppWithTwo();
    const one = app.createChannel(alice, { requestId: rid(), name: "one", visibility: "public" });
    const two = app.createChannel(alice, { requestId: rid(), name: "two", visibility: "public" });
    app.leave(alice, { requestId: "l1", conversationId: one.conversationId });
    const reason = refusalReason(() =>
      app.leave(alice, { requestId: "l1", conversationId: two.conversationId }),
    );
    expect(reason).toBe("request-conflict");
    app.close();
  });

  it("repeating an invite with the same requestId does not move the invitee's read position again", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, {
      requestId: rid(),
      name: "team",
      visibility: "private",
    });
    app.invite(alice, { requestId: "i1", conversationId: channel.conversationId, invitee: bob });
    app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "after join" },
    );
    const repeat = app.invite(alice, {
      requestId: "i1",
      conversationId: channel.conversationId,
      invitee: bob,
    });
    expect(repeat.members).toEqual([alice, bob]);
    // The repeat was a replay, not a fresh invitation, so the message Bob has not read stays unread.
    expect(app.unreadSummary(bob).total).toBe(1);
    app.close();
  });

  it("repeating a deactivation with the same requestId is a no-op", () => {
    const { app, alice } = newAppWithTwo();
    app.deactivateAccount(alice, { requestId: "d1" });
    expect(() => app.deactivateAccount(alice, { requestId: "d1" })).not.toThrow();
    const reason = refusalReason(() =>
      app.readUnread(alice, { conversation: 1 }, { requestId: "r1" }),
    );
    expect(reason).toBe("inactive-account");
    app.close();
  });

  it("a repeated readUnread after a channel was archived returns the stored page", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    app.send(alice, { conversation: channel.conversationId }, { requestId: "s1", body: "one" });
    const first = app.readUnread(
      bob,
      { conversation: channel.conversationId },
      { requestId: "r1" },
    );
    app.archiveChannel(alice, { requestId: rid(), conversationId: channel.conversationId });
    const replay = app.readUnread(
      bob,
      { conversation: channel.conversationId },
      { requestId: "r1" },
    );
    expect(replay).toEqual(first);
    app.close();
  });

  it("a repeated send whose mentions are the same set in a different order is a replay, not a conflict", () => {
    const { app, alice, bob } = newAppWithTwo();
    const charlie = app.ensureAccount({
      externalId: "charlie",
      displayName: "Charlie",
      handle: "charlie",
    });
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    const first = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "hi", mentions: [bob, charlie] },
    );
    const replay = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "hi", mentions: [charlie, bob] },
    );
    expect(replay).toEqual(first);
    expect(app.readHistory(alice, { conversation: channel.conversationId })).toHaveLength(1);
    app.close();
  });
});
