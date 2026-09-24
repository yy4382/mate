import { afterEach, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Store } from "../../src/storage/store.js";
import { slackApplication } from "../../src/slack/application.js";
import { ConversationHistory, type HistorySource } from "../../src/conversations/history.js";
import { CanonicalOutput } from "../../src/conversations/output.js";
import { Collaboration } from "../../src/collaboration/service.js";
import type { MessageDTO } from "../../src/domain/messages.js";
import { configFixture } from "../helpers/config.js";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

function setup(source?: HistorySource) {
  const store = new Store(":memory:");
  stores.push(store);
  const { messages, mapper } = slackApplication(store, configFixture);
  store.register("research", "history", []);
  store.enqueue("research", "start", {});
  const run = store.beginRun("research")!;
  store.input(run, {});
  const external = mapper.conversation("CTEST");
  messages.membership("research", external, true);
  return {
    store,
    messages,
    mapper,
    run,
    external,
    history: new ConversationHistory(messages, source),
  };
}

function message(conversationId: string, n: number, text = `message ${n}`): MessageDTO {
  const id = `message-${n}`;
  return {
    id,
    conversationId,
    rootId: id,
    author: { kind: "human", id: "owner" },
    origin: "participant",
    mentions: [],
    text,
    deleted: false,
    order: String(n),
    revision: String(n),
    attachments: [],
  };
}

it("quiet acquisition records visibility without observations, wakeups or false reading, while a later event still delivers", () => {
  const f = setup(),
    value = {
      ...message(f.external, 1, "direct"),
      mentions: [{ kind: "agent" as const, id: "research" }],
    };
  const baseline = Number(
    (f.store.db.prepare("SELECT count(*) n FROM deliveries").get() as { n: number }).n,
  );
  f.messages.recordHistory(value, ["research"]);
  expect(f.store.db.prepare("SELECT count(*) n FROM message_observations").get()).toEqual({ n: 0 });
  expect(f.store.db.prepare("SELECT count(*) n FROM attention_seen").get()).toEqual({ n: 0 });
  expect(f.store.db.prepare("SELECT count(*) n FROM deliveries").get()).toEqual({ n: baseline });
  const output = new CanonicalOutput(f.messages, {
    post: async () => {
      throw new Error("offline");
    },
    pendingInput: () => false,
    classify: () => ({ kind: "unknown" }),
  });
  const collaboration = new Collaboration(f.store, f.messages, output, configFixture);
  expect(collaboration.attention.peek("research")).toEqual([]);
  f.messages.record(value, ["research"]);
  expect(f.store.db.prepare("SELECT count(*) n FROM message_observations").get()).toEqual({ n: 1 });
  expect(f.store.db.prepare("SELECT count(*) n FROM deliveries").get()).toEqual({
    n: baseline + 1,
  });
  expect(collaboration.attention.peek("research")).toMatchObject([{ unseen: 1 }]);
  f.messages.recordHistory(value, ["research"]);
  expect(f.store.db.prepare("SELECT count(*) n FROM message_observations").get()).toEqual({ n: 1 });
  expect(f.store.db.prepare("SELECT count(*) n FROM deliveries").get()).toEqual({
    n: baseline + 1,
  });
});

