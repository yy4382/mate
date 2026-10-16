import { describe, expect, it } from "vitest";
import { newApp, newAppWithOwner, newAppWithTwo, refusalReason, rid } from "./support.ts";
import { ChatError } from "../src/index.ts";

describe("3.1 accounts and conversations", () => {
  it("ensureAccount with the same externalId twice returns the same account id", () => {
    const app = newApp();
    const id1 = app.ensureAccount({ externalId: "ext-1", displayName: "Alice", handle: "alice" });
    const id2 = app.ensureAccount({ externalId: "ext-1", displayName: "Alice2", handle: "alice" });
    expect(id1).toBe(id2);
    app.close();
  });

  it("a public channel can be read without joining but cannot be written to by a non-member", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, {
      requestId: rid(),
      name: "general",
      visibility: "public",
    });
    // bob can read without joining
    const page = app.readUnread(bob, { conversation: channel.conversationId }, { requestId: "r1" });
    expect(page).toBeDefined();
    // bob cannot send
    expect(() =>
      app.send(bob, { conversation: channel.conversationId }, { requestId: "s1", body: "hi" }),
    ).toThrow(ChatError);
    app.close();
  });

  it("a private channel is unreadable by a non-member and reports exactly what a missing conversation does", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, {
      requestId: rid(),
      name: "secret",
      visibility: "private",
    });
    const privateReason = refusalReason(() =>
      app.readUnread(bob, { conversation: channel.conversationId }, { requestId: "r1" }),
    );
    const missingReason = refusalReason(() =>
      app.readUnread(bob, { conversation: 999_999 }, { requestId: "r2" }),
    );
    expect(privateReason).toBe("not-found");
    expect(missingReason).toBe(privateReason);
    app.close();
  });

  it("a DM is unreadable by a third account", () => {
    const app = newApp();
    const a = app.ensureAccount({ externalId: "a", displayName: "A", handle: "aa" });
    const b = app.ensureAccount({ externalId: "b", displayName: "B", handle: "bb" });
    const c = app.ensureAccount({ externalId: "c", displayName: "C", handle: "cc" });
    const dm = app.openDm(a, { requestId: rid(), other: b });
    expect(() =>
      app.readUnread(c, { conversation: dm.conversationId }, { requestId: "r1" }),
    ).toThrow(ChatError);
    app.close();
  });

  it("two accounts get the same DM conversation regardless of who opens it first", () => {
    const { app, alice, bob } = newAppWithTwo();
    const dm1 = app.openDm(alice, { requestId: rid(), other: bob });
    const dm2 = app.openDm(bob, { requestId: rid(), other: alice });
    expect(dm1.conversationId).toBe(dm2.conversationId);
    app.close();
  });

  it("opening a DM with yourself throws invalid-target", () => {
    const { app, alice } = newAppWithTwo();
    expect(() => app.openDm(alice, { requestId: rid(), other: alice })).toThrow(ChatError);
    app.close();
  });

  it("the owner account can read every conversation, including a private channel and a DM it is not a member of", () => {
    const { app, ownerId } = newAppWithOwner();
    const a = app.ensureAccount({ externalId: "a", displayName: "A", handle: "aa" });
    const b = app.ensureAccount({ externalId: "b", displayName: "B", handle: "bb" });
    const secret = app.createChannel(a, {
      requestId: rid(),
      name: "agents-only",
      visibility: "private",
    });
    app.send(a, { conversation: secret.conversationId }, { requestId: "s1", body: "private talk" });
    const dm = app.openDm(a, { requestId: rid(), other: b });
    app.send(a, { conversation: dm.conversationId }, { requestId: "s2", body: "dm talk" });
    // The owner is a member of neither conversation, yet reads both and sees what is in them.
    const secretPage = app.readUnread(
      ownerId,
      { conversation: secret.conversationId },
      { requestId: "r1" },
    );
    expect(secretPage.entries.flatMap((e) => (e.kind === "message" ? [e.body] : []))).toEqual([
      "private talk",
    ]);
    const dmPage = app.readUnread(
      ownerId,
      { conversation: dm.conversationId },
      { requestId: "r2" },
    );
    expect(dmPage.entries.flatMap((e) => (e.kind === "message" ? [e.body] : []))).toEqual([
      "dm talk",
    ]);
    app.close();
  });

  it("invite takes effect immediately and the invited account's read position starts at the current end", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, {
      requestId: rid(),
      name: "team",
      visibility: "private",
    });
    // Send a message before bob is invited
    app.send(alice, { conversation: channel.conversationId }, { requestId: "s1", body: "old" });
    app.invite(alice, { requestId: rid(), conversationId: channel.conversationId, invitee: bob });
    // Bob should have no unread (position set to current end)
    const summary = app.unreadSummary(bob);
    expect(summary.total).toBe(0);
    app.close();
  });

  it("an archived channel can be read but not written to", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, {
      requestId: rid(),
      name: "old",
      visibility: "public",
    });
    app.send(alice, { conversation: channel.conversationId }, { requestId: "s1", body: "last" });
    app.archiveChannel(alice, { requestId: rid(), conversationId: channel.conversationId });
    // reading still works
    expect(() =>
      app.readUnread(alice, { conversation: channel.conversationId }, { requestId: "r1" }),
    ).not.toThrow();
    // writing is refused
    expect(() =>
      app.send(alice, { conversation: channel.conversationId }, { requestId: "s2", body: "nope" }),
    ).toThrow(ChatError);
    app.close();
  });
  it("a non-member of a public channel cannot create a task on one of its messages", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    const sent = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "work" },
    );
    if (sent.status !== "sent") throw new Error("expected sent");
    const reason = refusalReason(() =>
      app.createTask(bob, { requestId: "t1", messageId: sent.messageId, title: "Task" }),
    );
    expect(reason).toBe("not-member");
    app.close();
  });
});
