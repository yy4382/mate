import { describe, expect, it } from "vitest";
import { newAppWithOwner, newAppWithTwo, rid } from "./support.ts";

describe("3.6 inbox events and unread summary", () => {
  it("a top-level message generates one inbox event per member except the author", () => {
    const { app, alice, bob } = newAppWithTwo();
    const charlie = app.ensureAccount({
      externalId: "charlie",
      displayName: "Charlie",
      handle: "charlie",
      kind: "agent",
    });
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    app.join(charlie, { requestId: rid(), conversationId: channel.conversationId });
    app.send(alice, { conversation: channel.conversationId }, { requestId: "s1", body: "hello" });
    expect(app.inboxEvents(bob).length).toBe(1);
    expect(app.inboxEvents(charlie).length).toBe(1);
    expect(app.inboxEvents(alice).length).toBe(0); // author not notified
    app.close();
  });

  it("the owner is not notified of top-level messages in channels it never joined", () => {
    const { app, ownerId } = newAppWithOwner();
    const alice = app.ensureAccount({
      externalId: "alice-ext",
      displayName: "Alice",
      handle: "alice",
      kind: "agent",
    });
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.send(alice, { conversation: channel.conversationId }, { requestId: "s1", body: "hello" });
    // The owner can read every conversation, but is only told about the ones it belongs to.
    expect(app.inboxEvents(ownerId)).toEqual([]);
    app.close();
  });

  it("a thread reply only notifies thread participants and mentioned accounts", () => {
    const { app, alice, bob } = newAppWithTwo();
    const charlie = app.ensureAccount({
      externalId: "charlie",
      displayName: "Charlie",
      handle: "charlie",
      kind: "agent",
    });
    const dave = app.ensureAccount({
      externalId: "dave",
      displayName: "Dave",
      handle: "dave",
      kind: "agent",
    });
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    for (const member of [bob, charlie, dave]) {
      app.join(member, { requestId: rid(), conversationId: channel.conversationId });
    }
    // Alice posts the root, so she is a participant from the start.
    const root = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "root" },
    );
    if (root.status !== "sent") throw new Error("expected sent");
    const before = (account: number) => app.inboxEvents(account).length;
    const [aliceBefore, bobBefore, charlieBefore, daveBefore] = [
      before(alice),
      before(bob),
      before(charlie),
      before(dave),
    ];
    // Bob replies, mentioning Charlie. Bob authored it, so he is not notified.
    app.send(
      bob,
      { thread: root.messageId },
      { requestId: "t1", body: "reply", mentions: [charlie] },
    );
    // The root's author and the mentioned account are notified, and the event is marked as a thread.
    expect(before(alice)).toBe(aliceBefore + 1);
    expect(app.inboxEvents(alice).at(-1)?.inThread).toBe(true);
    expect(before(charlie)).toBe(charlieBefore + 1);
    expect(app.inboxEvents(charlie).at(-1)?.mentionsYou).toBe(true);
    // The author and a member who never took part get no thread event.
    expect(before(bob)).toBe(bobBefore);
    expect(before(dave)).toBe(daveBefore);
    app.close();
  });

  it("an account mentioned in a thread is notified of every later reply, and its summary counts exactly those", () => {
    const { app, alice, bob } = newAppWithTwo();
    const charlie = app.ensureAccount({
      externalId: "charlie",
      displayName: "Charlie",
      handle: "charlie",
      kind: "agent",
    });
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    const root = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "root" },
    );
    if (root.status !== "sent") throw new Error("expected sent");
    const thread = { thread: root.messageId };
    // Charlie never joined the public channel; a mention alone makes him follow the thread.
    app.send(bob, thread, { requestId: "t1", body: "ping", mentions: [charlie] });
    app.send(bob, thread, { requestId: "t2", body: "and a follow-up", freshness: false });
    expect(
      app.inboxEvents(charlie).map((event) => event.timeline),
      "both replies notify the mentioned account",
    ).toEqual([thread, thread]);
    expect(
      app.unreadSummary(charlie).timelines.map(({ timeline, unread }) => ({ timeline, unread })),
      "the summary lists the thread with the two replies he was notified of",
    ).toEqual([{ timeline: thread, unread: 2 }]);
    app.close();
  });

  it("a participant who left a private channel is neither notified of its threads nor shown them", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, {
      requestId: rid(),
      name: "p",
      visibility: "private",
    });
    app.invite(alice, { requestId: rid(), conversationId: channel.conversationId, invitee: bob });
    const root = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "root" },
    );
    if (root.status !== "sent") throw new Error("expected sent");
    const thread = { thread: root.messageId };
    app.send(bob, thread, { requestId: "t1", body: "bob took part" });
    app.leave(bob, { requestId: rid(), conversationId: channel.conversationId });
    const bobEvents = app.inboxEvents(bob).length;
    app.send(alice, thread, { requestId: "t2", body: "after bob left", freshness: false });
    expect(app.inboxEvents(bob), "no event once he can no longer read it").toHaveLength(bobEvents);
    expect(
      app.unreadSummary(bob).timelines.map((entry) => entry.timeline),
      "the thread is not in his summary either",
    ).not.toContainEqual(thread);
    app.close();
  });

  it("task entries do not produce inbox events", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    const sent = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "work", createTask: { title: "Task" } },
    );
    if (sent.status !== "sent") throw new Error("expected sent");
    const beforeCount = app.inboxEvents(bob).length;
    // Bob claims the task — should NOT add an inbox event
    if (sent.task === null) throw new Error("expected task");
    app.changeTask(bob, { requestId: "c1", taskId: sent.task.taskId, change: { kind: "claim" } });
    expect(app.inboxEvents(bob).length).toBe(beforeCount);
    app.close();
  });

  it("inboxEvents returns events in order and can be paged from any position without gaps", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    for (let i = 0; i < 5; i++) {
      app.send(
        alice,
        { conversation: channel.conversationId },
        { requestId: `s${i}`, body: `msg${i}` },
      );
    }
    const all = app.inboxEvents(bob);
    expect(all.length).toBe(5);
    const [first] = all;
    if (first === undefined) throw new Error("expected events");
    expect(app.inboxEvents(bob, { after: first.eventId })).toEqual(all.slice(1));
    app.close();
  });

  it("unreadSummary totals match the actual unread count from readUnread", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    app.send(alice, { conversation: channel.conversationId }, { requestId: "s1", body: "a" });
    app.send(alice, { conversation: channel.conversationId }, { requestId: "s2", body: "b" });
    const summary = app.unreadSummary(bob);
    const page = app.readUnread(bob, { conversation: channel.conversationId }, { requestId: "r1" });
    expect(summary.total).toBe(page.unread);
    app.close();
  });
  it("an account that joins after a message was sent never receives its inbox event", () => {
    const { app, alice } = newAppWithTwo();
    const late = app.ensureAccount({
      externalId: "late",
      displayName: "Late",
      handle: "late",
      kind: "agent",
    });
    const channel = app.createChannel(alice, {
      requestId: rid(),
      name: "c",
      visibility: "private",
    });
    app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "before you" },
    );
    app.invite(alice, { requestId: rid(), conversationId: channel.conversationId, invitee: late });
    expect(app.inboxEvents(late).length).toBe(0);
    app.close();
  });

  it("unreadSummary marks the timelines that hold a message mentioning the account", () => {
    const { app, alice, bob } = newAppWithTwo();
    const plain = app.createChannel(alice, {
      requestId: rid(),
      name: "plain",
      visibility: "public",
    });
    const pinged = app.createChannel(alice, {
      requestId: rid(),
      name: "pinged",
      visibility: "public",
    });
    app.join(bob, { requestId: rid(), conversationId: plain.conversationId });
    app.join(bob, { requestId: rid(), conversationId: pinged.conversationId });
    app.send(alice, { conversation: plain.conversationId }, { requestId: "p1", body: "just talk" });
    app.send(
      alice,
      { conversation: pinged.conversationId },
      { requestId: "p2", body: "hey @bob", mentions: [bob] },
    );
    const summary = app.unreadSummary(bob);
    expect(summary.mentions).toBe(1);
    const marked = summary.timelines.filter((t) => t.mentioned).map((t) => t.conversationId);
    expect(marked).toEqual([pinged.conversationId]);
    app.close();
  });
});