it("a quiet edit invalidates an established view without advancing seen state", () => {
  const f = setup(),
    output = new CanonicalOutput(f.messages, {
      post: async () => {
        throw new Error("offline");
      },
      pendingInput: () => false,
      classify: () => ({ kind: "unknown" }),
    });
  const collaboration = new Collaboration(f.store, f.messages, output, configFixture),
    first = message(f.external, 10);
  f.messages.record(first, ["research"]);
  const target = { conversationId: f.external, threadId: first.id };
  const page = collaboration.attention.read(f.run, target) as { viewToken: string };
  const result: AgentMessage = {
    role: "toolResult",
    toolCallId: "read",
    toolName: "mate",
    content: [{ type: "text", text: JSON.stringify(page) }],
    isError: false,
    timestamp: 0,
  };
  collaboration.attention.presented(f.run, result);
  expect(collaboration.attention.valid(f.run, target, page.viewToken)).toBe(true);
  expect(
    f.store.db
      .prepare("SELECT revision FROM attention_seen WHERE agent_id=? AND key=?")
      .get("research", first.id),
  ).toEqual({ revision: "10" });
  f.messages.recordHistory({ ...first, revision: "11", text: "quietly discovered edit" }, [
    "research",
  ]);
  expect(collaboration.attention.valid(f.run, target, page.viewToken)).toBe(false);
  expect(
    f.store.db
      .prepare("SELECT revision FROM attention_seen WHERE agent_id=? AND key=?")
      .get("research", first.id),
  ).toEqual({ revision: "10" });
  expect(collaboration.attention.peek("research")).toMatchObject([{ unseen: 0 }]);
});

it("current internal membership exposes earlier room history, while unobserved external cache stays private", () => {
  const f = setup(),
    room = f.messages.references.createConversation("channel", "internal", "room").id;
  f.messages.recordHistory(message(room, 1, "old internal"), []);
  f.messages.recordHistory(message(f.external, 2, "cached for another installation"), []);
  f.messages.membership("research", room, true);
  expect(
    f.history
      .page(f.run, { target: { conversationId: room }, limit: 20 })
      .messages.map((item) => item.text),
  ).toEqual(["old internal"]);
  expect(
    f.history.page(f.run, { target: { conversationId: f.external }, limit: 20 }).messages,
  ).toEqual([]);
  expect(f.messages.message("research", "message-1").text).toBe("old internal");
  expect(() => f.messages.message("research", "message-2")).toThrow("visible");
});

it("local pages have exact nonrepeating cursors bound to actor, target and query, and around returns closest context", () => {
  const f = setup(),
    room = f.messages.references.createConversation("channel", "internal", "room").id;
  f.messages.membership("research", room, true);
  for (let n = 1; n <= 4; n++)
    f.messages.recordHistory(message(room, n, n === 3 ? "needle" : ""), []);
  const first = f.history.page(f.run, { target: { conversationId: room }, limit: 1 });
  const second = f.history.page(f.run, {
    target: { conversationId: room },
    limit: 1,
    cursor: first.nextCursor!,
  });
  expect(first.messages[0]!.id).toBe("message-4");
  expect(second.messages[0]!.id).toBe("message-3");
  expect(() =>
    f.history.page(f.run, {
      target: { conversationId: room },
      limit: 2,
      cursor: first.nextCursor!,
    }),
  ).toThrow("another actor, target or query");
  const found = f.history.search(f.run, {
    target: { conversationId: room },
    query: "needle",
    limit: 1,
  });
  expect(found.messages.map((item) => item.id)).toEqual(["message-3"]);
  expect(() =>
    f.history.search(f.run, {
      target: { conversationId: room },
      query: "different",
      limit: 1,
      cursor: found.nextCursor ?? first.nextCursor!,
    }),
  ).toThrow("another actor, target or query");
  const around = f.history.around(f.run, { messageId: "message-3", before: 1, after: 1 });
  expect(around.messages.map((item) => item.id)).toEqual(["message-2", "message-3", "message-4"]);
});

