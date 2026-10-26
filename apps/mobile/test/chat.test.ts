import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatApp } from "@mate/chat";
import type { Clock } from "@mate/clock";
import { type TimelineRef } from "@mate/chat/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { MobileChat, type ChatPlatform, type ChatState } from "../src/chat.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function until(chat: MobileChat, condition: (state: ChatState) => boolean): Promise<void> {
  if (condition(chat.getSnapshot())) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = chat.subscribe(() => {
      if (condition(chat.getSnapshot())) {
        stop();
        resolve();
      }
    });
  });
}
function fixture(clock?: Clock) {
  const directory = mkdtempSync(join(tmpdir(), "mate-chat-test-"));
  const server = new ChatApp(join(directory, "chat.sqlite"));
  const me = server.ensureAccount({
    externalId: "me",
    displayName: "小明",
    handle: "ming",
    kind: "human",
  });
  const other = server.ensureAccount({
    externalId: "other",
    displayName: "小文",
    handle: "wen",
    kind: "human",
  });
  const channel = server.createChannel(me, {
    requestId: "channel",
    name: "general",
    visibility: "public",
  });
  server.join(other, { requestId: "join", conversationId: channel.conversationId });
  const ref = { conversation: channel.conversationId };
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const urls: string[] = [];
  const writes: { requestId: string; body: string; mentions?: number[] }[] = [];
  let failSend = false;
  let heldHistory: ReturnType<typeof deferred<Response>> | undefined;
  let snapshotGate: ReturnType<typeof deferred<Response>> | undefined;
  let lastCursor = "";
  let expired = 0;
  const respond = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname.endsWith("/snapshot")) {
      if (snapshotGate) return snapshotGate.promise;
      return respond(server.liveSnapshot(me, {}));
    }
    if (url.pathname.endsWith("/history")) {
      if (heldHistory) return heldHistory.promise;
      const thread = url.searchParams.get("thread");
      const timeline =
        thread === null
          ? { conversation: Number(url.searchParams.get("conversation")) }
          : { thread: Number(thread) };
      const before = url.searchParams.get("before");
      return respond(
        server.readHistory(me, timeline, {
          ...(before === null ? {} : { before: Number(before) }),
          limit: Number(url.searchParams.get("limit") ?? 50),
        }),
      );
    }
    if (url.pathname.endsWith("/messages")) {
      writes.push(body);
      const result = server.send(me, body.timeline, { ...body, freshness: false });
      if (failSend) {
        failSend = false;
        throw new TypeError("response lost");
      }
      return respond(result);
    }
    if (url.pathname.endsWith("/read")) return respond(server.readUnread(me, body.timeline, body));
    if (url.pathname.endsWith("/search"))
      return respond(server.search(me, url.searchParams.get("q") ?? ""));
    throw new Error(`unexpected ${url.pathname}`);
  };
  const platform: ChatPlatform = {
    ...(clock === undefined ? {} : { clock }),
    fetch: transport,
    stream: async (input, init) => {
      urls.push(String(input));
      lastCursor = new URL(String(input)).searchParams.get("cursor") ?? "";
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), {
            once: true,
          });
        },
        cancel() {
          stream = undefined;
        },
      });
      return new Response(body);
    },
    requestId: () => crypto.randomUUID(),
    expired: () => {
      expired++;
    },
  };
  const chat = new MobileChat("https://test.example", platform);
  cleanups.push(
    () => rmSync(directory, { recursive: true, force: true }),
    () => server.close(),
    () => chat.close(),
  );
  const emit = (event: string, data: unknown) => {
    stream?.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };
  return {
    chat,
    server,
    me,
    other,
    ref,
    writes,
    urls,
    platform,
    get expired() {
      return expired;
    },
    start: async () => {
      chat.start();
      await until(chat, (s) => s.connection === "live");
    },
    push: () => {
      const batch = server.liveEvents(me, lastCursor);
      if (batch.status === "events") lastCursor = batch.cursor;
      emit("events", batch);
    },
    emit,
    failNextSend: () => {
      failSend = true;
    },
    holdHistory: () => {
      heldHistory = deferred<Response>();
      return heldHistory;
    },
    holdSnapshot: () => {
      snapshotGate = deferred<Response>();
      return snapshotGate;
    },
  };
}

