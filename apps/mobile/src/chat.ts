import type { ChatErrorReason } from "@mate/chat";
import {
  accountName,
  liveRetryDelay,
  mentionsIn,
  mergeEntries,
  timelineKey,
  timelineQuery,
  unsentText,
} from "@mate/chat/client";
import { t, listText } from "./i18n";
import { systemClock, type Clock } from "@mate/clock";
import { readEvents, sendJson } from "./http";
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

type Pending = {
  requestId: string;
  body: string;
  mentions: number[];
  text: string;
  status: "sending" | "failed";
};
export type Draft = { text: string; pending: Pending | null; error: string };
const emptyDraft: Draft = { text: "", pending: null, error: "" };
type Timeline = {
  entries: Entry[];
  loading: boolean;
  error: string;
  loaded: boolean;
  exhausted: boolean;
};
const emptyTimeline: Timeline = {
  entries: [],
  loading: false,
  error: "",
  loaded: false,
  exhausted: false,
};
type ConversationInput =
  | { kind: "channel"; name: string; visibility: "public" | "private" }
  | { kind: "dm"; other: number };
export type TaskChange =
  { kind: "claim" | "yield" | "complete" } | { kind: "transfer"; to: number };
type TaskCreation = { messageId: number; title: string };
type TaskUpdate = { taskId: number; change: TaskChange };
export type ConversationAction = "join" | "leave" | "archive" | "invite";
type OperationInput =
  | ConversationInput
  | ({ kind: "task-create" } & TaskCreation)
  | ({ kind: "task-change" } & TaskUpdate)
  | {
      kind: "conversation-action";
      conversationId: number;
      action: ConversationAction;
      invitee?: number;
    };
