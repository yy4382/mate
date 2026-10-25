import { once } from "node:events";
import { copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { Clock } from "@mate/clock";
import { FakeClock, temporaryDirectory } from "@mate/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatApp, LiveEvent, LiveSnapshot, TimelineRef } from "../src/index.ts";
import { openAppAt, refusalReason, rid } from "./support.ts";

const DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.restoreAllMocks();
});

/** The owner and an Agent, Ada, both members of the owner's #general, on a store a test can reopen. */
function ownerAndAda(options: { clock?: Clock } = {}) {
  const file = join(temporaryDirectory(), "chat.sqlite");
  const app = openAppAt(file, options);
  const owner = app.ensureAccount({
    externalId: "owner",
    displayName: "Owner",
    handle: "owner",
    kind: "human",
  });
  const ada = app.ensureAccount({
    externalId: "ada",
    displayName: "Ada",
    handle: "ada",
    kind: "agent",
  });
  const channel = app.createChannel(owner, {
    requestId: rid(),
    name: "general",
    visibility: "public",
  });
  app.join(ada, { requestId: rid(), conversationId: channel.conversationId });
  return { app, file, owner, ada, general: { conversation: channel.conversationId } };
}

function post(app: ChatApp, from: number, timeline: TimelineRef, body: string) {
  const result = app.send(from, timeline, { requestId: rid(), body, freshness: false });
  if (result.status !== "sent") throw new Error("expected sent");
  return result;
}

/** Every event after `cursor`, reading on from each batch's last cursor until the log has no more. */
function eventsAfter(app: ChatApp, owner: number, cursor: string): LiveEvent[] | "resnapshot" {
  const events: LiveEvent[] = [];
  for (let from = cursor; ;) {
    const read = app.liveEvents(owner, from);
    if (read.status === "resnapshot") return "resnapshot";
    if (read.events.length === 0) return events;
    events.push(...read.events);
    from = read.cursor;
  }
}

/** Follows the log as a client does: each call returns what was committed since the previous call. */
function follow(app: ChatApp, owner: number): () => LiveEvent[] {
  let cursor = app.liveSnapshot(owner).cursor;
  return () => {
    const events = eventsAfter(app, owner, cursor);
    if (events === "resnapshot") throw new Error("the follower fell behind");
    cursor = events.at(-1)?.cursor ?? cursor;
    return events;
  };
}

const entrySeqs = (events: LiveEvent[] | "resnapshot"): number[] | "resnapshot" =>
  events === "resnapshot"
    ? events
    : events.flatMap((event) => (event.type === "entry" ? [event.entry.seq] : []));

