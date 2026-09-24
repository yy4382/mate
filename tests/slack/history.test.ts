import { afterEach, expect, it, vi } from "vitest";
import type { WebClient } from "@slack/web-api";
import { Store } from "../../src/storage/store.js";
import { slackApplication } from "../../src/slack/application.js";
import { CanonicalSlackTransport } from "../../src/slack/transport.js";
import { SlackHistory } from "../../src/slack/history.js";
import { configFixture } from "../helpers/config.js";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
function setup() {
  const store = new Store(":memory:");
  stores.push(store);
  store.register("research", "history", []);
  const { messages, mapper } = slackApplication(store, configFixture),
    conversationId = mapper.conversation("CTEST");
  messages.membership("research", conversationId, true);
  store.enqueue("research", "start", {});
  const run = store.beginRun("research")!;
  store.input(run, {});
  const transport = new CanonicalSlackTransport(store, mapper, {});
  const api: any = {
    info: vi.fn(async () => ({ ok: true, channel: { id: "CTEST", is_member: true } })),
    history: vi.fn(async () => ({
      ok: true,
      messages: [
        { ts: "3.000001", text: "third", user: "UOWNER" },
        { ts: "2.000001", text: "second", user: "UOWNER" },
      ],
      response_metadata: { next_cursor: "next" },
    })),
    replies: vi.fn(async () => ({
      ok: true,
      messages: [],
      has_more: true,
      response_metadata: { next_cursor: "" },
    })),
  };
  transport.clients.set("research", { conversations: api } as unknown as WebClient);
  return {
    store,
    messages,
    mapper,
    conversationId,
    run,
    transport,
    api,
    history: new SlackHistory(messages, transport),
  };
}

it("uses the acting installation, maps a bounded page, and reports provider continuation gaps", async () => {
  const f = setup(),
    page = await f.history.fetch(
      f.run,
      { conversationId: f.conversationId },
      { limit: 1 },
      new AbortController().signal,
    );
  expect(f.api.info).toHaveBeenCalledWith({ channel: "CTEST" });
  expect(f.api.history).toHaveBeenCalledWith(
    expect.objectContaining({ channel: "CTEST", limit: 1, include_all_metadata: true }),
  );
  expect(page.messages).toHaveLength(1);
  expect(page.messages[0]).toMatchObject({ text: "third", order: "3000001" });
  expect(page).toMatchObject({
    nextCursor: "next",
    exhausted: false,
    scope: "channel_top_level",
    available: true,
    gaps: ["provider_page_exceeded_limit"],
  });
  f.api.history.mockResolvedValueOnce({
    ok: true,
    messages: [],
    has_more: true,
    response_metadata: { next_cursor: "" },
  });
  const missing = await f.history.fetch(
    f.run,
    { conversationId: f.conversationId },
    { limit: 10 },
    new AbortController().signal,
  );
  expect(missing.gaps).toContain("provider_continuation_missing");
  expect(missing.exhausted).toBe(false);
});

it("translates canonical anchors and thread roots without exposing provider identifiers to the core", async () => {
  const f = setup(),
    root = f.mapper.message({
      channel: "CTEST",
      ts: "1.000001",
      revision: "1.000001",
      text: "root",
      user: "UOWNER",
      deleted: false,
    });
  const later = f.mapper.message({
    channel: "CTEST",
    ts: "4.000001",
    thread: "1.000001",
    revision: "4.000001",
    text: "later",
    user: "UOWNER",
    deleted: false,
  });
  f.messages.recordHistory(root, ["research"]);
  f.messages.recordHistory(later, ["research"]);
  f.api.replies.mockResolvedValueOnce({
    ok: true,
    messages: [{ ts: "3.000001", thread_ts: "1.000001", text: "reply", user: "UOWNER" }],
    has_more: false,
    response_metadata: { next_cursor: "" },
  });
  const page = await f.history.fetch(
    f.run,
    { conversationId: f.conversationId, threadId: root.id },
    { limit: 10, before: later.id },
    new AbortController().signal,
  );
  expect(f.api.replies).toHaveBeenCalledWith(
    expect.objectContaining({ channel: "CTEST", ts: "1.000001", latest: "4.000001" }),
  );
  expect(page.messages[0]).toMatchObject({
    conversationId: f.conversationId,
    rootId: root.id,
    text: "reply",
  });
  expect(page.scope).toBe("thread");
});

it("fails closed when membership changes during an awaited provider call", async () => {
  const f = setup();
  let release!: (value: any) => void;
  f.api.history.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.history.fetch(
    f.run,
    { conversationId: f.conversationId },
    { limit: 10 },
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(f.api.history).toHaveBeenCalledOnce());
  f.messages.membership("research", f.conversationId, false);
  release({
    ok: true,
    messages: [{ ts: "3.000001", text: "late", user: "UOWNER" }],
    has_more: false,
    response_metadata: { next_cursor: "" },
  });
  await expect(pending).rejects.toThrow(/access|membership changed/);
});

it("returns explicit unavailability for missing installations and provider failures", async () => {
  const f = setup();
  f.transport.clients.delete("research");
  expect(
    await f.history.fetch(
      f.run,
      { conversationId: f.conversationId },
      { limit: 10 },
      new AbortController().signal,
    ),
  ).toMatchObject({
    available: false,
    exhausted: false,
    gaps: ["Agent has no Slack history installation"],
  });
  f.transport.clients.set("research", { conversations: f.api } as unknown as WebClient);
  f.api.info.mockRejectedValueOnce({ data: { error: "missing_scope" } });
  expect(
    await f.history.fetch(
      f.run,
      { conversationId: f.conversationId },
      { limit: 10 },
      new AbortController().signal,
    ),
  ).toMatchObject({ available: false, gaps: ["Slack history unavailable: missing_scope"] });
});

it("rejects live-event wrappers defensively instead of importing blank history messages", async () => {
  const f = setup();
  f.api.history.mockResolvedValueOnce({
    ok: true,
    messages: [
      {
        type: "message",
        subtype: "message_deleted",
        deleted_ts: "3.000001",
        message: { ts: "3.000001", text: "old" },
      },
      {
        type: "message",
        subtype: "message_replied",
        hidden: true,
        ts: "2.000001",
        message: { ts: "2.000001" },
      },
      { type: "channel_join", ts: "1.000001" },
    ],
    has_more: false,
    response_metadata: { next_cursor: "" },
  });
  const page = await f.history.fetch(
    f.run,
    { conversationId: f.conversationId },
    { limit: 10 },
    new AbortController().signal,
  );
  expect(page.messages).toEqual([]);
  expect(page.gaps).toEqual([
    "unexpected_history_event",
    "unexpected_history_event",
    "unexpected_history_event",
  ]);
});
