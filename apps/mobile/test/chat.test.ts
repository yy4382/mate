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
  let historyUnavailable = false;
  let historyRequests = 0;
  let lostOperation = "";
  let refuseOperation = false;
  const operationRequests: { path: string; requestId: string }[] = [];
  const operationResponse = (path: string, requestId: string, value: unknown) => {
    operationRequests.push({ path, requestId });
    if (lostOperation === path) {
      lostOperation = "";
      throw new TypeError("acknowledgement lost");
    }
    return respond(value);
  };
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
      historyRequests++;
      if (historyUnavailable)
        return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
      if (heldHistory) {
        const held = heldHistory;
        heldHistory = undefined;
        return held.promise;
      }
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
    if (url.pathname === "/api/chat/channels") {
      if (refuseOperation) {
        refuseOperation = false;
        operationRequests.push({ path: url.pathname, requestId: body.requestId });
        return new Response(JSON.stringify({ error: "invalid-input" }), { status: 400 });
      }
      return operationResponse(url.pathname, body.requestId, server.createChannel(me, body));
    }
    if (url.pathname === "/api/chat/dms")
      return operationResponse(url.pathname, body.requestId, server.openDm(me, body));
    if (url.pathname === "/api/chat/tasks")
      return operationResponse(
        url.pathname,
        body.requestId,
        server.createTask(me, { ...body, freshness: false }),
      );
    const changingTask = url.pathname.match(/^\/api\/chat\/tasks\/(\d+)\/change$/);
    if (changingTask)
      return operationResponse(
        url.pathname,
        body.requestId,
        server.changeTask(me, { ...body, taskId: Number(changingTask[1]), freshness: false }),
      );
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
    operationRequests,
    get historyRequests() {
      return historyRequests;
    },
    historyUnavailable: (value: boolean) => {
      historyUnavailable = value;
    },
    loseOperation: (path: string) => {
      lostOperation = path;
    },
    refuseNextOperation: () => {
      refuseOperation = true;
    },
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
    chunk: (bytes: Uint8Array) => stream?.enqueue(bytes),
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
  it("receives messages when CRLF and Chinese UTF-8 characters split across stream chunks", async () => {
    const f = fixture();
    await f.start();
    await f.chat.load(f.ref);
    const cursor = f.server.liveSnapshot(f.me, {}).cursor;
    for (const body of ["跨块中文消息一", "跨块中文消息二"])
      f.server.send(f.other, f.ref, { requestId: body, body, freshness: false });
    const batch = f.server.liveEvents(f.me, cursor);
    const frame = new TextEncoder().encode(
      `: heartbeat\r\nevent: events\r\ndata: ${JSON.stringify(batch)}\r\n\r\n`,
    );
    for (const byte of frame) f.chunk(Uint8Array.of(byte));
    await until(f.chat, (s) => s.timelines.get(`c${f.ref.conversation}`)?.entries.length === 2);
    expect(f.chat.timeline(f.ref).entries.map((e) => e.kind === "message" && e.body)).toEqual([
      "跨块中文消息一",
      "跨块中文消息二",
    ]);
    expect(f.chat.getSnapshot()).toMatchObject({
      connection: "live",
      error: "",
      unread: { total: 2 },
    });
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
  it("stops failed history loads until an explicit retry", async () => {
    const f = fixture();
    await f.start();
    f.historyUnavailable(true);
    await f.chat.load(f.ref);
    expect(f.chat.timeline(f.ref).error).not.toBe("");
    for (let attempt = 0; attempt < 125; attempt++) await f.chat.load(f.ref);
    expect(f.historyRequests).toBe(1);
    f.historyUnavailable(false);
    await f.chat.load(f.ref);
    expect(f.historyRequests).toBe(1);
    await f.chat.retryLoad(f.ref);
    expect(f.historyRequests).toBe(2);
    expect(f.chat.timeline(f.ref)).toMatchObject({ loaded: true, error: "" });
  });
  it("locates older channel and thread entries and reports unavailable destinations", async () => {
    const f = fixture();
    const root = f.server.send(f.other, f.ref, {
      requestId: "destination-root",
      body: "目标根消息",
      freshness: false,
    });
    if (root.status !== "sent") throw new Error("expected sent");
    const thread = { thread: root.messageId };
    for (let i = 0; i < 75; i++) {
      f.server.send(f.other, f.ref, {
        requestId: `channel-${i}`,
        body: `频道 ${i}`,
        freshness: false,
      });
      f.server.send(f.other, thread, {
        requestId: `thread-${i}`,
        body: `回复 ${i}`,
        freshness: false,
      });
    }
    await f.start();
    const cancel = new AbortController();
    expect(await f.chat.locate(f.ref, { seq: 1 }, cancel.signal)).toBe("found");
    expect(f.chat.timeline(f.ref).entries.find((e) => e.seq === 1)).toMatchObject({
      body: "目标根消息",
    });
    expect(await f.chat.locate(thread, { seq: 2 }, cancel.signal)).toBe("found");
    expect(f.chat.timeline(thread).entries.find((e) => e.seq === 2)).toMatchObject({
      body: "回复 1",
    });
    expect(await f.chat.locate(f.ref, { messageId: root.messageId }, cancel.signal)).toBe("found");
    expect(await f.chat.locate(thread, { seq: 900 }, cancel.signal)).toBe("missing");
    expect(await f.chat.locate(f.ref, { messageId: 9999 }, cancel.signal)).toBe("missing");
  });
  it("cancels an old destination without blocking a new destination on the same timeline", async () => {
    const f = fixture();
    await f.start();
    const held = f.holdHistory();
    const cancel = new AbortController();
    const locating = f.chat.locate(f.ref, { seq: 1 }, cancel.signal);
    cancel.abort();
    f.server.send(f.other, f.ref, { requestId: "new-target", body: "新目标", freshness: false });
    const next = f.chat.locate(f.ref, { seq: 1 }, new AbortController().signal);
    held.resolve(new Response(JSON.stringify([])));
    expect(await locating).toBe("cancelled");
    expect(await next).toBe("found");
    expect(f.historyRequests).toBe(2);
    expect(f.chat.timeline(f.ref).entries).toMatchObject([{ body: "新目标" }]);
  });
  it("does not reveal a late destination after the authenticated identity closes", async () => {
    const f = fixture();
    f.server.send(f.other, f.ref, {
      requestId: "private-target",
      body: "旧身份消息",
      freshness: false,
    });
    await f.start();
    const held = f.holdHistory();
    const locating = f.chat.locate(f.ref, { seq: 1 }, new AbortController().signal);
    f.chat.close();
    held.resolve(new Response(JSON.stringify(f.server.readHistory(f.me, f.ref, {}))));
    expect(await locating).toBe("cancelled");
    expect(f.chat.getSnapshot().timelines.size).toBe(0);
    expect(f.chat.getSnapshot().me).toBe(0);
  });
  it("retains task creation input and request identity across consumer dismissal and reopen", async () => {
    const f = fixture();
    const message = f.server.send(f.me, f.ref, {
      requestId: "task-root",
      body: "可重试任务",
      freshness: false,
    });
    if (message.status !== "sent") throw new Error("expected sent");
    await f.start();
    const input = { messageId: message.messageId, title: "保留任务" };
    f.loseOperation("/api/chat/tasks");
    await expect(f.chat.task(input)).rejects.toThrow();
    const reopened = f.chat.getSnapshot().operations.get(`task-create/${message.messageId}`);
    expect(reopened).toMatchObject({ status: "failed", input: { kind: "task-create", ...input } });
    await expect(f.chat.task({ ...input, title: "不能替换未确认操作" })).rejects.toThrow(
      "上次操作尚未确认",
    );
    const result = await f.chat.task(input);
    expect(result.status).toBe("applied");
    expect(f.operationRequests).toHaveLength(2);
    expect(f.operationRequests[0]?.requestId).toBe(f.operationRequests[1]?.requestId);
    expect(f.chat.getSnapshot().operations.size).toBe(0);
    const entries = f.server.readHistory(f.me, f.ref, {}).filter((e) => e.kind === "task");
    expect(entries).toHaveLength(1);
  });
  it("retains channel creation across reopen and releases it only after acknowledgement or refusal", async () => {
    const f = fixture();
    await f.start();
    const input = { kind: "channel" as const, name: "只创建一次", visibility: "private" as const };
    f.loseOperation("/api/chat/channels");
    await expect(f.chat.create(input)).rejects.toThrow();
    expect(f.chat.getSnapshot().operations.get("new-conversation")).toMatchObject({
      input,
      status: "failed",
    });
    const result = await f.chat.create(input);
    expect(f.server.listConversations(f.me).filter((c) => c.name === input.name)).toHaveLength(1);
    expect(f.operationRequests[0]?.requestId).toBe(f.operationRequests[1]?.requestId);
    expect(f.chat.getSnapshot().operations.size).toBe(0);
    f.refuseNextOperation();
    await expect(f.chat.create({ ...input, name: "被拒绝" })).rejects.toThrow();
    expect(f.chat.getSnapshot().operations.size).toBe(0);
    expect((await f.chat.create({ ...input, name: "修改后创建" })).conversationId).not.toBe(
      result.conversationId,
    );
    expect(f.operationRequests[2]?.requestId).not.toBe(f.operationRequests[3]?.requestId);
  });
  it("clears unresolved operations on identity close and rejects later retries", async () => {
    const f = fixture();
    await f.start();
    const input = { kind: "channel" as const, name: "不泄漏操作", visibility: "public" as const };
    f.loseOperation("/api/chat/channels");
    await expect(f.chat.create(input)).rejects.toThrow();
    expect(f.chat.getSnapshot().operations.size).toBe(1);
    f.chat.close();
    expect(f.chat.getSnapshot().operations.size).toBe(0);
    await expect(f.chat.create(input)).rejects.toThrow("登录已结束");
    expect(f.operationRequests).toHaveLength(1);
  });
});
