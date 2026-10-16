import { createHash } from "node:crypto";
import { z } from "zod";
import {
  accountByExternalId,
  deactivateAccount,
  ensureAccount,
  requireActor,
  EnsureAccountInput,
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
import { idempotent } from "./receipts.ts";
import { readHistory, search, send, SendRequest, SendResult } from "./send.ts";
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
export type { ConversationView } from "./conversations.ts";
export type { Entry, MessageEntry, TaskEntry } from "./entries.ts";
export type { ReadPage } from "./forward-reading.ts";
export type { InboxEvent, UnreadSummary } from "./inbox.ts";
export type { SendResult, SentMessage, HeldMessage } from "./send.ts";
export type { Task, TaskResult } from "./tasks.ts";
export type { TimelineRef } from "./timelines.ts";

/** Told which accounts just received inbox events. */
export type InboxListener = (accounts: readonly number[]) => void;

/** The requestId every write carries, plus whatever else that write needs. */
const WithRequest = { requestId: RequestId };
const ChannelRequest = z.object({ ...WithRequest, ...ChannelInput.shape });
const DmRequest = z.object({ ...WithRequest, other: Id });
const ConversationRequest = z.object({ ...WithRequest, conversationId: Id });
const InviteRequest = z.object({ ...WithRequest, conversationId: Id, invitee: Id });
const ReadRequest = z.object({ ...WithRequest, budget: Budget.default(DEFAULT_BUDGET) });

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

  constructor(file: string) {
    this.#db = new ChatDatabase(file);
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
   * The only way a write transaction is opened. It notes the newest inbox event before `work` and, after the
   * commit, signals the accounts that received events since. Watching the inbox table rather than each place that
   * appends to it means no write path can append events without signalling, and a rollback, a held send or a
   * replayed receipt appends none, so it signals nothing.
   */
  #write<T>(work: () => T): T {
    const { result, notified } = this.#db.transaction("write", () => {
      const mark = inboxMark(this.#db);
      const result = work();
      return { result, notified: notifiedSince(this.#db, mark) };
    });
    if (notified.length > 0) this.#signalInbox(notified);
    return result;
  }

  #signalInbox(accounts: readonly number[]): void {
    for (const listener of [...this.#inboxListeners]) {
      try {
        listener(accounts);
      } catch (error) {
        // The write has committed; a failing listener must neither undo it nor starve the others.
        console.error("chat inbox listener failed", error);
      }
    }
  }

  // ── Accounts ────────────────────────────────────────────────────────────────

  /**
   * The account for `externalId`, created on first use and renamed on later calls. Idempotent on
   * `externalId` rather than on a requestId: this is the one write with no acting account to hang a
   * receipt on, and the caller's stable identity for the account is already the natural key.
   */
  ensureAccount(input: z.input<typeof EnsureAccountInput>): number {
    return this.#write(() => ensureAccount(this.#db, EnsureAccountInput.parse(input)));
  }

  /**
   * The account `ensureAccount` created for `externalId`, active or deactivated, or undefined if there is none. Lets a
   * caller that keeps only the external identity find the account without restating its names.
   */
  findAccount(externalId: string): number | undefined {
    return this.#db.transaction("read", () => accountByExternalId(this.#db, externalId));
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
    timeline: TimelineRef,
    request: z.input<typeof ReadRequest>,
  ): z.output<typeof ReadPage> {
    const actor = requireActor(this.#db, account);
    const { requestId, budget } = parseInput(ReadRequest, request);
    return this.#once(account, requestId, { timeline, budget }, ReadPage, () =>
      readForward(this.#db, actor, resolveTimeline(this.#db, actor, timeline), budget),
    );
  }

  /** History at or before `before`, newest first. Never moves the read position. */
  readHistory(
    account: number,
    timeline: TimelineRef,
    params?: { before?: number; limit?: number },
  ): Entry[] {
    const actor = requireActor(this.#db, account);
    return this.#db.transaction("read", () => readHistory(this.#db, actor, timeline, params ?? {}));
  }

  /** Keyword search over every timeline the account can read. Never moves a read position. */
  search(account: number, query: string): Entry[] {
    const actor = requireActor(this.#db, account);
    return this.#db.transaction("read", () => search(this.#db, actor, query));
  }

  // ── Writing ─────────────────────────────────────────────────────────────────

  /**
   * Send a message. A held result is stored as the receipt too: a repeat of the same requestId returns
   * the same "held" page rather than attempting the send again.
   */
  send(
    account: number,
    timeline: TimelineRef,
    request: z.input<typeof SendRequest>,
  ): z.output<typeof SendResult> {
    const actor = requireActor(this.#db, account);
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

  close(): void {
    this.#db.close();
  }
}

/** Open (or create) the chat database at `file`. */
export function openChatApp(file: string): ChatApp {
  return new ChatApp(file);
}