describe("3.9 live event stream", () => {
  it("a snapshot holds what was committed before it, and the events after its cursor hold what came after", () => {
    const { app, owner, ada, general } = ownerAndAda();
    const before = post(app, ada, general, "before");
    const snapshot = app.liveSnapshot(owner, { timeline: general });

    expect(snapshot.page, "the timeline the client opens with").toEqual({
      timeline: general,
      entries: [expect.objectContaining({ messageId: before.messageId, body: "before" })],
      position: 0,
    });
    expect(snapshot.unread.timelines).toEqual([
      expect.objectContaining({ timeline: general, unread: 1 }),
    ]);
    expect(snapshot.conversations).toEqual([
      expect.objectContaining({ name: "general", members: [owner, ada] }),
    ]);
    expect(snapshot.accounts).toEqual([
      {
        accountId: owner,
        handle: "owner",
        displayName: "Owner",
        kind: "human",
        active: true,
        avatarVersion: null,
      },
      {
        accountId: ada,
        handle: "ada",
        displayName: "Ada",
        kind: "agent",
        active: true,
        avatarVersion: null,
      },
    ]);

    const after = post(app, ada, general, "after");
    expect(eventsAfter(app, owner, snapshot.cursor)).toEqual([
      {
        type: "entry",
        cursor: expect.any(String),
        conversationId: general.conversation,
        timeline: general,
        entry: expect.objectContaining({ messageId: after.messageId, body: "after" }),
      },
    ]);
    app.close();
  });

  it("a message committed while snapshots are being read is in each snapshot or in the events after its cursor", async () => {
    const { app, file, owner, ada, general } = ownerAndAda();
    const count = 100;
    const writer = new Worker(new URL("./concurrent-writer.ts", import.meta.url), {
      workerData: { file, author: ada, timeline: general, count },
      execArgv: ["--conditions=mate-source"],
    });
    const exit = once(writer, "exit").then(
      ([code]: unknown[]) => code,
      (error: unknown) => error,
    );
    let writing = true;
    void exit.then(() => {
      writing = false;
    });
    const snapshots = new Map<string, LiveSnapshot>();
    while (writing) {
      const snapshot = app.liveSnapshot(owner, { timeline: general });
      snapshots.set(snapshot.cursor, snapshot);
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(await exit, "the writer finished").toBe(0);

    const newest = (snapshot: LiveSnapshot) => snapshot.page?.entries[0]?.seq ?? 0;
    expect(
      [...snapshots.values()].some((snapshot) => newest(snapshot) > 0 && newest(snapshot) < count),
      "some snapshots were read while the writer was committing",
    ).toBe(true);
    for (const snapshot of snapshots.values()) {
      const later = entrySeqs(eventsAfter(app, owner, snapshot.cursor));
      if (later === "resnapshot") throw new Error("the cursor should still be readable");
      const missing = Array.from({ length: count }, (_, index) => index + 1).filter(
        (seq) => seq > newest(snapshot) && !later.includes(seq),
      );
      expect(missing, `lost after the snapshot at ${snapshot.cursor}`).toEqual([]);
    }
    app.close();
  });

  it("each change the owner's client shows arrives as a live event: conversations, members, messages, task changes, accounts and the owner's read position", () => {
    const { app, owner, ada } = ownerAndAda();
    const next = follow(app, owner);
    const dev = app.createChannel(ada, { requestId: rid(), name: "dev", visibility: "private" });
    const conversation = (fields: object) =>
      expect.objectContaining({
        type: "conversation",
        conversation: expect.objectContaining({ conversationId: dev.conversationId, ...fields }),
      });
    expect(next(), "a new channel").toContainEqual(conversation({ name: "dev", members: [ada] }));
    app.invite(ada, { requestId: rid(), conversationId: dev.conversationId, invitee: owner });
    expect(next(), "a new member").toContainEqual(conversation({ members: [owner, ada] }));

    const top = { conversation: dev.conversationId };
    const message = app.send(ada, top, { requestId: rid(), body: "deploy?" });
    if (message.status !== "sent") throw new Error("expected sent");
    expect(next(), "a message").toEqual([
      expect.objectContaining({
        type: "entry",
        conversationId: dev.conversationId,
        timeline: top,
        entry: expect.objectContaining({ kind: "message", body: "deploy?", author: ada }),
      }),
    ]);
    app.createTask(ada, { requestId: rid(), messageId: message.messageId, title: "Deploy" });
    expect(next(), "a task change").toEqual([
      expect.objectContaining({
        type: "entry",
        timeline: top,
        entry: expect.objectContaining({ kind: "task", change: "created", title: "Deploy" }),
      }),
    ]);

    app.ensureAccount({
      externalId: "ada",
      displayName: "Ada Lovelace",
      handle: "ada",
      kind: "agent",
    });
    expect(next(), "a renamed account").toEqual([
      expect.objectContaining({
        type: "account",
        account: {
          accountId: ada,
          handle: "ada",
          displayName: "Ada Lovelace",
          kind: "agent",
          active: true,
          avatarVersion: null,
        },
      }),
    ]);
    app.ensureAccount({
      externalId: "ada",
      displayName: "Ada Lovelace",
      handle: "ada",
      kind: "agent",
    });
    expect(next(), "ensuring an account that has not changed changes nothing").toEqual([]);
    app.readUnread(owner, top, { requestId: rid() });
    expect(next(), "the owner read the channel").toEqual([
      expect.objectContaining({
        type: "read",
        conversationId: dev.conversationId,
        timeline: top,
        position: 2,
      }),
    ]);

    app.leave(ada, { requestId: rid(), conversationId: dev.conversationId });
    expect(next(), "a member left").toContainEqual(conversation({ members: [owner] }));
    app.archiveChannel(owner, { requestId: rid(), conversationId: dev.conversationId });
    expect(next(), "an archived channel").toContainEqual(conversation({ archived: true }));
    app.deactivateAccount(ada, { requestId: rid() });
    expect(next(), "a deactivated account").toEqual([
      expect.objectContaining({
        type: "account",
        account: expect.objectContaining({ accountId: ada, active: false }),
      }),
    ]);
    app.close();
  });

  it("each batch of live events carries the owner's unread summary as of the same read", () => {
    const { app, owner, ada, general } = ownerAndAda();
    const root = post(app, owner, general, "plan?");
    const cursor = app.liveSnapshot(owner).cursor;
    post(app, ada, general, "top-level news");
    post(app, ada, { thread: root.messageId }, "a reply in the owner's thread");
    const unreadAfter = () => {
      const read = app.liveEvents(owner, cursor);
      if (read.status === "resnapshot") throw new Error("the cursor should still be readable");
      return read.unread;
    };
    expect(unreadAfter()).toEqual(app.unreadSummary(owner));
    expect(unreadAfter().timelines.map((timeline) => [timeline.timeline, timeline.unread])).toEqual(
      [
        [general, 1],
        [{ thread: root.messageId }, 1],
      ],
    );
    app.readUnread(owner, general, { requestId: rid() });
    expect(
      unreadAfter().timelines.map((timeline) => timeline.timeline),
      "reading the channel leaves the thread",
    ).toEqual([{ thread: root.messageId }]);
    app.close();
  });

  it("an Agent reading moves only its own read position, which is not part of the owner's view", () => {
    const { app, owner, ada, general } = ownerAndAda();
    post(app, owner, general, "hello");
    const next = follow(app, owner);
    app.readUnread(ada, general, { requestId: rid() });
    expect(next()).toEqual([]);
    app.close();
  });

  it("a cursor older than the events kept, which span a day, answers resnapshot; a newer one reads on", () => {
    const clock = new FakeClock();
    const { app, owner, ada, general } = ownerAndAda({ clock });
    const old = app.liveSnapshot(owner).cursor;
    post(app, ada, general, "yesterday");
    const yesterday = app.liveSnapshot(owner).cursor;

    clock.advance(DAY - 1);
    post(app, ada, general, "within the day");
    expect(entrySeqs(eventsAfter(app, owner, old)), "a day old is still kept").toEqual([1, 2]);

    clock.advance(2);
    post(app, ada, general, "today");
    expect(eventsAfter(app, owner, old), "older than a day").toBe("resnapshot");
    expect(entrySeqs(eventsAfter(app, owner, yesterday)), "only older events went").toEqual([2, 3]);
    app.close();
  });

  it("a cursor from another epoch, or one that is not a cursor at all, answers resnapshot", () => {
    const first = ownerAndAda();
    const second = ownerAndAda();
    const cursor = first.app.liveSnapshot(first.owner).cursor;
    for (const store of [first, second]) post(store.app, store.ada, store.general, "same history");

    expect(entrySeqs(eventsAfter(first.app, first.owner, cursor)), "its own store").toEqual([1]);
    expect(
      second.app.liveEvents(second.owner, cursor),
      "a store with the same history but created separately",
    ).toEqual({ status: "resnapshot" });
    expect(first.app.liveEvents(first.owner, "not a cursor")).toEqual({ status: "resnapshot" });
    first.app.close();
    second.app.close();
  });

  it("a cursor ahead of the store, as after restoring an older copy of it, answers resnapshot", () => {
    const { app, file, owner, ada, general } = ownerAndAda();
    app.close();
    const backup = `${file}.backup`;
    copyFileSync(file, backup);
    const live = openAppAt(file);
    post(live, ada, general, "after the backup");
    const cursor = live.liveSnapshot(owner).cursor;
    live.close();

    for (const leftover of [`${file}-wal`, `${file}-shm`]) rmSync(leftover, { force: true });
    copyFileSync(backup, file);
    const restored = openAppAt(file);
    expect(restored.liveEvents(owner, cursor)).toEqual({ status: "resnapshot" });
    restored.close();
  });

  it("a cursor from before a restart reads on after it", () => {
    const { app, file, owner, ada, general } = ownerAndAda();
    const cursor = app.liveSnapshot(owner).cursor;
    app.close();
    const reopened = openAppAt(file);
    post(reopened, ada, general, "after the restart");
    expect(eventsAfter(reopened, owner, cursor)).toEqual([
      expect.objectContaining({
        type: "entry",
        entry: expect.objectContaining({ body: "after the restart" }),
      }),
    ]);
    reopened.close();
  });

  it("watchLive signals after each commit that appended live events, with those events already readable", () => {
    const { app, owner, ada, general } = ownerAndAda();
    const cursor = app.liveSnapshot(owner).cursor;
    const readable: number[] = [];
    const unsubscribe = app.watchLive(() => {
      const events = eventsAfter(app, owner, cursor);
      readable.push(events === "resnapshot" ? -1 : events.length);
    });
    post(app, ada, general, "one");
    app.readUnread(ada, general, { requestId: rid() });
    post(app, ada, general, "two");
    unsubscribe();
    post(app, ada, general, "three");
    expect(
      readable,
      "one signal per message; Ada's read and the send after unsubscribing none",
    ).toEqual([1, 2]);
    app.close();
  });

  it("a throwing live listener neither fails the write nor stops the other listeners", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, owner, ada, general } = ownerAndAda();
    let heard = 0;
    app.watchLive(() => {
      throw new Error("listener broke");
    });
    app.watchLive(() => {
      heard += 1;
    });
    const sent = app.send(ada, general, { requestId: "s1", body: "hello", freshness: false });
    expect(sent.status, "the send reports success").toBe("sent");
    expect(app.unreadSummary(owner).total, "the send committed").toBe(1);
    expect(heard, "the other listener still heard about it").toBe(1);
    app.close();
  });

  it("only the owner reads the live view", () => {
    const { app, owner, ada } = ownerAndAda();
    const cursor = app.liveSnapshot(owner).cursor;
    expect(refusalReason(() => app.liveSnapshot(ada))).toBe("human-only");
    expect(refusalReason(() => app.liveEvents(ada, cursor))).toBe("human-only");
    app.close();
  });
});