it("around pages away from the anchor one bounded direction at a time, even when a page is empty", () => {
  const f = setup(),
    room = f.messages.references.createConversation("channel", "internal", "around-room").id;
  f.messages.membership("research", room, true);
  for (let n = 1; n <= 5; n++) f.messages.recordHistory(message(room, n), []);
  const ids = (page: { messages: MessageDTO[] }) => page.messages.map((item) => item.id);
  const around = (input: Record<string, unknown>) =>
    f.history.around(f.run, {
      messageId: "message-3",
      limit: 1,
      direction: "before",
      ...input,
    }) as {
      messages: MessageDTO[];
      nextCursor: string | null;
    };
  expect(ids(f.history.around(f.run, { messageId: "message-3", before: 1, after: 1 }))).toEqual([
    "message-2",
    "message-3",
    "message-4",
  ]);
  // The anchor names the position, so one step per call still pages the whole direction.
  const nearest = around({});
  expect(ids(nearest)).toEqual(["message-2"]);
  const older = around({ cursor: nearest.nextCursor! });
  expect(ids(older)).toEqual(["message-1"]);
  expect(older.nextCursor).toBeNull();
  const after = f.history.around(f.run, { messageId: "message-3", direction: "after", limit: 1 });
  expect(ids(after)).toEqual(["message-4"]);
  const later = f.history.around(f.run, {
    messageId: "message-3",
    direction: "after",
    limit: 2,
    cursor: after.nextCursor!,
  });
  expect(ids(later)).toEqual(["message-5"]);
  expect(later.nextCursor).toBeNull();
});

it("the two-sided around read reports which sides have more and only continues as a directed walk", () => {
  const f = setup(),
    room = f.messages.references.createConversation("channel", "internal", "around-two-sided").id;
  f.messages.membership("research", room, true);
  for (let n = 1; n <= 5; n++) f.messages.recordHistory(message(room, n), []);
  const opening = f.history.around(f.run, { messageId: "message-3", before: 1, after: 1 }) as {
    messages: MessageDTO[];
    nextCursor: string | null;
    coverage: Record<string, unknown>;
  };
  expect(opening.messages.map((item) => item.id)).toEqual(["message-2", "message-3", "message-4"]);
  expect(opening.nextCursor).toBeNull();
  // The nearest read is not a page of one walk, so it names the truncation instead of a cursor.
  expect(opening.coverage).toMatchObject({ beforeTruncated: true, afterTruncated: true });
  const walkFrom = (input: Record<string, unknown>) =>
    f.history.around(f.run, {
      messageId: "message-3",
      direction: "before",
      limit: 1,
      ...input,
    }) as { messages: MessageDTO[] };
  expect(walkFrom({}).messages.map((item) => item.id)).toEqual(["message-2"]);
  // The same anchor and direction continue the walk from the page the directed read returned.
  const nearest = f.history.around(f.run, {
    messageId: "message-3",
    direction: "before",
    limit: 1,
  }) as { nextCursor: string; messages: MessageDTO[] };
  expect(
    (
      f.history.around(f.run, {
        messageId: "message-3",
        direction: "before",
        limit: 1,
        cursor: nearest.nextCursor,
      }) as { messages: MessageDTO[] }
    ).messages.map((item) => item.id),
  ).toEqual(["message-1"]);
});

it("around refuses a continuation that does not say which way it walks", () => {
  const f = setup(),
    room = f.messages.references.createConversation("channel", "internal", "around-cursor").id;
  f.messages.membership("research", room, true);
  for (let n = 1; n <= 5; n++) f.messages.recordHistory(message(room, n), []);
  const older = f.history.around(f.run, {
    messageId: "message-3",
    direction: "before",
    limit: 1,
  }) as { nextCursor: string };
  // The cursor itself is opaque; only the directed call can say where it continues.
  expect(() =>
    f.history.around(f.run, { messageId: "message-3", limit: 1, cursor: older.nextCursor }),
  ).toThrow("needs its direction");
  expect(() =>
    f.history.around(f.run, {
      messageId: "message-3",
      direction: "after",
      limit: 1,
      cursor: older.nextCursor,
    }),
  ).toThrow("another anchor, direction or query");
});

