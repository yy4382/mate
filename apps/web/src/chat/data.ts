import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { get } from "../shell/api.ts";
import {
  finishFetching,
  keys,
  markFetching,
  mergeEntries,
  recordReplies,
  type ThreadReplies,
  type TimelineData,
} from "./cache.ts";
import {
  timelineKey,
  timelineQuery,
  type AccountView,
  type ConversationView,
  type Entry,
  type TimelineRef,
  type UnreadSummary,
} from "./types.ts";

export const PAGE = 50;

const live = { staleTime: Infinity } as const;

export const useAccounts = () =>
  useQuery({
    queryKey: keys.accounts,
    queryFn: async () => (await get<{ accounts: AccountView[] }>("/api/chat/snapshot")).accounts,
    ...live,
  });

export const useConversations = () =>
  useQuery({
    queryKey: keys.conversations,
    queryFn: () => get<ConversationView[]>("/api/chat/conversations"),
    ...live,
  });

export const useUnread = () =>
  useQuery({
    queryKey: keys.unread,
    queryFn: () => get<UnreadSummary>("/api/chat/unread"),
    ...live,
  });

export function useReplyCount(root: number): number {
  const { data } = useQuery<ThreadReplies>({
    queryKey: keys.threads,
    queryFn: () => ({}),
    ...live,
  });
  return data?.[root]?.length ?? 0;
}

/** A timeline's first page. Entries that arrive on the live stream while it loads are merged in, never lost. */
export function timelineOptions(qc: QueryClient, ref: TimelineRef) {
  const key = timelineKey(ref);
  return queryOptions({
    queryKey: keys.timeline(key),
    ...live,
    retry: false,
    queryFn: async (): Promise<TimelineData> => {
      markFetching(key);
      try {
        const page = await get<Entry[]>(`/api/chat/history?${timelineQuery(ref)}&limit=${PAGE}`);
        const entries = [...page].reverse();
        if ("thread" in ref) recordReplies(qc, ref.thread, entries);
        return { entries: mergeEntries(entries, finishFetching(key)) };
      } catch (error) {
        finishFetching(key);
        throw error;
      }
    },
  });
}

export function useTimeline(ref: TimelineRef) {
  const qc = useQueryClient();
  return useQuery(timelineOptions(qc, ref));
}

/** Fetch the page before the oldest loaded entry. Returns false when the timeline has nothing older. */
export async function loadOlder(qc: QueryClient, ref: TimelineRef): Promise<boolean> {
  const key = keys.timeline(timelineKey(ref));
  const first = qc.getQueryData<TimelineData>(key)?.entries[0];
  if (first === undefined || first.seq <= 1) return false;
  const page = await get<Entry[]>(
    `/api/chat/history?${timelineQuery(ref)}&before=${first.seq - 1}&limit=${PAGE}`,
  );
  const entries = [...page].reverse();
  if ("thread" in ref) recordReplies(qc, ref.thread, entries);
  qc.setQueryData<TimelineData>(key, (old) => ({
    entries: mergeEntries(old?.entries ?? [], entries),
  }));
  return true;
}

export const ownerOf = (accounts: readonly AccountView[]) => accounts.find((a) => a.owner);

export function accountName(accounts: readonly AccountView[], id: number): string {
  const account = accounts.find((a) => a.accountId === id);
  return account === undefined ? `#${id}` : account.displayName;
}

/** What a conversation is called: a channel's name, or the other person of a direct message. */
export function conversationLabel(
  conversation: ConversationView,
  accounts: readonly AccountView[],
): string {
  if (conversation.kind !== "dm") return conversation.name ?? "";
  const owner = ownerOf(accounts);
  const others = conversation.members.filter((id) => id !== owner?.accountId);
  const names = others.map((id) => accountName(accounts, id));
  return names.length === 0 ? "（空私信）" : names.join("、");
}
