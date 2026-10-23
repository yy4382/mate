import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { temporaryDirectory } from "@mate/testkit";
import { openAppAt, rid } from "./support.ts";

describe("the chat store survives a restart", () => {
  it("a message sent before a restart is still readable after it, and reads pick up where they left off", () => {
    const file = join(temporaryDirectory(), "chat.sqlite");
    const first = openAppAt(file);
    const alice = first.ensureAccount({
      externalId: "alice-ext",
      displayName: "Alice",
      handle: "alice",
      kind: "agent",
    });
    const bob = first.ensureAccount({
      externalId: "bob-ext",
      displayName: "Bob",
      handle: "bob",
      kind: "agent",
    });
    const channel = first.createChannel(alice, {
      requestId: rid(),
      name: "c",
      visibility: "public",
    });
    first.join(bob, { requestId: rid(), conversationId: channel.conversationId });
    first.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "before" },
    );
    first.readUnread(bob, { conversation: channel.conversationId }, { requestId: "r1" });
    first.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s2", body: "during" },
    );
    first.close();

    // Reopening the same file is how a restart looks from the outside.
    const reopened = openAppAt(file);
    const history = reopened.readHistory(alice, { conversation: channel.conversationId });
    const bodies = history.filter((entry) => entry.kind === "message").map((entry) => entry.body);
    expect(bodies).toEqual(["during", "before"]);
    // Bob's read position persisted, so he only sees the message sent after his last read.
    const page = reopened.readUnread(
      bob,
      { conversation: channel.conversationId },
      { requestId: "r2" },
    );
    expect(page.entries.map((entry) => entry.seq)).toEqual([2]);
    reopened.close();
  });

  it("a requestId receipt from before a restart still answers the repeated call", () => {
    const file = join(temporaryDirectory(), "chat.sqlite");
    const first = openAppAt(file);
    const alice = first.ensureAccount({
      externalId: "alice-ext",
      displayName: "Alice",
      handle: "alice",
      kind: "agent",
    });
    const channel = first.createChannel(alice, {
      requestId: rid(),
      name: "c",
      visibility: "public",
    });
    const sent = first.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "once" },
    );
    first.close();

    // A replayed tool call after a crash finds its receipt and must not send a second message.
    const reopened = openAppAt(file);
    const replay = reopened.send(
      alice,
      { conversation: channel.conversationId },
      { requestId: "s1", body: "once" },
    );
    expect(replay).toEqual(sent);
    const messages = reopened
      .readHistory(alice, { conversation: channel.conversationId })
      .filter((entry) => entry.kind === "message");
    expect(messages).toHaveLength(1);
    reopened.close();
  });
});
