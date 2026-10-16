import { describe, expect, it } from "vitest";
import { newAppWithTwo, refusalReason, rid } from "./support.ts";

describe("3.5 atomic commit", () => {
  it("a send whose task title the schema rejects writes no message and leaves no task entry", () => {
    const { app, alice } = newAppWithTwo();
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

  it("a message that fails after its row was written leaves neither the message nor its task behind", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    const eventsBefore = app.inboxEvents(bob).length;
    // The unknown account is only discovered while writing mentions, after the message row and its
    // task exist, so this is a genuine mid-transaction failure rather than a boundary rejection.
    const reason = refusalReason(() =>
      app.send(
        alice,
        { conversation: channel.conversationId },
        {
          requestId: "s1",
          body: "ghost",
          mentions: [999_999],
          createTask: { title: "Will not survive" },
        },
      ),
    );
    expect(reason).toBe("unknown-account");
    expect(app.readHistory(alice, { conversation: channel.conversationId })).toEqual([]);
    expect(app.inboxEvents(bob).length).toBe(eventsBefore);
    app.close();
  });

  it("a failed transaction leaves the timeline usable for the next write", () => {
    const { app, alice, bob } = newAppWithTwo();
    const channel = app.createChannel(alice, { requestId: rid(), name: "c", visibility: "public" });
    app.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    refusalReason(() =>
      app.send(
        alice,
        { conversation: channel.conversationId },
        { requestId: "s1", body: "doomed", mentions: [999_999] },
      ),
    );
    // The rolled-back attempt must not have consumed a sequence number or left a partial row.
    const sent = app.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s2", body: "fine" },
    );
    expect(sent.status).toBe("sent");
    if (sent.status !== "sent") throw new Error("expected sent");
    expect(sent.seq).toBe(1);
    expect(app.readHistory(alice, { conversation: channel.conversationId })).toHaveLength(1);
    app.close();
  });
});
