import { createHash } from "node:crypto";
import { systemClock, type Clock } from "@mate/clock";
import { z } from "zod";
import {
  accountByExternalId,
  deactivateAccount,
  ensureAccount,
  humanByHandle,
  listAccounts,
  requireActor,
  requireHuman,
  EnsureAccountInput,
  type AccountView,
} from "./accounts.ts";
import { ChatError, parseInput } from "./chat-error.ts";
import {
  archiveChannel,
  ChannelInput,
  createChannel,
  invite,
  join,
  leave,
  openDm,
} from "./conversation-lifecycle.ts";
import { listConversations, ConversationView } from "./conversations.ts";
import { ChatDatabase } from "./database.ts";
import { type Entry } from "./entries.ts";
import { readForward, DEFAULT_BUDGET, Budget, ReadPage } from "./forward-reading.ts";
import { Id, RequestId } from "./identifiers.ts";
import {
  inboxEvents,
  inboxMark,
  notifiedSince,
  unreadSummary,
  InboxQuery,
  type InboxEvent,
  type UnreadSummary,
} from "./inbox.ts";
import {
  liveEvents,
  liveMark,
  liveSnapshot,
  pruneLive,
  type LiveEvents,
  type LiveSnapshot,
} from "./live.ts";
import {
  enqueuePushes,
  PushDelivery,
  PushAddress,
  PushSubscription,
  subscribePush,
  unsubscribePush,
  type PushSender,
} from "./push.ts";
import { idempotent } from "./receipts.ts";
import {
  HistoryQuery,
  readHistory,
  search,
  SearchQuery,
  send,
  SendRequest,
  SendResult,
} from "./send.ts";
import {
  changeTask,
  createTask,
  CreateTaskRequest,
  TaskChangeRequest,
  TaskResult,
} from "./tasks.ts";
import { resolveTimeline, TimelineRef } from "./timelines.ts";

export { ChatError, type ChatErrorReason } from "./chat-error.ts";
export { ChatStoreIncompatible } from "./database.ts";
export { AccountKind, AccountNames, type AccountView } from "./accounts.ts";
export type { ConversationView } from "./conversations.ts";
export type { Entry, MessageEntry, TaskEntry } from "./entries.ts";
export type { ReadPage } from "./forward-reading.ts";
export type { InboxEvent, UnreadSummary } from "./inbox.ts";
export type { LiveEvent, LiveEvents, LiveSnapshot } from "./live.ts";
export type { PushNotice, PushSender, PushSubscription } from "./push.ts";
export type { SendResult, SentMessage, HeldMessage } from "./send.ts";
export type { Task, TaskResult } from "./tasks.ts";
export type { TimelineRef } from "./timelines.ts";

/** Told which accounts just received inbox events. */
export type InboxListener = (accounts: readonly number[]) => void;

/** Told that live events were just committed. */
export type LiveListener = () => void;

/** The requestId every write carries, plus whatever else that write needs. */
const WithRequest = { requestId: RequestId };
const ChannelRequest = z.object({ ...WithRequest, ...ChannelInput.shape });
const DmRequest = z.object({ ...WithRequest, other: Id });
const ConversationRequest = z.object({ ...WithRequest, conversationId: Id });
const InviteRequest = z.object({ ...WithRequest, conversationId: Id, invitee: Id });
const ReadRequest = z.object({ ...WithRequest, budget: Budget.default(DEFAULT_BUDGET) });
const SnapshotRequest = z.object({ timeline: TimelineRef.optional() });
const LiveCursor = z.string();

const Nothing = z.null();

function stableHash(content: unknown): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/**
 * The chat app. Every write and every forward read carries a `requestId` and is idempotent on
 * (account, requestId): a repeat returns the first result instead of acting twice, and a repeat
 * carrying different content is refused. Reads that never change anything carry no id.
 *
 * A message and everything it implies commit as one transaction, so a failure leaves nothing behind.
 */
export class ChatApp {
  readonly #db: ChatDatabase;
  readonly #inboxListeners = new Set<InboxListener>();
  readonly #liveListeners = new Set<LiveListener>();
  readonly #push: PushDelivery | undefined;

  /**
   * Open (or create) the chat database at `file`. Every timestamp the app writes, and every push retry, follows
   * `clock`. With `push`, the app delivers its push queue through it until `close()`; without it, pushes stay queued.
   */
  constructor(file: string, options: { clock?: Clock; push?: PushSender } = {}) {
    const clock = options.clock ?? systemClock;
    this.#db = new ChatDatabase(file, clock);
    this.#push = options.push && new PushDelivery(this.#db, clock, options.push);
  }

