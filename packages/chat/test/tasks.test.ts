import { describe, expect, it } from "vitest";
import { newAppWithTwo, refusalReason, rid } from "./support.ts";
import { ChatError } from "../src/index.ts";

describe("3.7 tasks", () => {
  it("a message can have multiple tasks and creation does not auto-assign an owner", () => {
    const { app, alice } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    const sent = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "work" },
    );
    if (sent.status !== "sent") throw new Error("expected sent");
    const t1 = app.createTask(alice, {
      requestId: "t1",
      messageId: sent.messageId,
      title: "Task 1",
    });
    const t2 = app.createTask(alice, {
      requestId: "t2",
      messageId: sent.messageId,
      title: "Task 2",
    });
    expect(t1.status).toBe("applied");
    expect(t2.status).toBe("applied");
    if (t1.status === "applied") expect(t1.task.owner).toBeNull();
    app.close();
  });

  it("two claims on the same task result in exactly one success and one refusal", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    const sent = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "work", createTask: { title: "Task" } },
    );
    if (sent.status !== "sent") throw new Error("expected sent");
    if (sent.task === null) throw new Error("expected a task");
    const taskId = sent.task.taskId;
    // Freshness is off so the race reaches the task state machine rather than being held; 3.2 covers the hold.
    const r1 = app.changeTask(alice, {
      requestId: "c1",
      taskId,
      change: { kind: "claim" },
      freshness: false,
    });
    const r2 = app.changeTask(bob, {
      requestId: "c2",
      taskId,
      change: { kind: "claim" },
      freshness: false,
    });
    const applied = [r1, r2].filter((r) => r.status === "applied");
    const refused = [r1, r2].filter((r) => r.status === "refused");
    expect(applied.length).toBe(1);
    expect(refused.length).toBe(1);
    if (refused[0]?.status !== "refused") throw new Error("expected a refusal");
    expect(refused[0].reason).toBe("claimed");
    // The winner holds the task; the loser changed nothing.
    if (applied[0]?.status !== "applied") throw new Error("expected an application");
    expect(applied[0].task.owner).not.toBeNull();
    app.close();
  });

  it("a stale yield by a previous owner does not displace the new owner", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    const sent = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "work", createTask: { title: "Task" } },
    );
    if (sent.status !== "sent") throw new Error("expected sent");
    if (sent.task === null) throw new Error("expected a task");
    const taskId = sent.task.taskId;
    // Alice claims, then bob claims after alice yielded
    app.changeTask(alice, { requestId: "c1", taskId, change: { kind: "claim" } });
    app.changeTask(alice, { requestId: "y1", taskId, change: { kind: "yield" } });
    app.changeTask(bob, { requestId: "c2", taskId, change: { kind: "claim" } });
    // Alice tries to yield again — not owner, should be refused
    const r = app.changeTask(alice, { requestId: "y2", taskId, change: { kind: "yield" } });
    expect(r.status).toBe("refused");
    app.close();
  });

  it("only the current owner can transfer a task and not to themselves", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    const sent = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "work", createTask: { title: "Task" } },
    );
    if (sent.status !== "sent") throw new Error("expected sent");
    if (sent.task === null) throw new Error("expected a task");
    const taskId = sent.task.taskId;
    app.changeTask(alice, { requestId: "c1", taskId, change: { kind: "claim" } });
    // Bob reads so he's up to date
    app.readUnread(bob, { conversation: channel.conversationId }, { requestId: "r1" });
    // Transfer to self should throw
    expect(() =>
      app.changeTask(alice, { requestId: "tr1", taskId, change: { kind: "transfer", to: alice } }),
    ).toThrow(ChatError);
    // Bob (non-owner) cannot transfer
    const r = app.changeTask(bob, {
      requestId: "tr2",
      taskId,
      change: { kind: "transfer", to: alice },
    });
    expect(r.status).toBe("refused");
    app.close();
  });

  it("a task cannot be transferred to an account that is not a member of the conversation", () => {
    const { app, alice } = newAppWithTwo();
    const outsider = app.ensureAccount({
      externalId: "outsider",
      displayName: "Outsider",
      handle: "outsider",
    });
    const channel = app.createChannel(alice, {
      requestId: rid(),
      name: "team",
      visibility: "private",
    });
    const sent = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "work", createTask: { title: "Task" } },
    );
    if (sent.status !== "sent") throw new Error("expected sent");
    if (sent.task === null) throw new Error("expected a task");
    const taskId = sent.task.taskId;
    app.changeTask(alice, { requestId: "c1", taskId, change: { kind: "claim" } });
    // Holding a task grants no access, so an account that cannot read the conversation cannot take it.
    const reason = refusalReason(() =>
      app.changeTask(alice, {
        requestId: "tr1",
        taskId,
        change: { kind: "transfer", to: outsider },
      }),
    );
    expect(reason).toBe("invalid-target");
    app.close();
  });

  it("a non-member cannot claim a task even if they can read the public channel", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    const sent = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "work", createTask: { title: "Task" } },
    );
    if (sent.status !== "sent") throw new Error("expected sent");
    if (sent.task === null) throw new Error("expected a task");
    const taskId = sent.task.taskId;
    // Bob can read (public) but is not a member — claim should throw not-member
    expect(() =>
      app.changeTask(bob, { requestId: "c1", taskId, change: { kind: "claim" } }),
    ).toThrow(ChatError);
    app.close();
  });

  it("task entries do not appear as chat messages in the timeline", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    const sent = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "work", createTask: { title: "Task" } },
    );
    if (sent.status !== "sent") throw new Error("expected sent");
    if (sent.task === null) throw new Error("expected a task");
    app.changeTask(bob, {
      requestId: "c1",
      taskId: sent.task.taskId,
      change: { kind: "claim" },
    });
    const history = app.readHistory(alice, { conversation: channel.conversationId });
    const messages = history.filter((e) => e.kind === "message");
    expect(messages.length).toBe(1); // only the original message
    app.close();
  });
});