it("around binds a continuation to its anchor, direction and query instead of reusing another page", () => {
  const f = setup(),
    room = f.messages.references.createConversation("channel", "internal", "around-binding").id;
  f.messages.membership("research", room, true);
  for (let n = 1; n <= 5; n++) f.messages.recordHistory(message(room, n), []);
  const later = f.history.around(f.run, { messageId: "message-3", direction: "after", limit: 1 });
  expect(() =>
    f.history.around(f.run, {
      messageId: "message-3",
      direction: "before",
      limit: 1,
      cursor: later.nextCursor!,
    }),
  ).toThrow("another anchor, direction or query");
  expect(() =>
    f.history.around(f.run, {
      messageId: "message-4",
      direction: "after",
      limit: 1,
      cursor: later.nextCursor!,
    }),
  ).toThrow("another anchor, direction or query");
  expect(() =>
    f.history.around(f.run, {
      messageId: "message-3",
      direction: "after",
      limit: 1,
      cursor: (
        f.history.page(f.run, { target: { conversationId: room }, limit: 1 }) as {
          nextCursor: string;
        }
      ).nextCursor,
    }),
  ).toThrow("another anchor, direction or query");
});

it("an around walk past a deleted block keeps going instead of reading the same rows again", () => {
  const f = setup(),
    room = f.messages.references.createConversation("channel", "internal", "deleted-walk").id;
  f.messages.membership("research", room, true);
  // The only live row sits below 1000 rows that are no longer visible.
  f.messages.recordHistory({ ...message(room, 1, "the live one") }, []);
  f.messages.recordHistory({ ...message(room, 2), deleted: true }, []);
  for (let n = 3; n <= 1003; n++)
    f.messages.recordHistory({ ...message(room, n), deleted: true }, []);
  f.messages.recordHistory({ ...message(room, 1004, "the anchor") }, []);
  const walk = (input: Record<string, unknown>) =>
    f.history.around(f.run, {
      messageId: "message-1004",
      direction: "before",
      limit: 1,
      ...input,
    }) as { messages: MessageDTO[]; nextCursor: string | null; coverage: { scanned: number } };
  const empty = walk({});
  expect(empty.messages).toEqual([]);
  expect(empty.coverage.scanned).toBe(1000);
  expect(empty.nextCursor).toBeTruthy();
  // The continuation advances past the rows the empty page examined instead of rereading them.
  const live = walk({ cursor: empty.nextCursor! });
  expect(live.messages.map((item) => item.id)).toEqual(["message-1"]);
  expect(live.nextCursor).toBeNull();
});

it("a page that ends exactly on the last row reports no continuation, while a truncated one does", () => {
  const f = setup(),
    room = f.messages.references.createConversation("channel", "internal", "exact-fit").id;
  f.messages.membership("research", room, true);
  for (let n = 1; n <= 3; n++) f.messages.recordHistory(message(room, n), []);
  const exact = f.history.page(f.run, { target: { conversationId: room }, limit: 3 });
  expect(exact.messages.map((item) => item.id)).toEqual(["message-3", "message-2", "message-1"]);
  expect(exact.coverage).toMatchObject({ exhausted: true, scanLimited: false });
  expect(exact.nextCursor).toBeNull();
  f.messages.recordHistory(message(room, 4), []);
  const truncated = f.history.page(f.run, { target: { conversationId: room }, limit: 3 });
  expect(truncated.messages.map((item) => item.id)).toEqual([
    "message-4",
    "message-3",
    "message-2",
  ]);
  expect(truncated.coverage).toMatchObject({ exhausted: false });
  expect(truncated.nextCursor).toBeTruthy();
});

it("global search walks multiple conversations in stable order without repeating a cursor boundary", () => {
  const f = setup(),
    first = f.messages.references.createConversation("channel", "internal", "a-room").id,
    second = f.messages.references.createConversation("channel", "internal", "b-room").id;
  f.messages.membership("research", first, true);
  f.messages.membership("research", second, true);
  f.messages.recordHistory(message(first, 10, "cross room"), []);
  f.messages.recordHistory(message(first, 11, "cross room"), []);
  f.messages.recordHistory(message(second, 20, "cross room"), []);
  const page = f.history.search(f.run, { query: "cross room", limit: 2 });
  expect(page.messages.map((item) => item.id)).toEqual(["message-11", "message-10"]);
  expect(page.nextCursor).toBeTruthy();
  const next = f.history.search(f.run, { query: "cross room", limit: 2, cursor: page.nextCursor! });
  expect(next.messages.map((item) => item.id)).toEqual(["message-20"]);
  expect(next.nextCursor).toBeNull();
});

