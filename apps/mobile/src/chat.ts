import { createParser } from "eventsource-parser";
import { systemClock, type Clock } from "@mate/clock";
import {
  ConversationView,
  Entry,
  LiveEvents,
  LiveSnapshot,
  ReadPage,
  SendResult,
  TaskResult,
  type AccountView,
  type TimelineRef,
  type UnreadSummary,
} from "@mate/chat/contracts";
import { z } from "zod";

export const timelineKey = (ref: TimelineRef) =>
  "conversation" in ref ? `c${ref.conversation}` : `t${ref.thread}`;
const query = (ref: TimelineRef) =>
  "conversation" in ref ? `conversation=${ref.conversation}` : `thread=${ref.thread}`;
type Pending = {
  requestId: string;
  body: string;
  mentions: number[];
  text: string;
  status: "sending" | "failed";
};
export type Draft = { text: string; pending: Pending | null; error: string };
const emptyDraft: Draft = { text: "", pending: null, error: "" };
export type Timeline = { entries: Entry[]; loading: boolean; error: string; loaded: boolean };
const emptyTimeline: Timeline = { entries: [], loading: false, error: "", loaded: false };
export type ChatState = {
  connection: "loading" | "live" | "reconnecting" | "paused" | "closed";
  error: string;
  me: number;
  accounts: AccountView[];
  conversations: ConversationView[];
  unread: UnreadSummary;
  timelines: ReadonlyMap<string, Timeline>;
  drafts: ReadonlyMap<string, Draft>;
};
export type ChatPlatform = {
  fetch: typeof fetch;
  stream: typeof fetch;
  requestId(): string;
  expired(): void;
  clock?: Clock;
};
class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const refusals: Record<string, string> = {
  "not-member": "请先加入频道。",
  archived: "频道已归档，只能阅读。",
  "invalid-input": "请检查输入内容。",
  "handle-taken": "这个名称已被使用。",
  "request-conflict": "请求内容已改变，请取消后重新操作。",
  "not-found": "找不到这个会话或消息。",
  "inactive-account": "这个账号已停用。",
};
const errorText = (error: unknown) =>
  error instanceof Refusal ? error.message : "无法连接服务器，请检查网络后重试。";
const merge = (old: readonly Entry[], entries: readonly Entry[]) =>
  [...new Map([...old, ...entries].map((e) => [e.seq, e])).values()].sort((a, b) => a.seq - b.seq);