describe("native chat public interface", () => {
  it("retains the original send request after a lost response and preserves text typed during delivery", async () => {
    const f = fixture();
    await f.start();
    await f.chat.load(f.ref);
    f.chat.edit(f.ref, "给 @wen 的消息");
    f.failNextSend();
    await f.chat.send(f.ref);
    expect(f.chat.draft(f.ref).pending?.status).toBe("failed");
    f.chat.edit(f.ref, "给 @wen 的消息\n接着写的草稿");
    await f.chat.send(f.ref);
    expect(f.writes).toHaveLength(2);
    expect(f.writes[0]?.requestId).toBe(f.writes[1]?.requestId);
    expect(f.writes[0]?.mentions).toEqual([f.other]);
    expect(f.server.readHistory(f.me, f.ref, {}).filter((e) => e.kind === "message")).toHaveLength(
      1,
    );
    expect(f.chat.draft(f.ref)).toMatchObject({ text: "接着写的草稿", pending: null, error: "" });
  });
  it("merges events arriving during history loading and replays without duplicate messages", async () => {
    const f = fixture();
    await f.start();
    const held = f.holdHistory();
    const loading = f.chat.load(f.ref);
    const entry = f.server.send(f.other, f.ref, {
      requestId: "other-send",
      body: "实时中文消息",
      freshness: false,
    });
    f.push();
    await until(f.chat, (s) => s.timelines.get(`c${f.ref.conversation}`)?.entries.length === 1);
    const history = f.server.readHistory(f.me, f.ref, {});
    held.resolve(new Response(JSON.stringify(history)));
    await loading;
    f.emit("events", {
      status: "events",
      events: [
        {
          cursor: "replay",
          type: "entry",
          conversationId: f.ref.conversation,
          timeline: f.ref,
          entry: history[0],
        },
      ],
      cursor: "replay",
      unread: f.server.unreadSummary(f.me),
    });
    await until(f.chat, (s) => s.connection === "live");
    expect(f.chat.timeline(f.ref).entries).toHaveLength(1);
    expect(entry.status).toBe("sent");
  });
  it("keeps thread and channel drafts independent and advances unread only when asked", async () => {
    const f = fixture();
    await f.start();
    await f.chat.load(f.ref);
    f.chat.edit(f.ref, "频道草稿");
    const root = f.server.send(f.other, f.ref, {
      requestId: "root",
      body: "根消息",
      freshness: false,
    });
    if (root.status !== "sent") throw new Error("expected sent");
    const thread: TimelineRef = { thread: root.messageId };
    f.chat.edit(thread, "讨论串草稿");
    f.push();
    await until(f.chat, (s) => s.unread.total > 0);
    expect(f.chat.draft(f.ref).text).toBe("频道草稿");
    expect(f.chat.draft(thread).text).toBe("讨论串草稿");
    await f.chat.load(thread);
    await f.chat.send(thread);
    f.push();
    await until(f.chat, (s) => s.timelines.get(`t${root.messageId}`)?.entries.length === 1);
    expect(f.chat.timeline(thread).entries[0]).toMatchObject({
      kind: "message",
      body: "讨论串草稿",
    });
    await f.chat.markRead(f.ref);
    f.push();
    await until(f.chat, (s) => s.unread.total === 0);
    expect(await f.chat.search("根消息")).toMatchObject([{ body: "根消息" }]);
  });
  it("resumes from the last received cursor and catches messages sent while disconnected", async () => {
    const f = fixture();
    await f.start();
    await f.chat.load(f.ref);
    f.server.send(f.other, f.ref, { requestId: "before", body: "断线前", freshness: false });
    f.push();
    await until(f.chat, (s) => s.unread.total === 1);
    const first = f.urls[0];
    f.chat.pause();
    f.server.send(f.other, f.ref, { requestId: "away", body: "断线期间", freshness: false });
    await f.chat.resume();
    await until(f.chat, (s) => s.connection === "live");
    expect(f.urls.at(-1)).not.toBe(first);
    f.push();
    await until(f.chat, (s) => s.unread.total === 2);
    expect(
      f.chat
        .timeline(f.ref)
        .entries.filter((e) => e.kind === "message")
        .map((e) => e.body),
    ).toEqual(["断线前", "断线期间"]);
  });
  it("reloads a rejected cursor without losing drafts and ignores history from the old snapshot", async () => {
    const f = fixture();
    await f.start();
    f.chat.edit(f.ref, "保留草稿");
    const history = f.holdHistory();
    const loading = f.chat.load(f.ref);
    f.emit("resnapshot", {});
    await until(f.chat, (s) => s.connection === "loading");
    await until(f.chat, (s) => s.connection === "live");
    history.resolve(
      new Response(
        JSON.stringify([
          {
            kind: "message",
            seq: 1,
            messageId: 50,
            author: f.other,
            body: "旧历史",
            attachments: [],
            mentions: [],
            at: 1,
          },
        ]),
      ),
    );
    await loading;
    expect(f.chat.timeline(f.ref).entries).toEqual([]);
    expect(f.chat.draft(f.ref).text).toBe("保留草稿");
  });
  it("drops late snapshots, responses, messages and drafts when its identity closes", async () => {
    const f = fixture(),
      held = f.holdSnapshot();
    f.chat.start();
    f.chat.edit(f.ref, "旧账号草稿");
    f.chat.close();
    held.resolve(new Response(JSON.stringify(f.server.liveSnapshot(f.me, {}))));
    await Promise.resolve();
    await Promise.resolve();
    expect(f.chat.getSnapshot()).toMatchObject({
      connection: "closed",
      me: 0,
      accounts: [],
      conversations: [],
    });
    expect(f.chat.draft(f.ref).text).toBe("");
    expect(f.urls).toEqual([]);
  });
  it("loads older history without replacing the newest page or duplicating its entries", async () => {
    const f = fixture();
    for (let i = 0; i < 70; i++)
      f.server.send(f.other, f.ref, {
        requestId: `history-${i}`,
        body: `历史 ${i}`,
        freshness: false,
      });
    await f.start();
    await f.chat.load(f.ref);
    expect(f.chat.timeline(f.ref).entries).toHaveLength(50);
    await f.chat.load(f.ref, true);
    expect(f.chat.timeline(f.ref).entries).toHaveLength(70);
    expect(f.chat.timeline(f.ref).entries[0]).toMatchObject({ kind: "message", body: "历史 0" });
    expect(f.chat.timeline(f.ref).entries.at(-1)).toMatchObject({
      kind: "message",
      body: "历史 69",
    });
  });

  it("reconnects a silent stream after its heartbeat deadline instead of waiting forever", async () => {
    const waiting = new Set<{ ms: number | undefined; done(): void }>();
    const clock: Clock = {
      now: () => 0,
      sleep: (ms, signal) =>
        new Promise((resolve) => {
          const item = {
            ms,
            done: () => {
              waiting.delete(item);
              signal.removeEventListener("abort", item.done);
              resolve();
            },
          };
          if (signal.aborted) return resolve();
          waiting.add(item);
          signal.addEventListener("abort", item.done, { once: true });
        }),
    };
    const advance = (ms: number) => {
      for (const item of [...waiting]) if (item.ms !== undefined && item.ms <= ms) item.done();
    };
    const f = fixture(clock);
    await f.start();
    await f.chat.load(f.ref);
    f.chat.edit(f.ref, "断线时保留的草稿");
    advance(40_000);
    await until(f.chat, (s) => s.connection === "reconnecting");
    advance(500);
    await until(f.chat, (s) => s.connection === "live");
    expect(f.urls).toHaveLength(2);
    expect(f.chat.draft(f.ref).text).toBe("断线时保留的草稿");
  });

  it("ignores a history response that arrives after logout has closed the identity", async () => {
    const f = fixture();
    await f.start();
    const held = f.holdHistory();
    const loading = f.chat.load(f.ref);
    f.chat.close();
    held.resolve(new Response(JSON.stringify(f.server.readHistory(f.me, f.ref, {}))));
    await loading;
    expect(f.chat.getSnapshot().timelines.size).toBe(0);
    expect(f.chat.getSnapshot().connection).toBe("closed");
    expect(f.chat.getSnapshot().me).toBe(0);
  });

  it("asks authentication to revalidate when the server ends the cookie session", async () => {
    const f = fixture();
    await f.start();
    f.emit("login", {});
    await until(f.chat, () => f.expired === 1);
    expect(f.expired).toBe(1);
  });
});