it("bounded search exposes a continuation even when the scanned batch has no matches", () => {
  const f = setup(),
    room = f.messages.references.createConversation("channel", "internal", "large-room").id;
  f.messages.membership("research", room, true);
  for (let n = 1; n <= 1001; n++)
    f.messages.recordHistory(message(room, n, "ordinary history"), []);
  const first = f.history.search(f.run, {
    target: { conversationId: room },
    query: "only oldest matches",
    limit: 1,
  });
  // An empty page is not the end: the match is older than the scanned batch.
  expect(first.messages).toEqual([]);
  expect(first.nextCursor).toBeTruthy();
  expect(first.coverage).toMatchObject({ scanLimited: true, exhausted: false, scanned: 1000 });
  f.messages.recordHistory({ ...message(room, 1, "only oldest matches"), revision: "1002" }, []);
  const second = f.history.search(f.run, {
    target: { conversationId: room },
    query: "only oldest matches",
    limit: 1,
    cursor: first.nextCursor!,
  });
  expect(second.messages.map((item) => item.id)).toEqual(["message-1"]);
});

it("remote acquisition grants an exact older revision without leaking a newer global cache entry", async () => {
  let returned: MessageDTO[] = [];
  const source: HistorySource = {
    fetch: async () => ({
      messages: returned,
      nextCursor: "provider-next",
      exhausted: false,
      scope: "channel_top_level",
      gaps: [],
      available: true,
    }),
  };
  const f = setup(source),
    cached = message(f.external, 20, "new cache");
  f.messages.recordHistory({ ...cached, revision: "30" }, []);
  returned = [
    { ...cached, revision: "29", text: "older provider body" },
    message(f.external, 21, "provider result"),
  ];
  const page = await f.history.fetch(
    f.run,
    { target: { conversationId: f.external }, limit: 20 },
    new AbortController().signal,
  );
  expect(page.messages.map((item) => item.id)).toEqual(["message-20", "message-21"]);
  expect(page.coverage).toMatchObject({ exhausted: false, gaps: [] });
  expect(f.messages.records.message("message-20")?.text).toBe("new cache");
  expect(f.messages.message("research", "message-20").text).toBe("older provider body");
  expect(f.messages.message("research", "message-21").text).toBe("provider result");
  expect(page.nextCursor).toBeTruthy();
});

it("remote scope exhaustion remains true when one item has a gap, and another valid item still commits", async () => {
  const source: HistorySource = {
    fetch: async () => ({
      messages: [{ ...message("wrong-room", 40) }, message("wrong-room", 41)],
      nextCursor: null,
      exhausted: true,
      scope: "channel_top_level",
      gaps: ["provider_filter_gap"],
      available: true,
    }),
  };
  const f = setup(source);
  const valid = message(f.external, 41);
  (source.fetch as any) = async () => ({
    messages: [valid, { ...message(f.external, 40), rootId: "conflicting-root" }],
    nextCursor: null,
    exhausted: true,
    scope: "channel_top_level",
    gaps: ["provider_filter_gap"],
    available: true,
  });
  f.messages.references.createMessage(f.external, "message-40", "message-40");
  const page = await f.history.fetch(
    f.run,
    { target: { conversationId: f.external }, limit: 20 },
    new AbortController().signal,
  );
  expect(page.messages.map((item) => item.id)).toEqual(["message-41"]);
  expect(page.coverage).toMatchObject({
    exhausted: true,
    gaps: ["provider_filter_gap", "message_import_failed"],
  });
  expect(f.messages.records.message("message-40")).toBeUndefined();
  expect(f.messages.records.message("message-41")).toBeDefined();
});

it("rejects an internally inconsistent source continuation contract", async () => {
  const source: HistorySource = {
    fetch: async () => ({
      messages: [],
      nextCursor: "impossible",
      exhausted: true,
      scope: "channel_top_level",
      gaps: [],
      available: true,
    }),
  };
  const f = setup(source);
  await expect(
    f.history.fetch(
      f.run,
      { target: { conversationId: f.external }, limit: 20 },
      new AbortController().signal,
    ),
  ).rejects.toThrow("continuation after exhaustion");
});