type PendingOperation = {
  input: OperationInput;
  requestId: string;
  status: "sending" | "failed";
  error: string;
};
/** Where `ChatState.operations` keeps each unconfirmed operation, so a reopened screen finds its input. */
export const operationKey = {
  creation: "new-conversation",
  conversation: (conversationId: number) => `conversation/${conversationId}`,
  taskCreation: (messageId: number) => `task-create/${messageId}`,
  taskChange: (taskId: number) => `task-change/${taskId}`,
};
export type ChatState = {
  connection: "loading" | "connecting" | "live" | "reconnecting" | "paused" | "closed";
  error: string;
  me: number;
  accounts: AccountView[];
  conversations: ConversationView[];
  unread: UnreadSummary;
  timelines: ReadonlyMap<string, Timeline>;
  drafts: ReadonlyMap<string, Draft>;
  operations: ReadonlyMap<string, PendingOperation>;
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
const refusals: Record<ChatErrorReason, string> = {
  "not-member": t("chat.join_the_channel_first"),
  archived: t("chat.this_channel_is_archived_and_can_only"),
  "invalid-input": t("chat.check_your_input"),
  "handle-taken": t("chat.this_name_is_already_in_use"),
  "request-conflict": t("chat.the_request_has_changed_cancel_and_try"),
  "not-found": t("chat.this_conversation_or_message_could_not_be"),
  "inactive-account": t("chat.this_account_has_been_deactivated"),
  "unknown-account": t("chat.account_not_found"),
  "invalid-target": t("chat.this_action_cannot_be_applied_to_the_target"),
  "human-only": t("chat.only_human_accounts_can_do_this"),
};
const errorText = (error: unknown) =>
  error instanceof Refusal ? error.message : t("chat.could_not_connect_to_the_server_check");
/** Replaces or adds one row, keeping the server's order by ID. */
const upsert = <T>(rows: readonly T[], row: T, id: (row: T) => number) =>
  [...rows.filter((r) => id(r) !== id(row)), row].sort((a, b) => id(a) - id(b));

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
    operations: new Map(),
  };
  private listeners = new Set<() => void>();
  private lifetime = new AbortController();
  private live: AbortController | undefined;
  private cursor: string | undefined;
  private snapshotVersion = 0;
  private running: Promise<void> | undefined;
  private loads = new Map<string, Promise<void>>();
  private clock: Clock;
  constructor(
    private readonly server: string,
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
      const response = await sendJson(this.platform.fetch, this.server + path, {
        method: body === undefined ? "GET" : "POST",
        body,
        signal,
      });
      if (signal.aborted) throw new Error("cancelled");
      await this.check(response);
      const value: unknown = response.status === 204 ? undefined : await response.json();
      if (signal.aborted) throw new Error("cancelled");
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
      throw new Refusal(401, t("auth.your_session_has_expired_sign_in_again"));
    }
    const error = z
      .object({ error: z.string() })
      .safeParse(await response.json().catch(() => null));
    throw new Refusal(
      response.status,
      error.success
        ? (refusals[error.data.error as ChatErrorReason] ??
            t("chat.the_operation_did_not_finish_check_permissions"))
        : t("chat.the_server_cannot_process_this_right_now"),
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
      operations: new Map(),
      unread: { total: 0, mentions: 0, timelines: [] },
    };
    this.listeners.forEach((listener) => listener());
    this.listeners.clear();
    this.loads.clear();
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
            connection: "connecting",
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
        await readEvents(
          response.body,
          (event, data) => {
            if (signal.aborted || this.lifetime.signal.aborted) return true;
            if (event === "login") {
              this.platform.expired();
              this.publish({ connection: "paused" });
              return true;
            }
            if (event !== "events" && event !== "resnapshot") return;
            const batch = event === "events" ? LiveEvents.parse(JSON.parse(data)) : undefined;
            if (batch?.status === "events") {
              this.apply(batch);
              failures = 0;
              this.publish({ connection: "live", error: "" });
              return;
            }
            this.cursor = undefined;
            ++this.snapshotVersion;
            this.publish({ timelines: new Map(), connection: "loading" });
            return true;
          },
          touch,
        );
        // A login event or a close ends following; a resnapshot takes a new snapshot.
        if (this.cursor !== undefined) return;
      } catch (error) {
        if (signal.aborted || this.lifetime.signal.aborted) return;
        watchdog?.abort();
        streamRequest.abort();
        this.publish({ connection: "reconnecting", error: errorText(error) });
        await this.clock.sleep(liveRetryDelay(failures++), signal);
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
        if (old) timelines.set(key, { ...old, entries: mergeEntries(old.entries, [event.entry]) });
      } else if (event.type === "account") {
        accounts = upsert(accounts, event.account, (a) => a.accountId);
      } else if (event.type === "conversation") {
        conversations = upsert(conversations, event.conversation, (c) => c.conversationId);
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
    if (this.cursor === undefined || this.lifetime.signal.aborted) return;
    const key = timelineKey(ref);
    const active = this.loads.get(key);
    if (active) {
      await active;
      if (!this.timeline(ref).loaded && !this.timeline(ref).error) await this.load(ref, older);
      return;
    }
    const old = this.timeline(ref);
    if (old.error || (!older && old.loaded) || (older && old.exhausted)) return;
    const pending = this.loadPage(ref, older);
    this.loads.set(key, pending);
    try {
      await pending;
    } finally {
      if (this.loads.get(key) === pending) this.loads.delete(key);
    }
  }
  async retryLoad(ref: TimelineRef, older = false): Promise<void> {
    this.setTimeline(ref, { ...this.timeline(ref), error: "" });
    await this.load(ref, older);
  }
  private async loadPage(ref: TimelineRef, older: boolean): Promise<void> {
    const version = this.snapshotVersion;
    const old = this.timeline(ref);
    this.setTimeline(ref, { ...old, loading: true, error: "" });
    try {
      const before = older ? old.entries[0]?.seq : undefined;
      const entries = await this.request(
        `/api/chat/history?${timelineQuery(ref)}&limit=50${before === undefined ? "" : `&before=${before - 1}`}`,
        z.array(Entry),
      );
      if (version !== this.snapshotVersion) return;
      this.setTimeline(ref, {
        entries: mergeEntries(this.timeline(ref).entries, entries),
        loading: false,
        loaded: true,
        error: "",
        exhausted: entries.length < 50,
      });
    } catch (error) {
      if (version !== this.snapshotVersion) return;
      this.setTimeline(ref, { ...this.timeline(ref), loading: false, error: errorText(error) });
    }
  }
  /** `cancel` stops paging between pages; a page already loading may be shared, so it finishes. */
  async locate(
    ref: TimelineRef,
    target: { seq: number } | { messageId: number },
    cancel: AbortSignal,
  ): Promise<"found" | "missing" | "failed" | "cancelled"> {
    const version = this.snapshotVersion;
    const stale = () =>
      cancel.aborted || this.lifetime.signal.aborted || version !== this.snapshotVersion;
    await this.load(ref);
    for (;;) {
      if (stale()) return "cancelled";
      const page = this.timeline(ref);
      if (page.error) return "failed";
      if (
        page.entries.some((entry) =>
          "seq" in target
            ? entry.seq === target.seq
            : entry.kind === "message" && entry.messageId === target.messageId,
        )
      )
        return "found";
      const first = page.entries[0]?.seq;
      if (
        !page.loaded ||
        page.exhausted ||
        first === undefined ||
        ("seq" in target && first < target.seq)
      )
        return "missing";
      await this.load(ref, true);
      if (!stale() && !this.timeline(ref).error && this.timeline(ref).entries[0]?.seq === first)
        return "missing";
    }
  }
  private async operate<T>(
    key: string,
    input: OperationInput,
    action: (requestId: string) => Promise<T>,
  ): Promise<T> {
    if (this.lifetime.signal.aborted) throw new Error(t("chat.your_session_has_ended"));
    const old = this.state.operations.get(key);
    if (old?.status === "sending")
      throw new Error(t("chat.an_operation_is_in_progress_please_wait"));
    if (old && JSON.stringify(old.input) !== JSON.stringify(input))
      throw new Error(t("chat.the_previous_operation_is_unconfirmed_retry_it"));
    const operation: PendingOperation = {
      input,
      requestId: old?.requestId ?? this.platform.requestId(),
      status: "sending",
      error: "",
    };
    const update = (value?: PendingOperation) => {
      const operations = new Map(this.state.operations);
      if (value) operations.set(key, value);
      else operations.delete(key);
      this.publish({ operations });
    };
    update(operation);
    try {
      const result = await action(operation.requestId);
      update();
      return result;
    } catch (error) {
      if (error instanceof Refusal && error.status >= 400 && error.status < 500) update();
      else
        update({
          ...operation,
          status: "failed",
          error: error instanceof Error ? error.message : t("chat.the_operation_failed_retry"),
        });
      throw error;
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
    const pending: Pending = {
      ...(draft.pending ?? {
        requestId: this.platform.requestId(),
        body: draft.text.trim(),
        text: draft.text,
        mentions: mentionsIn(draft.text, this.state.accounts),
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
        text: unsentText(current.text, pending.text),
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
  async create(input: ConversationInput) {
    const conversation = await this.operate(operationKey.creation, input, (requestId) =>
      this.request(
        input.kind === "channel" ? "/api/chat/channels" : "/api/chat/dms",
        ConversationView,
        { ...input, requestId },
      ),
    );
    this.publish({
      conversations: upsert(this.state.conversations, conversation, (c) => c.conversationId),
    });
    return conversation;
  }
  async conversationAction(id: number, action: ConversationAction, invitee?: number) {
    const input: OperationInput = {
      kind: "conversation-action",
      conversationId: id,
      action,
      ...(invitee === undefined ? {} : { invitee }),
    };
    await this.operate(operationKey.conversation(id), input, (requestId) =>
      this.request(`/api/chat/conversations/${id}/${action}`, z.unknown(), {
        requestId,
        ...(invitee === undefined ? {} : { invitee }),
      }),
    );
  }
  async task(input: TaskCreation | TaskUpdate) {
    const changing = "taskId" in input;
    return this.operate(
      changing ? operationKey.taskChange(input.taskId) : operationKey.taskCreation(input.messageId),
      changing ? { kind: "task-change", ...input } : { kind: "task-create", ...input },
      async (requestId) => {
        const result = await this.request(
          "taskId" in input ? `/api/chat/tasks/${input.taskId}/change` : "/api/chat/tasks",
          TaskResult,
          { ...input, requestId },
        );
        if (result.status === "refused")
          throw new Refusal(
            409,
            {
              claimed: t("chat.this_task_has_been_claimed"),
              "not-owner": t("chat.this_task_has_been_transferred_to_someone"),
              completed: t("chat.this_task_is_complete"),
            }[result.reason],
          );
        return result;
      },
    );
  }
}

export function taskStatus(
  task: Extract<Entry, { kind: "task" }>,
  accounts: readonly AccountView[],
  me: number,
) {
  if (task.change === "completed") return t("chat.completed");
  if (task.owner === null) return t("chat.unclaimed");
  const name = accountName(accounts, task.owner);
  return t("chat.owned_by", { name: task.owner === me ? t("common.you_name", { name }) : name });
}
export function conversationLabel(
  conversation: ConversationView,
  accounts: readonly AccountView[],
  me: number,
) {
  return conversation.kind === "dm"
    ? listText(
        conversation.members.filter((id) => id !== me).map((id) => accountName(accounts, id)),
      ) || t("chat.empty_direct_message")
    : (conversation.name ?? "");
}
