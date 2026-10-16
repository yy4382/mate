import { describe, expect, it } from "vitest";
import { newAppWithTwo, rid } from "./support.ts";

describe("3.6 inbox events and unread summary", () => {
  it("a top-level message generates one inbox event per member except the author", () => {
    const { app, alice, bob } = newAppWithTwo();
    const charlie = app.ensureAccount({
      externalId: "charlie",
      displayName: "Charlie",
      handle: "charlie",
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

  it("a thread reply only notifies thread participants and mentioned accounts", () => {
    const { app, alice, bob } = newAppWithTwo();
    const charlie = app.ensureAccount({
      externalId: "charlie",
      displayName: "Charlie",
      handle: "charlie",
    });
    const dave = app.ensureAccount({ externalId: "dave", displayName: "Dave", handle: "dave" });
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
    const afterFirst = app.inboxEvents(bob, { after: all[0]!.eventId });
    expect(afterFirst.length).toBe(4);
    expect(afterFirst[0]!.eventId).toBe(all[1]!.eventId);
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
    const late = app.ensureAccount({ externalId: "late", displayName: "Late", handle: "late" });
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