it("one installation cannot advance another installation visible revision or freshness view", async () => {
  const peer = {
    ...structuredClone(configFixture.agents[0]!),
    id: "peer",
    name: "Peer",
    slackAppId: "ATWO",
    slackUserId: "UTWO",
    slackBotId: "BTWO",
    botTokenEnv: "PEER_BOT_TOKEN",
    appTokenEnv: "PEER_APP_TOKEN",
  };
  const config = { ...configFixture, agents: [configFixture.agents[0]!, peer] };
  let remote: MessageDTO[] = [];
  const source: HistorySource = {
    fetch: async () => ({
      messages: remote,
      nextCursor: null,
      exhausted: true,
      scope: "channel_top_level",
      gaps: [],
      available: true,
    }),
  };
  const store = new Store(":memory:");
  stores.push(store);
  const { messages, mapper } = slackApplication(store, config);
  for (const actor of ["research", "peer"]) {
    store.register(actor, "history", []);
    store.enqueue(actor, "start", {});
  }
  const research = store.beginRun("research")!,
    peerRun = store.beginRun("peer")!;
  store.input(research, {});
  store.input(peerRun, {});
  const external = mapper.conversation("CTEST");
  messages.membership("research", external, true);
  messages.membership("peer", external, true);
  const first = message(external, 50, "revision one");
  messages.record(first, ["research", "peer"]);
  const output = new CanonicalOutput(messages, {
      post: async () => {
        throw new Error("offline");
      },
      pendingInput: () => false,
      classify: () => ({ kind: "unknown" }),
    }),
    collaboration = new Collaboration(store, messages, output, config);
  const target = { conversationId: external, threadId: first.id },
    view = collaboration.attention.read(peerRun, target) as { viewToken: string };
  collaboration.attention.presented(peerRun, {
    role: "toolResult",
    toolCallId: "read",
    toolName: "mate",
    content: [{ type: "text", text: JSON.stringify(view) }],
    isError: false,
    timestamp: 0,
  });
  remote = [{ ...first, attachments: [{ id: "FSECRET", name: "secret.txt" }] }];
  const history = new ConversationHistory(messages, source);
  await history.fetch(
    research,
    { target: { conversationId: external }, limit: 20 },
    new AbortController().signal,
  );
  expect(messages.message("research", first.id).attachments).toEqual([
    { id: "FSECRET", name: "secret.txt" },
  ]);
  expect(messages.message("peer", first.id).attachments).toEqual([]);
  expect(collaboration.attention.valid(peerRun, target, view.viewToken)).toBe(true);
  remote = [{ ...first, revision: "52", text: "revision three" }];
  await history.fetch(
    research,
    { target: { conversationId: external }, limit: 20 },
    new AbortController().signal,
  );
  expect(messages.records.message(first.id)?.text).toBe("revision three");
  expect(messages.message("research", first.id).text).toBe("revision three");
  expect(messages.message("peer", first.id).text).toBe("revision one");
  expect(collaboration.attention.valid(peerRun, target, view.viewToken)).toBe(true);
  remote = [{ ...first, revision: "51", text: "revision two" }];
  await history.fetch(
    peerRun,
    { target: { conversationId: external }, limit: 20 },
    new AbortController().signal,
  );
  expect(messages.records.message(first.id)?.text).toBe("revision three");
  expect(messages.message("peer", first.id).text).toBe("revision two");
  remote = [{ ...first, revision: "53", text: "", deleted: true }];
  await history.fetch(
    research,
    { target: { conversationId: external }, limit: 20 },
    new AbortController().signal,
  );
  expect(messages.records.message(first.id)?.deleted).toBe(true);
  expect(messages.message("peer", first.id)).toMatchObject({
    text: "revision two",
    deleted: false,
  });
  expect(messages.read("peer", target)).toHaveLength(1);
  const peerHistory = new ConversationHistory(messages);
  expect(
    peerHistory
      .search(peerRun, { target: { conversationId: external }, query: "revision two", limit: 20 })
      .messages.map((item) => item.id),
  ).toEqual([first.id]);
  expect(
    peerHistory
      .page(peerRun, { target: { conversationId: external }, limit: 20 })
      .messages.map((item) => item.id),
  ).toEqual([first.id]);
});