  /**
   * The account-bound operations, for a caller that always acts as `account` (an Agent's chat tools). Each is the
   * method of the same name with `account` filled in.
   */
  forAccount(account: number): AccountChat {
    return {
      readUnread: (timeline, request) => this.readUnread(account, timeline, request),
      readHistory: (timeline, query) => this.readHistory(account, timeline, query),
      search: (query) => this.search(account, query),
      send: (timeline, request) => this.send(account, timeline, request),
      join: (request) => this.join(account, request),
      leave: (request) => this.leave(account, request),
      openDm: (request) => this.openDm(account, request),
      listConversations: () => this.listConversations(account),
      createTask: (request) => this.createTask(account, request),
      changeTask: (request) => this.changeTask(account, request),
    };
  }

  /**
   * Run `work` once per (account, requestId) and store its result as the receipt. `hashOf` covers every
   * argument that distinguishes one request from another, so the same id with different content is refused.
   */
  #once<S extends z.ZodType>(
    account: number,
    requestId: string,
    hashOf: unknown,
    result: S,
    work: () => z.output<S>,
  ): z.output<S> {
    return this.#write(() =>
      idempotent(
        this.#db,
        account,
        requestId,
        stableHash(hashOf),
        work,
        (value) => JSON.stringify(value),
        (stored) => result.parse(JSON.parse(stored)),
      ),
    );
  }

  /**
   * The only way an operation opens a write transaction; the push queue's own bookkeeping, which touches nothing an
   * operation reads, is the one other writer. It notes the newest inbox and live events before `work`. Inside the
   * same transaction it queues the pushes the new inbox events call for and drops expired live events. After the
   * commit it signals the accounts that received inbox events, the live listeners and the push queue. Watching the
   * tables rather than each place that appends to them means no write path can append events without pushing or
   * signalling, and a rollback, a held send or a replayed receipt appends none, so it signals nothing.
   */
  #write<T>(work: () => T): T {
    const { result, notified, live, pushed } = this.#db.transaction("write", () => {
      const inbox = inboxMark(this.#db);
      const liveBefore = liveMark(this.#db);
      const result = work();
      const pushed = enqueuePushes(this.#db, inbox) > 0;
      const live = liveMark(this.#db) > liveBefore;
      pruneLive(this.#db);
      return { result, notified: notifiedSince(this.#db, inbox), live, pushed };
    });
    if (notified.length > 0)
      this.#signal("inbox", this.#inboxListeners, (listener) => listener(notified));
    if (live) this.#signal("live", this.#liveListeners, (listener) => listener());
    if (pushed) this.#push?.wake();
    return result;
  }

  #signal<L>(name: string, listeners: Set<L>, call: (listener: L) => void): void {
    for (const listener of [...listeners]) {
      try {
        call(listener);
      } catch (error) {
        // The write has committed; a failing listener must neither undo it nor starve the others.
        console.error(`chat ${name} listener failed`, error);
      }
    }
  }

  // ── Accounts ────────────────────────────────────────────────────────────────

  /**
   * The account for `externalId`, created on first use and renamed on later calls. Idempotent on
   * `externalId` rather than on a requestId: this is the one write with no acting account to hang a
   * receipt on, and the caller's stable identity for the account is already the natural key. A deactivated account
   * is refused with `inactive-account`: deactivation is permanent, so its identity cannot be taken up again.
   */
  ensureAccount(input: z.input<typeof EnsureAccountInput>): number {
    return this.#write(() => ensureAccount(this.#db, parseInput(EnsureAccountInput, input)));
  }

  /**
   * The account `ensureAccount` created for `externalId`, active or deactivated, or undefined if there is none. Lets a
   * caller that keeps only the external identity find the account without restating its names.
   */
  findAccount(externalId: string): number | undefined {
    return this.#db.transaction("read", () => accountByExternalId(this.#db, externalId));
  }

  /**
   * The human account with `handle` (case-insensitive), active or deactivated, or undefined if there is none or the
   * handle is an Agent's. How a login finds the account a handle names.
   */
  findHuman(
    handle: string,
  ): { accountId: number; externalId: string; active: boolean } | undefined {
    return this.#db.transaction("read", () => humanByHandle(this.#db, handle));
  }

  /** Every account, deactivated ones included, since their messages stay readable. */
  listAccounts(): AccountView[] {
    return this.#db.transaction("read", () => listAccounts(this.#db));
  }

  /** Deactivation is permanent. The account's messages stay readable. */
  deactivateAccount(account: number, request: { requestId: string }): void {
    const { requestId } = parseInput(z.object(WithRequest), request);
    this.#once(account, requestId, { account }, Nothing, () => {
      deactivateAccount(this.#db, account);
      return null;
    });
  }

  // ── Conversations ───────────────────────────────────────────────────────────

  createChannel(account: number, request: z.input<typeof ChannelRequest>): ConversationView {
    const actor = requireActor(this.#db, account);
    const { requestId, ...channel } = parseInput(ChannelRequest, request);
    return this.#once(account, requestId, channel, ConversationView, () =>
      createChannel(this.#db, actor, channel),
    );
  }

  /** The single DM between the actor and `other`, created on first use by either of them. */
  openDm(account: number, request: z.input<typeof DmRequest>): ConversationView {
    const actor = requireActor(this.#db, account);
    const { requestId, other } = parseInput(DmRequest, request);
    return this.#once(account, requestId, { other }, ConversationView, () =>
      openDm(this.#db, actor, other),
    );
  }

  join(account: number, request: z.input<typeof ConversationRequest>): ConversationView {
    const actor = requireActor(this.#db, account);
    const { requestId, conversationId } = parseInput(ConversationRequest, request);
    return this.#once(account, requestId, { conversationId }, ConversationView, () =>
      join(this.#db, actor, conversationId),
    );
  }

  leave(account: number, request: z.input<typeof ConversationRequest>): ConversationView {
    const actor = requireActor(this.#db, account);
    const { requestId, conversationId } = parseInput(ConversationRequest, request);
    return this.#once(account, requestId, { conversationId }, ConversationView, () =>
      leave(this.#db, actor, conversationId),
    );
  }

  invite(account: number, request: z.input<typeof InviteRequest>): ConversationView {
    const actor = requireActor(this.#db, account);
    const { requestId, conversationId, invitee } = parseInput(InviteRequest, request);
    return this.#once(account, requestId, { conversationId, invitee }, ConversationView, () =>
      invite(this.#db, actor, conversationId, invitee),
    );
  }

  archiveChannel(account: number, request: z.input<typeof ConversationRequest>): ConversationView {
    const actor = requireActor(this.#db, account);
    const { requestId, conversationId } = parseInput(ConversationRequest, request);
    return this.#once(account, requestId, { conversationId }, ConversationView, () =>
      archiveChannel(this.#db, actor, conversationId),
    );
  }

  listConversations(account: number): ConversationView[] {
    const actor = requireActor(this.#db, account);
    return this.#db.transaction("read", () => listConversations(this.#db, actor));
  }

  // ── Reading ─────────────────────────────────────────────────────────────────

  /**
   * Read forward from the account's position, advancing it to the end of the timeline. Idempotent on
   * `requestId`, so a replay after a crash returns the page the caller first saw instead of skipping it.
   */
  readUnread(
    account: number,
    timelineRef: z.input<typeof TimelineRef>,
    request: z.input<typeof ReadRequest>,
  ): z.output<typeof ReadPage> {
    const actor = requireActor(this.#db, account);
    const timeline = parseInput(TimelineRef, timelineRef);
    const { requestId, budget } = parseInput(ReadRequest, request);
    return this.#once(account, requestId, { timeline, budget }, ReadPage, () =>
      readForward(this.#db, actor, resolveTimeline(this.#db, actor, timeline), budget),
    );
  }

  /** The newest `limit` entries at or before seq `before`, newest first. Never moves the read position. */
  readHistory(
    account: number,
    timelineRef: z.input<typeof TimelineRef>,
    query?: z.input<typeof HistoryQuery>,
  ): Entry[] {
    const actor = requireActor(this.#db, account);
    const timeline = parseInput(TimelineRef, timelineRef);
    const history = parseInput(HistoryQuery, query ?? {});
    return this.#db.transaction("read", () => readHistory(this.#db, actor, timeline, history));
  }

  /** The newest messages containing `query`, over every timeline the account can read. Never moves a read position. */
  search(account: number, query: string): Entry[] {
    const actor = requireActor(this.#db, account);
    const keyword = parseInput(SearchQuery, query);
    return this.#db.transaction("read", () => search(this.#db, actor, keyword));
  }

  // ── Writing ─────────────────────────────────────────────────────────────────

  /**
   * Send a message. A held result is stored as the receipt too: a repeat of the same requestId returns
   * the same "held" page rather than attempting the send again.
   */
  send(
    account: number,
    timelineRef: z.input<typeof TimelineRef>,
    request: z.input<typeof SendRequest>,
  ): z.output<typeof SendResult> {
    const actor = requireActor(this.#db, account);
    const timeline = parseInput(TimelineRef, timelineRef);
    const parsed = parseInput(SendRequest, request);
    const { requestId, ...rest } = parsed;
    return this.#once(account, requestId, { timeline, ...rest }, SendResult, () =>
      send(this.#db, actor, timeline, parsed),
    );
  }

  // ── Tasks ───────────────────────────────────────────────────────────────────

  createTask(
    account: number,
    request: z.input<typeof CreateTaskRequest>,
  ): z.output<typeof TaskResult> {
    const actor = requireActor(this.#db, account);
    const parsed = parseInput(CreateTaskRequest, request);
    const { requestId, ...rest } = parsed;
    return this.#once(account, requestId, rest, TaskResult, () =>
      createTask(this.#db, actor, parsed),
    );
  }

  changeTask(
    account: number,
    request: z.input<typeof TaskChangeRequest>,
  ): z.output<typeof TaskResult> {
    const actor = requireActor(this.#db, account);
    const parsed = parseInput(TaskChangeRequest, request);
    const { requestId, ...rest } = parsed;
    return this.#once(account, requestId, rest, TaskResult, () =>
      changeTask(this.#db, actor, parsed),
    );
  }

  // ── Inbox ───────────────────────────────────────────────────────────────────

  /** The account's inbox events after `after`, oldest first, for the connector. */
  inboxEvents(account: number, query?: { after?: number; limit?: number }): InboxEvent[] {
    const actor = requireActor(this.#db, account);
    return this.#db.transaction("read", () =>
      inboxEvents(this.#db, actor.id, parseInput(InboxQuery, query ?? {})),
    );
  }

  /**
   * Call `listener` after every committed write that appended inbox events, with the distinct accounts that
   * received them. Inside the listener those events and their messages are already readable. Returns unsubscribe.
   */
  watchInbox(listener: InboxListener): () => void {
    const entry: InboxListener = (accounts) => listener(accounts);
    this.#inboxListeners.add(entry);
    return () => {
      this.#inboxListeners.delete(entry);
    };
  }

  /** Unread counts per timeline for the account, for the connector's notice. */
  unreadSummary(account: number): UnreadSummary {
    const actor = requireActor(this.#db, account);
    return this.#db.transaction("read", () => unreadSummary(this.#db, actor));
  }

  // ── Live view ───────────────────────────────────────────────────────────────

  /**
   * What the human's client shows, and the cursor it follows from, read together: whatever was committed before is
   * in the snapshot, whatever is committed after arrives from `liveEvents(cursor)`. With `timeline`, the snapshot
   * also holds that timeline's newest page, so the timeline a client opens with needs no second read.
   */
  liveSnapshot(account: number, request?: z.input<typeof SnapshotRequest>): LiveSnapshot {
    const viewer = requireHuman(this.#db, account);
    const { timeline } = parseInput(SnapshotRequest, request ?? {});
    return this.#db.transaction("read", () => liveSnapshot(this.#db, viewer, timeline));
  }

  /**
   * The live events after `cursor`, oldest first, at most 500; ask again from the last one's cursor until none come
   * back. `resnapshot` when the cursor is from another epoch (the store was reset), older than the events kept (a day),
   * or not one this store issued: the client must load a new snapshot.
   */
  liveEvents(account: number, cursor: string): LiveEvents {
    const viewer = requireHuman(this.#db, account);
    const after = parseInput(LiveCursor, cursor);
    return this.#db.transaction("read", () => liveEvents(this.#db, viewer, after));
  }

  /**
   * Call `listener` after every committed write that appended live events. Inside the listener those events are
   * already readable. Returns unsubscribe.
   */
  watchLive(listener: LiveListener): () => void {
    const entry: LiveListener = () => listener();
    this.#liveListeners.add(entry);
    return () => {
      this.#liveListeners.delete(entry);
    };
  }

  // ── Push ────────────────────────────────────────────────────────────────────

  /**
   * Push this human's DMs and mentions to a browser or native app. The transport address is its natural key;
   * subscribing from another human moves it to that human and drops the old human's pending deliveries.
   */
  subscribePush(account: number, subscription: z.input<typeof PushSubscription>): void {
    const human = requireHuman(this.#db, account);
    const parsed = parseInput(PushSubscription, subscription);
    this.#write(() => subscribePush(this.#db, human, parsed));
  }

  /**
   * Remove this human's own subscription and its queued pushes. Another human's subscription or an old native
   * binding changes nothing and is answered the same way.
   */
  unsubscribePush(account: number, request: z.input<typeof PushAddress>): void {
    const human = requireHuman(this.#db, account);
    const address = parseInput(PushAddress, request);
    this.#write(() => unsubscribePush(this.#db, human, address));
  }

  close(): void {
    this.#push?.close();
    this.#db.close();
  }
}

/** The `ChatApp` methods an account-bound caller uses. */
type AccountMethod =
  | "readUnread"
  | "readHistory"
  | "search"
  | "send"
  | "join"
  | "leave"
  | "openDm"
  | "listConversations"
  | "createTask"
  | "changeTask";

/** The chat app as one account sees it: each method is `ChatApp`'s, without the leading `account`. */
export type AccountChat = {
  readonly [K in AccountMethod]: (
    ...args: Parameters<ChatApp[K]> extends [number, ...infer Rest] ? Rest : never
  ) => ReturnType<ChatApp[K]>;
};
