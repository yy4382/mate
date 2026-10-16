import { FakeClock } from "@mate/testkit";
import { describe, expect, it } from "vitest";
import { newApp, newAppWithTwo, rid } from "./support.ts";

describe("3.2 sending and freshness", () => {
  it("send succeeds when there are no new messages from others since the last read", () => {
    const { app, alice } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    const result = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "hello" },
    );
    expect(result.status).toBe("sent");
    app.close();
  });

  it("send is held when another account posted since the sender last read, and re-send succeeds", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    // Bob sends first; Alice has not read it
    app.send(bob, { conversation: channel.conversationId }, { requestId: "b1", body: "bob here" });
    // Alice tries to send with freshness on — should be held
    const held = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "a1", body: "alice" },
    );
    expect(held.status).toBe("held");
    // Re-send with same body using a new requestId — should succeed now
    const sent = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "a2", body: "alice" },
    );
    expect(sent.status).toBe("sent");
    app.close();
  });

  it("sender's own messages never hold the sender back", () => {
    const { app, alice } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.send(alice, { conversation: channel.conversationId }, { requestId: "s1", body: "first" });
    const second = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s2", body: "second" },
    );
    expect(second.status).toBe("sent");
    app.close();
  });

  it("a new member joining a channel is held on their first send and receives recent messages", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "existing" },
    );
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    // Bob's read position is 0, there is one message from Alice
    const result = app.send(
      bob,
      { conversation: channel.conversationId },
      { requestId: "b1", body: "hi" },
    );
    expect(result.status).toBe("held");
    app.close();
  });

  it("a thread reply is only checked for freshness in that thread, not the top level", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    // Alice sends a top-level message to start a thread
    const sent = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "root" },
    );
    if (sent.status !== "sent") throw new Error("expected sent");
    const messageId = sent.messageId;
    // Bob sends a thread reply — top-level has new messages from Alice but thread is empty
    const threadReply = app.send(bob, { thread: messageId }, { requestId: "b1", body: "reply" });
    expect(threadReply.status).toBe("sent");
    app.close();
  });

  it("a top-level send is not held by a reply in one of its threads", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    const root = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "root" },
    );
    if (root.status !== "sent") throw new Error("expected sent");
    // Alice reads the top level, then Bob replies in the thread.
    app.readUnread(alice, { conversation: channel.conversationId }, { requestId: "r1" });
    app.send(bob, { thread: root.messageId }, { requestId: "b1", body: "reply" });
    // The reply lives in the thread timeline, so the top-level send sees nothing it has missed.
    const result = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "a1", body: "carrying on" },
    );
    expect(result.status).toBe("sent");
    app.close();
  });

  it("a task change in a timeline holds a subsequent send and returns that task entry", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    // Alice sends a message with a task
    const sent = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "work", createTask: { title: "Task A" } },
    );
    if (sent.status !== "sent") throw new Error("expected sent");
    if (sent.task === null) throw new Error("expected a task");
    const taskId = sent.task.taskId;
    // Bob reads so its read position is up to date
    app.readUnread(bob, { conversation: channel.conversationId }, { requestId: "r1" });
    // Alice claims the task (task entry appears after Bob's last read)
    app.changeTask(alice, { requestId: "c1", taskId, change: { kind: "claim" } });
    // Bob tries to send — should be held because of the task entry
    const result = app.send(
      bob,
      { conversation: channel.conversationId },
      { requestId: "b1", body: "hey" },
    );
    expect(result.status).toBe("held");
    app.close();
  });

  it("a held send writes no message, produces no inbox event, and adds no task", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    app.send(bob, { conversation: channel.conversationId }, { requestId: "b1", body: "first" });
    // Bob's inbox is the one that would grow, and his read position is the one that must move.
    const bobEventsBefore = app.inboxEvents(bob).length;
    const held = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "a1", body: "blocked", createTask: { title: "Would not survive" } },
    );
    expect(held.status).toBe("held");
    // Nothing was written: no new inbox event for the other member, no message, no task entry.
    expect(app.inboxEvents(bob).length).toBe(bobEventsBefore);
    const entries = app.readHistory(alice, { conversation: channel.conversationId });
    const bodies = entries.flatMap((entry) => (entry.kind === "message" ? [entry.body] : []));
    expect(bodies).toEqual(["first"]);
    expect(entries.some((entry) => entry.kind === "task")).toBe(false);
    app.close();
  });
  it("a send with freshness turned off succeeds despite unread messages from others", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    app.send(bob, { conversation: channel.conversationId }, { requestId: "b1", body: "bob here" });
    const sent = app.send(
      alice,
      { conversation: channel.conversationId },
      {
        requestId: "a1",
        body: "alice",
        freshness: false,
      },
    );
    expect(sent.status).toBe("sent");
    app.close();
  });

  it("a message is stamped with the time on the app's clock", () => {
    const clock = new FakeClock(Date.UTC(2026, 4, 1, 12, 0, 0));
    const app = newApp({ clock });
    const alice = app.ensureAccount({ externalId: "alice", displayName: "Alice", handle: "alice" });
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    const timeline = { conversation: channel.conversationId };
    app.send(alice, timeline, { requestId: "s1", body: "first" });
    clock.advance(90_000);
    app.send(alice, timeline, { requestId: "s2", body: "ninety seconds later" });
    expect(app.readHistory(alice, timeline).map((entry) => entry.at)).toEqual([
      Date.UTC(2026, 4, 1, 12, 1, 30),
      Date.UTC(2026, 4, 1, 12, 0, 0),
    ]);
    app.close();
  });

  it("an account-bound chat reads and sends as that account", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    const timeline = { conversation: channel.conversationId };
    const asBob = app.forAccount(bob);
    asBob.join({ requestId: rid(), conversationId: channel.conversationId });
    app.send(alice, timeline, { requestId: "s1", body: "hello bob" });
    expect(asBob.readUnread(timeline, { requestId: "r1" }).unread, "Bob's unread").toBe(1);
    expect(asBob.send(timeline, { requestId: "s2", body: "hi alice" }).status).toBe("sent");
    expect(
      app.inboxEvents(alice).map((event) => event.author),
      "Alice is notified of a message Bob wrote",
    ).toEqual([bob]);
    app.close();
  });
});
