import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { storeFixture, temporaryDirectory } from "@mate/testkit";
import { ChatApp, ChatStoreIncompatible } from "../src/index.ts";
import { openAppAt } from "./support.ts";

describe("the chat store opened by newer code (MODULE_TESTS 3.10)", () => {
  it("keeps the accounts, conversations, messages, thread, task and the owner's unread summary of a v0.1.0-alpha.2 store", () => {
    const { dataDirectory, facts } = storeFixture("v0.1.0-alpha.2");
    const app = openAppAt(join(dataDirectory, "chat.sqlite"));

    const owner = app.findAccount("owner");
    const [ada, bo] = facts.agentExternalIds.map((id) => app.findAccount(id));
    expect(owner, "the owner account").toBeDefined();
    expect(ada, "the first Agent's account").toBeDefined();
    expect(bo, "the second Agent's account").toBeDefined();

    const conversations = app.listConversations(owner!);
    expect(
      conversations.map((conversation) => [conversation.kind, conversation.name]).sort(),
      "the channel and both DMs",
    ).toEqual([
      ["dm", null],
      ["dm", null],
      ["public", "general"],
    ]);

    const general = conversations.find((conversation) => conversation.name === "general")!;
    const history = app.readHistory(owner!, { conversation: general.conversationId });
    const bodies = history.flatMap((entry) => (entry.kind === "message" ? [entry.body] : []));
    expect(bodies.reverse()).toEqual([
      "Kickoff: ship the migration lever",
      "On it. I will draft the plan.",
      "Plan drafted, see the thread",
      "@owner please review",
      "Write the upgrade test",
      "Claimed it, starting now",
      "@owner the claim is done",
    ]);
    const tasks = history.flatMap((entry) => (entry.kind === "task" ? [entry] : []));
    expect(tasks.map((entry) => [entry.title, entry.change, entry.owner]).reverse()).toEqual([
      ["Upgrade test", "created", null],
      ["Upgrade test", "claimed", ada],
    ]);

    const kickoff = history.find(
      (entry) => entry.kind === "message" && entry.body.startsWith("Kickoff"),
    )!;
    const thread = app.readHistory(owner!, {
      thread: kickoff.kind === "message" ? kickoff.messageId : 0,
    });
    expect(thread.flatMap((entry) => (entry.kind === "message" ? [entry.body] : []))).toEqual([
      "Thread: step one is the fixture",
    ]);

    const unread = app.unreadSummary(owner!);
    expect({
      total: unread.total,
      mentions: unread.mentions,
      timelines: unread.timelines.length,
    }).toEqual(facts.ownerUnread);
    app.close();
  });

  it("lets the owner keep working in a migrated store: the unread entries read once and the app writes", () => {
    const { dataDirectory } = storeFixture("v0.1.0-alpha.2");
    const app = openAppAt(join(dataDirectory, "chat.sqlite"));
    const owner = app.findAccount("owner")!;
    const general = app.listConversations(owner).find((c) => c.name === "general")!;

    const page = app.readUnread(
      owner,
      { conversation: general.conversationId },
      { requestId: "r1" },
    );
    expect(page.entries.length, "the entries after the owner's read position").toBeGreaterThan(0);
    const sent = app.send(
      owner,
      { conversation: general.conversationId },
      { requestId: "s1", body: "after the upgrade" },
    );
    expect(sent.status).toBe("sent");
    app.close();
  });

  it("refuses a store written by a newer schema version, naming the file and leaving it alone", () => {
    const file = join(temporaryDirectory(), "chat.sqlite");
    openAppAt(file).close();
    const raw = new DatabaseSync(file);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    const before = statSync(file).mtimeMs;

    let refusal: unknown;
    try {
      new ChatApp(file);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ChatStoreIncompatible);
    expect((refusal as ChatStoreIncompatible).file).toBe(file);
    expect((refusal as ChatStoreIncompatible).message).toContain(file);
    expect(statSync(file).mtimeMs, "the file was not written").toBe(before);

    const check = new DatabaseSync(file);
    expect(check.prepare("PRAGMA user_version").get()).toEqual({ user_version: 99 });
    check.close();
  });
});
