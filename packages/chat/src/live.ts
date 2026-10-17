import { z } from "zod";
import { accountView, listAccounts, type Actor, type AccountView } from "./accounts.ts";
import {
  conversationById,
  conversationView,
  listConversations,
  type ConversationView,
} from "./conversations.ts";
import type { ChatDatabase } from "./database.ts";
import { loadEntries, type Entry } from "./entries.ts";
import { Id } from "./identifiers.ts";
import { unreadSummary, type UnreadSummary } from "./inbox.ts";
import { readPosition } from "./read-positions.ts";
import { HistoryQuery, readHistory } from "./send.ts";
import { resolveTimeline, timelineById, timelineOfEntry, type TimelineRef } from "./timelines.ts";

/** How long a live event is kept. A client that falls further behind than this loads a new snapshot. */
const LIVE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** The most events one `liveEvents` call returns; the caller asks again from the last one's cursor. */
const EVENTS_PER_READ = 500;

/**
 * Everything the owner's client renders, as of one moment, and the cursor of that moment. `page` is the newest page
 * of the timeline the client opened (newest first, as `readHistory` returns it) with the owner's read position there.
 */
export type LiveSnapshot = {
  cursor: string;
  accounts: AccountView[];
  conversations: ConversationView[];
  unread: UnreadSummary;
  page: { timeline: TimelineRef; entries: Entry[]; position: number } | null;
};

/**
 * One change to what the owner's client shows. An entry is immutable, so its event carries it in full; the other
 * kinds carry their subject's current state, so applying a stale or repeated one converges on the same view.
 * `cursor` is the position just after this event.
 */
export type LiveEvent = { cursor: string } & (
  | { type: "entry"; conversationId: number; timeline: TimelineRef; entry: Entry }
  | { type: "conversation"; conversation: ConversationView }
  | { type: "account"; account: AccountView }
  | { type: "read"; conversationId: number; timeline: TimelineRef; position: number }
);

/**
 * Events after a cursor, with the owner's unread summary as of the same read, so a client replaces its unread counts
 * instead of working out which timelines the owner follows. `resnapshot` when the cursor does not name a position the
 * log still holds.
 */
export type LiveEvents =
  { status: "events"; events: LiveEvent[]; unread: UnreadSummary } | { status: "resnapshot" };

type LivePayload<K extends LiveEvent["type"]> = Omit<Extract<LiveEvent, { type: K }>, "cursor">;

/** How each kind of event reads its payload from its subject. The owner reads every conversation. */
const PAYLOADS: {
  [K in LiveEvent["type"]]: (db: ChatDatabase, owner: Actor, subject: number) => LivePayload<K>;
} = {
  entry: (db, owner, entryId) => {
    const timeline = timelineOfEntry(db, owner, entryId);
    const [entry] = loadEntries(db, { where: "e.id = ?", order: "e.id" }, entryId);
    if (entry === undefined) throw new Error(`entry ${entryId} vanished`);
    return {
      type: "entry",
      conversationId: timeline.conversation.id,
      timeline: timeline.ref,
      entry,
    };
  },
  conversation: (db, owner, conversationId) => ({
    type: "conversation",
    conversation: conversationView(db, owner, conversationById(db, conversationId)),
  }),
  account: (db, _owner, accountId) => ({ type: "account", account: accountView(db, accountId) }),
  read: (db, owner, timelineId) => {
    const timeline = timelineById(db, owner, timelineId);
    return {
      type: "read",
      conversationId: timeline.conversation.id,
      timeline: timeline.ref,
      position: readPosition(db, owner.id, timelineId),
    };
  },
};

const LiveState = z.object({ epoch: z.string(), pruned_through: z.number(), head: z.number() });
type LiveState = z.output<typeof LiveState>;

/** The store's epoch, and the range of positions a cursor may name: from `pruned_through` to `head`. */
function liveState(db: ChatDatabase): LiveState {
  const state = db.get(
    LiveState,
    `SELECT epoch, pruned_through,
       max(pruned_through, coalesce((SELECT max(id) FROM live_events), 0)) AS head
     FROM live_state`,
  );
  if (state === undefined) throw new Error("live_state has no row");
  return state;
}

/** The position of the newest live event; every later event lies above it. */
export const liveMark = (db: ChatDatabase): number => liveState(db).head;

const cursorOf = (epoch: string, position: number): string => `${epoch}:${position}`;

const CURSOR = /^([0-9a-f]{32}):(0|[1-9][0-9]{0,15})$/;

/** The position `cursor` names in this log, or undefined if it is not one the log can continue from. */
function positionOf(cursor: string, state: LiveState): number | undefined {
  const match = CURSOR.exec(cursor);
  if (match === null || match[1] !== state.epoch) return undefined;
  const position = Number(match[2]);
  return position >= state.pruned_through && position <= state.head ? position : undefined;
}

export function liveSnapshot(
  db: ChatDatabase,
  owner: Actor,
  timeline: TimelineRef | undefined,
): LiveSnapshot {
  const state = liveState(db);
  return {
    cursor: cursorOf(state.epoch, state.head),
    accounts: listAccounts(db),
    conversations: listConversations(db, owner),
    unread: unreadSummary(db, owner),
    page:
      timeline === undefined
        ? null
        : {
            timeline,
            entries: readHistory(db, owner, timeline, HistoryQuery.parse({})),
            position: readPosition(db, owner.id, resolveTimeline(db, owner, timeline).id),
          },
  };
}

const LiveRow = z.object({
  id: Id,
  kind: z.custom<LiveEvent["type"]>(
    (value) => typeof value === "string" && Object.hasOwn(PAYLOADS, value),
  ),
  subject: Id,
});

export function liveEvents(db: ChatDatabase, owner: Actor, cursor: string): LiveEvents {
  const state = liveState(db);
  const after = positionOf(cursor, state);
  if (after === undefined) return { status: "resnapshot" };
  const rows = db.all(
    LiveRow,
    "SELECT id, kind, subject FROM live_events WHERE id > ? ORDER BY id LIMIT ?",
    after,
    EVENTS_PER_READ,
  );
  return {
    status: "events",
    events: rows.map((row): LiveEvent => ({
      cursor: cursorOf(state.epoch, row.id),
      ...PAYLOADS[row.kind](db, owner, row.subject),
    })),
    unread: unreadSummary(db, owner),
  };
}

/** Delete the events older than the retention period, remembering the newest one deleted. */
export function pruneLive(db: ChatDatabase): void {
  db.run(
    `UPDATE live_state SET pruned_through = max(pruned_through,
       coalesce((SELECT max(id) FROM live_events WHERE at < ?), 0))`,
    db.now() - LIVE_RETENTION_MS,
  );
  db.run("DELETE FROM live_events WHERE id <= (SELECT pruned_through FROM live_state)");
}
