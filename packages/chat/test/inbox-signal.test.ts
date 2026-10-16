import { afterEach, describe, expect, it, vi } from "vitest";
import { newAppWithOwner, newAppWithTwo, refusalReason, rid } from "./support.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Alice's public channel with Bob and Charlie as members. */
function channelWithThree() {
  const { app, alice, bob } = newAppWithTwo();
  const charlie = app.ensureAccount({
    externalId: "charlie",
    displayName: "Charlie",
    handle: "charlie",
  });
  const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
  app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
  app.join(charlie, { requestId: rid(), conversationId: channel.conversationId });
  return { app, alice, bob, charlie, timeline: { conversation: channel.conversationId } };
}

describe("3.6 inbox signal", () => {
  it("a send signals once with exactly the accounts that received inbox events, after the message is readable", () => {
    const { app, alice, bob, charlie, timeline } = channelWithThree();
    const seen: { accounts: readonly number[]; bobEvents: number; bobUnread: number }[] = [];
    app.watchInbox((accounts) => {
      seen.push({
        accounts: [...accounts].sort(),
        bobEvents: app.inboxEvents(bob).length,
        bobUnread: app.readUnread(bob, timeline, { requestId: "inside" }).unread,
      });
    });
    app.send(alice, timeline, { requestId: "s1", body: "hello" });
    // One signal for one committed send, naming every member except the author, sent once the inbox event and the
    // message are readable.
    expect(seen).toEqual([{ accounts: [bob, charlie].sort(), bobEvents: 1, bobUnread: 1 }]);
    app.close();
  });

  it("a thread reply signals only the accounts it notifies", () => {
    const { app, alice, bob, charlie, timeline } = channelWithThree();
    const root = app.send(alice, timeline, { requestId: "s1", body: "root" });
    if (root.status !== "sent") throw new Error("expected sent");
    const seen: (readonly number[])[] = [];
    app.watchInbox((accounts) => seen.push(accounts));
    app.send(bob, { thread: root.messageId }, { requestId: "t1", body: "reply" });
    expect(seen, "the root's author is the only participant besides the replier").toEqual([
      [alice],
    ]);
    expect(seen.flat()).not.toContain(charlie);
    app.close();
  });

  it("a held send does not signal", () => {
    const { app, alice, bob, timeline } = channelWithThree();
    app.send(alice, timeline, { requestId: "s1", body: "unread by bob" });
    const seen: (readonly number[])[] = [];
    app.watchInbox((accounts) => seen.push(accounts));
    const result = app.send(bob, timeline, { requestId: "b1", body: "reply" });
    expect(result.status, "bob had not read alice's message").toBe("held");
    expect(seen, "a held send appends no inbox events").toEqual([]);
    app.close();
  });

  it("a repeated requestId that returns the stored receipt does not signal", () => {
    const { app, alice, timeline } = channelWithThree();
    app.send(alice, timeline, { requestId: "s1", body: "once" });
    const seen: (readonly number[])[] = [];
    app.watchInbox((accounts) => seen.push(accounts));
    const repeat = app.send(alice, timeline, { requestId: "s1", body: "once" });
    expect(repeat.status).toBe("sent");
    expect(seen, "the repeat appends nothing, so nothing is signalled").toEqual([]);
    app.close();
  });

  it("after unsubscribing, a listener receives no further signals", () => {
    const { app, alice, timeline } = channelWithThree();
    const seen: (readonly number[])[] = [];
    const unsubscribe = app.watchInbox((accounts) => seen.push(accounts));
    app.send(alice, timeline, { requestId: "s1", body: "first" });
    unsubscribe();
    app.send(alice, timeline, { requestId: "s2", body: "second" });
    expect(seen, "only the send before unsubscribing").toHaveLength(1);
    app.close();
  });

  it("a throwing listener neither fails the send nor stops the other listeners", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, alice, bob, timeline } = channelWithThree();
    const seen: (readonly number[])[] = [];
    app.watchInbox(() => {
      throw new Error("listener broke");
    });
    app.watchInbox((accounts) => seen.push(accounts));
    const sent = app.send(alice, timeline, { requestId: "s1", body: "hello" });
    expect(sent.status, "the send reports success").toBe("sent");
    expect(app.inboxEvents(bob), "the send committed").toHaveLength(1);
    expect(seen, "the second listener still heard about it").toHaveLength(1);
    app.close();
  });
});

describe("3.6 unread summary carries what a notice shows", () => {
  it("a channel, a DM and a thread each report their kind, label, thread flag and latest sender", () => {
    const { app, ownerId } = newAppWithOwner();
    const lin = app.ensureAccount({ externalId: "lin", displayName: "Lin", handle: "lin" });
    const richard = app.ensureAccount({
      externalId: "richard",
      displayName: "Richard",
      handle: "richard",
    });
    const general = app.createChannel(ownerId, {
      requestId: rid(),
      name: "general",
      visibility: "public",
    });
    for (const member of [lin, richard]) {
      app.join(member, { requestId: rid(), conversationId: general.conversationId });
    }
    // Freshness is off for setup: the test is about the summary, not about who had read what.
    const top = { conversation: general.conversationId };
    const root = app.send(ownerId, top, { requestId: rid(), freshness: false, body: "plan?" });
    if (root.status !== "sent") throw new Error("expected sent");
    app.send(lin, top, { requestId: rid(), freshness: false, body: "first" });
    app.send(richard, top, {
      requestId: rid(),
      freshness: false,
      body: "latest",
      mentions: [ownerId],
    });
    app.send(
      richard,
      { thread: root.messageId },
      { requestId: rid(), freshness: false, body: "reply 1" },
    );
    app.send(
      lin,
      { thread: root.messageId },
      { requestId: rid(), freshness: false, body: "reply 2" },
    );
    const dm = app.openDm(lin, { requestId: rid(), other: ownerId });
    app.send(
      lin,
      { conversation: dm.conversationId },
      { requestId: rid(), freshness: false, body: "psst" },
    );

    const summary = app.unreadSummary(ownerId);
    const find = (timeline: object) =>
      summary.timelines.find((t) => JSON.stringify(t.timeline) === JSON.stringify(timeline));

    expect(find(top), "the channel is labelled by its name").toMatchObject({
      kind: "public",
      label: "general",
      inThread: false,
      unread: 2,
      mentioned: true,
      latestSender: "richard",
    });
    expect(find({ thread: root.messageId }), "the thread carries its channel's name").toMatchObject(
      {
        conversationId: general.conversationId,
        kind: "public",
        label: "general",
        inThread: true,
        unread: 2,
        mentioned: false,
        latestSender: "lin",
      },
    );
    expect(
      find({ conversation: dm.conversationId }),
      "a DM is labelled by the other member's handle",
    ).toMatchObject({
      kind: "dm",
      label: "lin",
      inThread: false,
      unread: 1,
      latestSender: "lin",
    });
    app.close();
  });
});