it("revocation or run fencing while a source is in flight prevents any returned content from committing", async () => {
  let release!: (page: any) => void;
  const source: HistorySource = {
    fetch: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  };
  const f = setup(source),
    pending = f.history.fetch(
      f.run,
      { target: { conversationId: f.external }, limit: 20 },
      new AbortController().signal,
    );
  f.messages.membership("research", f.external, false);
  release({
    messages: [message(f.external, 31)],
    nextCursor: null,
    exhausted: true,
    scope: "channel_top_level",
    gaps: [],
    available: true,
  });
  await expect(pending).rejects.toThrow("access");
  expect(f.messages.records.message("message-31")).toBeUndefined();
});

it("withdrawn permission is applied to the next page, search, around and fetch instead of a cached grant", async () => {
  const source: HistorySource = {
    fetch: async () => ({
      messages: [message("CTEST", 40)],
      nextCursor: null,
      exhausted: true,
      scope: "channel_top_level",
      gaps: [],
      available: true,
    }),
  };
  const f = setup(source),
    room = f.messages.references.createConversation("channel", "internal", "revoked-room").id;
  f.messages.membership("research", room, true);
  for (let n = 1; n <= 3; n++) f.messages.recordHistory(message(room, n), []);
  f.messages.recordHistory(message(f.external, 4), ["research"]);
  const opened = f.history.page(f.run, { target: { conversationId: room }, limit: 1 });
  expect(opened.messages.map((item) => item.id)).toEqual(["message-3"]);
  const openedAround = f.history.around(f.run, { messageId: "message-3", before: 1, after: 1 });
  expect(openedAround.messages.map((item) => item.id)).toEqual(["message-2", "message-3"]);
  f.messages.membership("research", room, false);
  expect(() =>
    f.history.page(f.run, {
      target: { conversationId: room },
      limit: 1,
      cursor: opened.nextCursor!,
    }),
  ).toThrow("denied");
  expect(() =>
    f.history.search(f.run, { target: { conversationId: room }, query: "message", limit: 1 }),
  ).toThrow("denied");
  expect(() =>
    f.history.around(f.run, { messageId: "message-3", direction: "before", limit: 1 }),
  ).toThrow("denied");
  f.messages.membership("research", f.external, false);
  await expect(
    f.history.fetch(
      f.run,
      { target: { conversationId: f.external }, limit: 20 },
      new AbortController().signal,
    ),
  ).rejects.toThrow("denied");
});

it("a continuation reads current visibility instead of the grant the page was opened under", () => {
  const f = setup();
  for (const n of [1, 2, 3, 4, 5, 6])
    f.messages.recordHistory(message(f.external, n), ["research"]);
  const opening = f.history.page(f.run, { target: { conversationId: f.external }, limit: 2 });
  expect(opening.messages.map((item) => item.id)).toEqual(["message-6", "message-5"]);
  f.store.db
    .prepare("DELETE FROM message_visibility WHERE agent_id='research' AND key='message-3'")
    .run();
  const next = f.history.page(f.run, {
    target: { conversationId: f.external },
    limit: 2,
    cursor: opening.nextCursor!,
  });
  expect(next.messages.map((item) => item.id)).toEqual(["message-4", "message-2"]);
  const last = f.history.page(f.run, {
    target: { conversationId: f.external },
    limit: 2,
    cursor: next.nextCursor!,
  });
  expect(last.messages.map((item) => item.id)).toEqual(["message-1"]);
  expect(last.nextCursor).toBeNull();
});

