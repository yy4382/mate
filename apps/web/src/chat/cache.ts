import { QueryClient } from "@tanstack/react-query";
import type {
  AccountView,
  ConversationView,
  Entry,
  LiveEvents,
  LiveSnapshot,
  TimelineKey,
  TimelineRef,
  UnreadSummary,
} from "./types.ts";
import { currentHumanKey } from "../shell/humans.ts";
import { timelineKey } from "./types.ts";

/**
 * Everything the chat client shows lives in the query cache under "chat". A timeline's entries are keyed by seq, so a
 * replayed or duplicated entry lands on the same slot instead of adding another.
 */
export const keys = {
  all: ["chat"] as const,
  me: ["chat", "me"] as const,
  accounts: ["chat", "accounts"] as const,
  conversations: ["chat", "conversations"] as const,
  unread: ["chat", "unread"] as const,
  threads: ["chat", "threads"] as const,
  timeline: (key: TimelineKey) => ["chat", "timeline", key] as const,
};

/** A timeline's entries, oldest first and contiguous up to the newest. */
export type TimelineData = { entries: Entry[] };

/** For each thread root message, the seqs of the replies seen in it. A set, so a repeated reply counts once. */
export type ThreadReplies = Record<number, number[]>;

export function mergeEntries(old: readonly Entry[], incoming: readonly Entry[]): Entry[] {
  const bySeq = new Map<number, Entry>();
  for (const entry of [...old, ...incoming]) bySeq.set(entry.seq, entry);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Entries seen while a timeline's first page is still on its way; they are merged in when it lands. */
const arriving = new Map<TimelineKey, Entry[]>();

export function markFetching(key: TimelineKey): void {
  arriving.set(key, []);
}

export function finishFetching(key: TimelineKey): Entry[] {
  const seen = arriving.get(key) ?? [];
  arriving.delete(key);
  return seen;
}

export function recordReplies(qc: QueryClient, root: number, entries: readonly Entry[]): void {
  const seqs = entries.filter((entry) => entry.kind === "message").map((entry) => entry.seq);
  if (seqs.length === 0) return;
  qc.setQueryData<ThreadReplies>(keys.threads, (old = {}) => ({
    ...old,
    [root]: [...new Set([...(old[root] ?? []), ...seqs])].sort((a, b) => a - b),
  }));
}

function addEntry(qc: QueryClient, ref: TimelineRef, entry: Entry): void {
  const key = timelineKey(ref);
  if ("thread" in ref) recordReplies(qc, ref.thread, [entry]);
  const pending = arriving.get(key);
  if (pending !== undefined) pending.push(entry);
  qc.setQueryData<TimelineData>(keys.timeline(key), (old) =>
    old === undefined ? old : { entries: mergeEntries(old.entries, [entry]) },
  );
}

function upsert<T>(items: T[] | undefined, item: T, same: (a: T) => boolean): T[] | undefined {
  if (items === undefined) return items;
  return items.some(same) ? items.map((a) => (same(a) ? item : a)) : [...items, item];
}

/** Apply one batch of the live stream. Timelines nobody has opened are not created: they load fresh when opened. */
export function applyLive(qc: QueryClient, batch: Extract<LiveEvents, { status: "events" }>): void {
  qc.setQueryData<UnreadSummary>(keys.unread, batch.unread);
  for (const event of batch.events) {
    if (event.type === "entry") addEntry(qc, event.timeline, event.entry);
    else if (event.type === "conversation")
      qc.setQueryData<ConversationView[]>(keys.conversations, (old) =>
        upsert(
          old,
          event.conversation,
          (a) => a.conversationId === event.conversation.conversationId,
        ),
      );
    else if (event.type === "account") {
      qc.setQueryData<AccountView[]>(keys.accounts, (old) =>
        upsert(old, event.account, (a) => a.accountId === event.account.accountId),
      );
      if (event.account.accountId === qc.getQueryData<number>(keys.me))
        void qc.invalidateQueries({ queryKey: currentHumanKey });
    }
  }
}

/** Fill the cache from a snapshot: the starting point the live stream continues from. */
export function seed(qc: QueryClient, snapshot: LiveSnapshot): void {
  qc.setQueryData(keys.me, snapshot.me);
  qc.setQueryData(keys.accounts, snapshot.accounts);
  qc.setQueryData(keys.conversations, snapshot.conversations);
  qc.setQueryData(keys.unread, snapshot.unread);
  if (snapshot.page !== null) {
    const entries = [...snapshot.page.entries].reverse();
    if ("thread" in snapshot.page.timeline)
      recordReplies(qc, snapshot.page.timeline.thread, entries);
    qc.setQueryData<TimelineData>(keys.timeline(timelineKey(snapshot.page.timeline)), { entries });
  }
}
