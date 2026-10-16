import { describe, expect, it } from "vitest";
import { newAppWithTwo, rid } from "./support.ts";

describe("3.3 reading", () => {
  it("readUnread returns entries after the read position and advances it", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    app.send(alice, { conversation: channel.conversationId }, { requestId: "s1", body: "msg1" });
    app.send(alice, { conversation: channel.conversationId }, { requestId: "s2", body: "msg2" });
    const page = app.readUnread(bob, { conversation: channel.conversationId }, { requestId: "r1" });
    expect(page.entries.length).toBe(2);
    // Second read with new requestId should return nothing new
    const page2 = app.readUnread(
      bob,
      { conversation: channel.conversationId },
      { requestId: "r2" },
    );
    expect(page2.entries.length).toBe(0);
    app.close();
  });

  it("when unread exceeds the budget, the newest messages are returned and the skipped range is described", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    // Costs are 11, 14 and 6 characters. A budget of 7 admits only the newest, then stops.
    app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "old message" },
    );
    app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s2", body: "middle message" },
    );
    app.send(alice, { conversation: channel.conversationId }, { requestId: "s3", body: "newest" });
    const page = app.readUnread(
      bob,
      { conversation: channel.conversationId },
      { requestId: "r1", budget: 7 },
    );
    expect(page.entries.map((entry) => entry.seq)).toEqual([3]);
    expect(page.skipped).toEqual({ first: 1, last: 2, mentions: [] });
    // The skipped range is announced, not silently dropped: the position still moves to the end.
    expect(page.position).toBe(3);
    app.close();
  });

  it("readHistory and search do not change the read position", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    app.send(alice, { conversation: channel.conversationId }, { requestId: "s1", body: "findme" });
    app.readHistory(bob, { conversation: channel.conversationId });
    app.search(bob, "findme");
    const summary = app.unreadSummary(bob);
    expect(summary.total).toBe(1); // still unread
    app.close();
  });

  it("readUnread with the same requestId returns the same page even if new messages arrived", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    app.send(alice, { conversation: channel.conversationId }, { requestId: "s1", body: "msg1" });
    const first = app.readUnread(
      bob,
      { conversation: channel.conversationId },
      { requestId: "r1" },
    );
    // New message arrives
    app.send(alice, { conversation: channel.conversationId }, { requestId: "s2", body: "msg2" });
    // Same requestId must return the same page
    const second = app.readUnread(
      bob,
      { conversation: channel.conversationId },
      { requestId: "r1" },
    );
    expect(second.entries.map((e) => e.seq)).toEqual(first.entries.map((e) => e.seq));
    app.close();
  });

  it("a thread's read position is independent from its conversation's read position", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    const sent = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "root" },
    );
    if (sent.status !== "sent") throw new Error("expected sent");
    app.send(alice, { thread: sent.messageId }, { requestId: "t1", body: "reply" });
    // Bob reads the conversation top level — thread stays unread
    app.readUnread(bob, { conversation: channel.conversationId }, { requestId: "r1" });
    const threadPage = app.readUnread(bob, { thread: sent.messageId }, { requestId: "r2" });
    expect(threadPage.entries.length).toBe(1);
    app.close();
  });
  it("an attachment's size counts against the read budget, so one large file fills it", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    // A one-character message carrying a large attachment still costs the whole attachment.
    app.send(
      alice,
      { conversation: channel.conversationId },
      {
        requestId: "s1",
        body: "x",
        attachments: [{ name: "big.png", size: 10_000, storageKey: "blob-1" }],
      },
    );
    const page = app.readUnread(
      bob,
      { conversation: channel.conversationId },
      { requestId: "r1", budget: 500 },
    );
    expect(page.entries.length).toBe(0);
    expect(page.skipped).not.toBeNull();
    app.close();
  });

  it("a read that skips entries reports how many are unread, which seq range was skipped, and any mentions in it", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    // seq 1: mentions bob; seq 2: plain; seq 3: newest, the only one that fits
    app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "old", mentions: [bob] },
    );
    app.send(alice, { conversation: channel.conversationId }, { requestId: "s2", body: "middle" });
    app.send(alice, { conversation: channel.conversationId }, { requestId: "s3", body: "newest" });
    const page = app.readUnread(
      bob,
      { conversation: channel.conversationId },
      { requestId: "r1", budget: 6 },
    );
    expect(page.unread).toBe(3);
    expect(page.returned).toEqual({ first: 3, last: 3 });
    expect(page.skipped?.mentions).toEqual([1]);
    expect(page.position).toBe(3);
    app.close();
  });
});