/** One cookie identity owns this instance, including all in-flight work and drafts. */
export class MobileChat {
  private state: ChatState = {
    connection: "loading",
    error: "",
    me: 0,
    accounts: [],
    conversations: [],
    unread: { total: 0, mentions: 0, timelines: [] },
    timelines: new Map(),
    drafts: new Map(),
  };
  private listeners = new Set<() => void>();
  private lifetime = new AbortController();
  private live: AbortController | undefined;
  private cursor: string | undefined;
  private snapshotVersion = 0;
  private running: Promise<void> | undefined;
  private clock: Clock;
  constructor(
    readonly server: string,
    private platform: ChatPlatform,
  ) {
    this.clock = platform.clock ?? systemClock;
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(change: Partial<ChatState>) {
    if (this.lifetime.signal.aborted) return;
    this.state = { ...this.state, ...change };
    this.listeners.forEach((listener) => listener());
  }
  private async request<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    if (this.lifetime.signal.aborted) throw new Error("closed");
    const timeout = new AbortController();
    const signal = AbortSignal.any([this.lifetime.signal, timeout.signal]);
    void this.clock.sleep(15_000, signal).then(() => timeout.abort());
    try {
      const response = await this.platform.fetch(this.server + path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "include",
        signal,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      if (this.lifetime.signal.aborted) throw new Error("closed");
      await this.check(response);
      const value: unknown = response.status === 204 ? undefined : await response.json();
      if (this.lifetime.signal.aborted) throw new Error("closed");
      return schema.parse(value);
    } catch (error) {
      if (error instanceof Refusal) throw error;
      throw new Error(errorText(error));
    } finally {
      timeout.abort();
    }
  }
  private async check(response: Response) {
    if (response.ok) return;
    if (response.status === 401) {
      this.platform.expired();
      throw new Refusal(401, "登录已失效，请重新登录。");
    }
    const error = z
      .object({ error: z.string() })
      .safeParse(await response.json().catch(() => null));
    throw new Refusal(
      response.status,
      error.success
        ? (refusals[error.data.error] ?? "操作未完成，请检查权限和输入后重试。")
        : "服务器暂时无法处理，请重试。",
    );
  }
  start(): void {
    if (this.running || this.lifetime.signal.aborted) return;
    const controller = new AbortController();
    this.live = controller;
    this.publish({ connection: this.cursor === undefined ? "loading" : "reconnecting" });
    this.running = this.follow(controller.signal).finally(() => {
      this.running = undefined;
    });
  }
  pause(): void {
    this.live?.abort();
    this.publish({ connection: "paused" });
  }
  async resume(): Promise<void> {
    this.pause();
    await this.running;
    this.start();
  }
  close(): void {
    this.live?.abort();
    this.lifetime.abort();
    this.state = {
      ...this.state,
      connection: "closed",
      me: 0,
      error: "",
      accounts: [],
      conversations: [],
      timelines: new Map(),
      drafts: new Map(),
      unread: { total: 0, mentions: 0, timelines: [] },
    };
    this.listeners.forEach((listener) => listener());
    this.listeners.clear();
  }
  private async follow(signal: AbortSignal) {
    let failures = 0;
    while (!signal.aborted && !this.lifetime.signal.aborted) {
      const streamRequest = new AbortController();
      const streamSignal = AbortSignal.any([signal, streamRequest.signal]);
      let watchdog: AbortController | undefined;
      const touch = () => {
        watchdog?.abort();
        const next = new AbortController();
        watchdog = next;
        const waiting = AbortSignal.any([next.signal, streamSignal]);
        void this.clock.sleep(40_000, waiting).then(() => {
          if (!waiting.aborted) streamRequest.abort();
        });
      };
      try {
        if (this.cursor === undefined) {
          const snapshot = await this.request("/api/chat/snapshot", LiveSnapshot);
          if (signal.aborted) return;
          this.cursor = snapshot.cursor;
          this.publish({
            me: snapshot.me,
            accounts: snapshot.accounts,
            conversations: snapshot.conversations,
            unread: snapshot.unread,
            error: "",
          });
        }
        touch();
        const response = await this.platform.stream(
          `${this.server}/api/chat/events?cursor=${encodeURIComponent(this.cursor)}`,
          {
            credentials: "include",
            signal: streamSignal,
            headers: { accept: "text/event-stream" },
          },
        );
        if (signal.aborted || this.lifetime.signal.aborted) return;
        await this.check(response);
        if (!response.body) throw new Error("stream missing");
        this.publish({ connection: "live", error: "" });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let ended = false;
        const parser = createParser({
          onEvent: ({ event, data }) => {
            if (ended || signal.aborted || this.lifetime.signal.aborted) return;
            if (event === "login") {
              ended = true;
              this.platform.expired();
              this.publish({ connection: "paused" });
            } else if (event === "resnapshot") {
              ended = true;
              this.cursor = undefined;
              ++this.snapshotVersion;
              this.publish({ timelines: new Map(), connection: "loading" });
            } else if (event === "events") {
              const batch = LiveEvents.parse(JSON.parse(data));
              if (batch.status === "resnapshot") {
                ended = true;
                this.cursor = undefined;
                ++this.snapshotVersion;
                this.publish({ timelines: new Map(), connection: "loading" });
              } else {
                this.apply(batch);
                failures = 0;
                this.publish({ connection: "live", error: "" });
              }
            }
          },
        });
        try {
          for (;;) {
            const { value, done } = await reader.read();
            touch();
            if (signal.aborted || this.lifetime.signal.aborted) return;
            if (done) throw new Error("stream ended");
            parser.feed(decoder.decode(value, { stream: true }));
            if (ended) {
              if (this.cursor !== undefined) return;
              break;
            }
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      } catch (error) {
        if (signal.aborted || this.lifetime.signal.aborted) return;
        watchdog?.abort();
        streamRequest.abort();
        this.publish({ connection: "reconnecting", error: errorText(error) });
        await this.clock.sleep([500, 1000, 2000, 5000][Math.min(failures++, 3)], signal);
      } finally {
        watchdog?.abort();
        streamRequest.abort();
      }
    }
  }
  private apply(batch: Extract<LiveEvents, { status: "events" }>) {
    let accounts = this.state.accounts;
    let conversations = this.state.conversations;
    const timelines = new Map(this.state.timelines);
    for (const event of batch.events) {
      if (event.type === "entry") {
        const key = timelineKey(event.timeline);
        const old = timelines.get(key);
        if (old) timelines.set(key, { ...old, entries: merge(old.entries, [event.entry]) });
      } else if (event.type === "account") {
        accounts = [
          ...accounts.filter((a) => a.accountId !== event.account.accountId),
          event.account,
        ];
      } else if (event.type === "conversation") {
        conversations = [
          ...conversations.filter((c) => c.conversationId !== event.conversation.conversationId),
          event.conversation,
        ];
      }
    }
    this.cursor = batch.cursor;
    this.publish({ accounts, conversations, timelines, unread: batch.unread });
  }
  timeline(ref: TimelineRef): Timeline {
    return this.state.timelines.get(timelineKey(ref)) ?? emptyTimeline;
  }
  private setTimeline(ref: TimelineRef, value: Timeline) {
    this.publish({ timelines: new Map(this.state.timelines).set(timelineKey(ref), value) });
  }
  async load(ref: TimelineRef, older = false): Promise<void> {
    if (this.cursor === undefined) return;
    const version = this.snapshotVersion;
    const old = this.timeline(ref);
    if (old.loading || (!older && old.loaded)) return;
    this.setTimeline(ref, { ...old, loading: true, error: "" });
    try {
      const before = older ? old.entries[0]?.seq : undefined;
      const entries = await this.request(
        `/api/chat/history?${query(ref)}&limit=50${before === undefined ? "" : `&before=${before - 1}`}`,
        z.array(Entry),
      );
      if (version !== this.snapshotVersion) return;
      this.setTimeline(ref, {
        entries: merge(this.timeline(ref).entries, entries),
        loading: false,
        loaded: true,
        error: "",
      });
    } catch (error) {
      if (version !== this.snapshotVersion) return;
      this.setTimeline(ref, { ...this.timeline(ref), loading: false, error: errorText(error) });
    }
  }
  async markRead(ref: TimelineRef): Promise<void> {
    await this.request("/api/chat/read", ReadPage, {
      timeline: ref,
      requestId: this.platform.requestId(),
    });
  }
  draft(ref: TimelineRef): Draft {
    return this.state.drafts.get(timelineKey(ref)) ?? emptyDraft;
  }
  private setDraft(ref: TimelineRef, value: Draft) {
    this.publish({ drafts: new Map(this.state.drafts).set(timelineKey(ref), value) });
  }
  edit(ref: TimelineRef, text: string) {
    this.setDraft(ref, { ...this.draft(ref), text });
  }
  abandon(ref: TimelineRef) {
    this.setDraft(ref, { ...this.draft(ref), pending: null, error: "" });
  }
  async send(ref: TimelineRef): Promise<void> {
    const draft = this.draft(ref);
    if (draft.pending?.status === "sending" || (!draft.pending && !draft.text.trim())) return;
    const mentions = new Set<number>();
    for (const [, handle] of draft.text.matchAll(/@([\p{L}\p{N}][\p{L}\p{N}_.-]*)/gu)) {
      const account = this.state.accounts.find(
        (a) => a.active && a.handle.toLowerCase() === handle?.toLowerCase(),
      );
      if (account) mentions.add(account.accountId);
    }
    const pending: Pending = {
      ...(draft.pending ?? {
        requestId: this.platform.requestId(),
        body: draft.text.trim(),
        text: draft.text,
        mentions: [...mentions].sort((a, b) => a - b),
      }),
      status: "sending",
    };
    this.setDraft(ref, { ...draft, pending, error: "" });
    try {
      const result = await this.request("/api/chat/messages", SendResult, {
        timeline: ref,
        requestId: pending.requestId,
        body: pending.body,
        mentions: pending.mentions,
      });
      if (result.status !== "sent") throw new Error("held");
      const current = this.draft(ref);
      this.setDraft(ref, {
        text: current.text.startsWith(pending.text)
          ? current.text.slice(pending.text.length).trimStart()
          : current.text,
        pending: null,
        error: "",
      });
    } catch (error) {
      const refused = error instanceof Refusal && error.status >= 400 && error.status < 500;
      this.setDraft(ref, {
        ...this.draft(ref),
        pending: refused ? null : { ...pending, status: "failed" },
        error: errorText(error),
      });
    }
  }
  async search(text: string) {
    return this.request(`/api/chat/search?q=${encodeURIComponent(text)}`, z.array(Entry));
  }
  async create(
    input:
      | { kind: "channel"; name: string; visibility: "public" | "private" }
      | { kind: "dm"; other: number },
    requestId: string,
  ) {
    const conversation = await this.request(
      input.kind === "channel" ? "/api/chat/channels" : "/api/chat/dms",
      ConversationView,
      { ...input, requestId },
    );
    this.publish({
      conversations: [
        ...this.state.conversations.filter((c) => c.conversationId !== conversation.conversationId),
        conversation,
      ],
    });
    return conversation;
  }
  async conversationAction(
    id: number,
    action: "join" | "leave" | "archive" | "invite",
    requestId: string,
    invitee?: number,
  ) {
    await this.request(`/api/chat/conversations/${id}/${action}`, z.unknown(), {
      requestId,
      ...(invitee === undefined ? {} : { invitee }),
    });
  }
  async task(
    input:
      | { messageId: number; title: string }
      | {
          taskId: number;
          change: { kind: "claim" | "yield" | "complete" } | { kind: "transfer"; to: number };
        },
    requestId: string,
  ) {
    const result = await this.request(
      "taskId" in input ? `/api/chat/tasks/${input.taskId}/change` : "/api/chat/tasks",
      TaskResult,
      { ...input, requestId },
    );
    if (result.status === "refused")
      throw new Error(
        {
          claimed: "任务已被认领。",
          "not-owner": "任务已转交给其他人。",
          completed: "任务已完成。",
        }[result.reason],
      );
    return result;
  }
}

export function accountName(accounts: readonly AccountView[], id: number) {
  return accounts.find((a) => a.accountId === id)?.displayName ?? `#${id}`;
}
export function conversationLabel(
  conversation: ConversationView,
  accounts: readonly AccountView[],
  me: number,
) {
  return conversation.kind === "dm"
    ? conversation.members
        .filter((id) => id !== me)
        .map((id) => accountName(accounts, id))
        .join("、") || "（空私信）"
    : (conversation.name ?? "");
}
