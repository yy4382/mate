/**
 * Pure chat rules both clients apply to what the chat routes serve. Node-free, so the web and native apps import it at
 * runtime; wording stays with each app.
 */
import type { AccountView, Entry, TimelineRef } from "./contracts.ts";

/** The key a timeline has in a client: `c<conversation>` for a top level, `t<root message>` for a thread. */
export type TimelineKey = `c${number}` | `t${number}`;

export const timelineKey = (ref: TimelineRef): TimelineKey =>
  "conversation" in ref ? `c${ref.conversation}` : `t${ref.thread}`;

/** The query parameter that names a timeline on the chat routes. */
export const timelineQuery = (ref: TimelineRef): string =>
  "conversation" in ref ? `conversation=${ref.conversation}` : `thread=${ref.thread}`;

/** Entries from two reads of one timeline, once each, in timeline order; the later read wins. */
export function mergeEntries(old: readonly Entry[], incoming: readonly Entry[]): Entry[] {
  const bySeq = new Map<number, Entry>();
  for (const entry of [...old, ...incoming]) bySeq.set(entry.seq, entry);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The active accounts a message body mentions by `@handle`, in ID order: the chat app's handle rule. */
export function mentionsIn(body: string, accounts: readonly AccountView[]): number[] {
  const ids = new Set<number>();
  for (const [, handle] of body.matchAll(/@([\p{L}\p{N}][\p{L}\p{N}_.-]*)/gu)) {
    const account = accounts.find(
      (a) => a.active && a.handle.toLowerCase() === handle?.toLowerCase(),
    );
    if (account !== undefined) ids.add(account.accountId);
  }
  return [...ids].sort((a, b) => a - b);
}

/** What is left of a draft once `sent` went out: text typed while it was being delivered stays. */
export const unsentText = (text: string, sent: string) =>
  text.startsWith(sent) ? text.slice(sent.length).trimStart() : text;

export const accountName = (accounts: readonly AccountView[], id: number): string =>
  accounts.find((a) => a.accountId === id)?.displayName ?? `#${id}`;

const LIVE_RETRY_MS = [500, 1000, 2000, 5000] as const;

/** How long a client waits before reconnecting the live stream after `failures` consecutive failures. */
export const liveRetryDelay = (failures: number) =>
  LIVE_RETRY_MS[Math.min(failures, LIVE_RETRY_MS.length - 1)]!;