it("a quiet history read is live, marks nothing presented and produces no freshness credential", () => {
  const f = setup(),
    room = f.messages.references.createConversation("channel", "internal", "quiet-read").id,
    output = new CanonicalOutput(f.messages, {
      post: async () => {
        throw new Error("offline");
      },
      pendingInput: () => false,
      classify: () => ({ kind: "unknown" }),
    }),
    collaboration = new Collaboration(f.store, f.messages, output, configFixture);
  f.messages.membership("research", room, true);
  for (let n = 1; n <= 3; n++) f.messages.recordHistory(message(room, n), []);
  const counted = (table: string) =>
    (f.store.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
  const deliveries = counted("deliveries"),
    observations = counted("message_observations"),
    page = f.history.page(f.run, { target: { conversationId: room }, limit: 2 }) as Record<
      string,
      unknown
    >;
  expect(page).not.toHaveProperty("viewToken");
  expect(page).not.toHaveProperty("revision");
  const journaled: AgentMessage = {
    role: "toolResult",
    toolCallId: "page",
    toolName: "mate",
    content: [{ type: "text", text: JSON.stringify(page) }],
    isError: false,
    timestamp: 0,
  };
  // The journal reports every tool result; a page without a viewToken presents nothing.
  collaboration.attention.presented(f.run, journaled);
  expect(f.store.db.prepare("SELECT count(*) n FROM attention_presented").get()).toEqual({ n: 0 });
  expect(f.store.db.prepare("SELECT count(*) n FROM attention_seen").get()).toEqual({ n: 0 });
  expect(counted("deliveries")).toBe(deliveries);
  expect(counted("message_observations")).toBe(observations);
  expect(collaboration.attention.peek("research")).toEqual([]);
  // A later query sees the newest message, so the read never froze the earlier result set.
  f.messages.recordHistory(message(room, 4, "arrived later"), []);
  expect(
    f.history
      .page(f.run, { target: { conversationId: room }, limit: 1 })
      .messages.map((item) => item.text),
  ).toEqual(["arrived later"]);
});

it("a quiet history read that discovers a change invalidates an older credential without advancing read state", () => {
  const f = setup(),
    output = new CanonicalOutput(f.messages, {
      post: async () => {
        throw new Error("offline");
      },
      pendingInput: () => false,
      classify: () => ({ kind: "unknown" }),
    }),
    collaboration = new Collaboration(f.store, f.messages, output, configFixture),
    first = message(f.external, 10, "the original conclusion");
  f.messages.recordHistory(first, ["research"]);
  const target = { conversationId: f.external, threadId: first.id },
    view = collaboration.attention.read(f.run, target) as { viewToken: string };
  collaboration.attention.presented(f.run, {
    role: "toolResult",
    toolCallId: "attention",
    toolName: "mate",
    content: [{ type: "text", text: JSON.stringify(view) }],
    isError: false,
    timestamp: 0,
  });
  expect(collaboration.attention.valid(f.run, target, view.viewToken)).toBe(true);
  expect(
    f.store.db
      .prepare("SELECT revision FROM attention_seen WHERE agent_id=? AND key=?")
      .get("research", first.id),
  ).toEqual({ revision: "10" });
  const counted = (table: string) =>
    (f.store.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
  const deliveries = counted("deliveries"),
    observations = counted("message_observations");
  // The quiet read discovers the edit, so the older credential no longer describes the room.
  f.messages.recordHistory({ ...first, revision: "11", text: "quietly revised" }, ["research"]);
  f.history.page(f.run, { target: { conversationId: f.external }, limit: 20 });
  expect(collaboration.attention.valid(f.run, target, view.viewToken)).toBe(false);
  expect(
    f.store.db
      .prepare("SELECT revision FROM attention_seen WHERE agent_id=? AND key=?")
      .get("research", first.id),
  ).toEqual({ revision: "10" });
  expect(counted("deliveries")).toBe(deliveries);
  expect(counted("message_observations")).toBe(observations);
  expect(collaboration.attention.peek("research")).toEqual([]);
});
