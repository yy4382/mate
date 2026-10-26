import { UnreadSummary } from "./contracts.ts";
export { UnreadSummary } from "./contracts.ts";
import { z } from "zod";
import type { Actor } from "./accounts.ts";
import { SqlBoolean, type ChatDatabase } from "./database.ts";
import { ConversationKind } from "./conversations.ts";
import { Id } from "./identifiers.ts";
import { TimelineRef, timelineRefOf } from "./timelines.ts";

/**
 * Notify, in the same transaction as the message, every active account other than its author that follows the
 * message's timeline (see the `followed_timelines` view). The message and its mentions must already be written, since
 * a reply's mentions make their accounts followers of the thread. Task entries never notify.
 */
export function notifyMessage(
  db: ChatDatabase,
  message: { entryId: number; author: number; timelineId: number },
): void {
  db.run(
    `INSERT INTO inbox_events (account_id, entry_id)
     SELECT a.id, ? FROM followed_timelines f JOIN accounts a ON a.id = f.account_id
     WHERE f.timeline_id = ? AND a.id <> ? AND a.active = 1
     ORDER BY a.id`,
    message.entryId,
    message.timelineId,
    message.author,
  );
}

const Mark = z.object({ mark: z.number() });
const Notified = z.object({ account_id: Id });

/** The newest inbox event ID so far; event IDs are never reused, so every later event lies above it. */
export function inboxMark(db: ChatDatabase): number {
  return db.get(Mark, "SELECT coalesce(max(id), 0) AS mark FROM inbox_events")?.mark ?? 0;
}

/** The distinct accounts that received an inbox event after `mark`, in account order. */
export function notifiedSince(db: ChatDatabase, mark: number): number[] {
  return db
    .all(
      Notified,
      "SELECT DISTINCT account_id FROM inbox_events WHERE id > ? ORDER BY account_id",
      mark,
    )
    .map((row) => row.account_id);
}

export const InboxEvent = z.object({
  eventId: Id,
  conversationId: Id,
  timeline: TimelineRef,
  messageId: Id,
  seq: z.number(),
  author: Id,
  mentionsYou: z.boolean(),
  direct: z.boolean(),
  inThread: z.boolean(),
});
export type InboxEvent = z.output<typeof InboxEvent>;

const EventRow = z.object({
  event_id: Id,
  conversation_id: Id,
  root_entry_id: Id.nullable(),
  entry_id: Id,
  seq: z.number(),
  author_id: Id,
  mention: SqlBoolean,
  kind: z.string(),
});

export const InboxQuery = z.object({
  after: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(1000).default(100),
});

/** The account's inbox events with an ID greater than `after`, oldest first. */
export function inboxEvents(
  db: ChatDatabase,
  account: number,
  query: z.output<typeof InboxQuery>,
): InboxEvent[] {
  return db
    .all(
      EventRow,
      `SELECT ev.id AS event_id, t.conversation_id, t.root_entry_id, e.id AS entry_id, e.seq, e.author_id, c.kind,
         EXISTS (SELECT 1 FROM mentions m WHERE m.entry_id = e.id AND m.account_id = ev.account_id) AS mention
       FROM inbox_events ev
       JOIN entries e ON e.id = ev.entry_id
       JOIN timelines t ON t.id = e.timeline_id
       JOIN conversations c ON c.id = t.conversation_id
       WHERE ev.account_id = ? AND ev.id > ? ORDER BY ev.id LIMIT ?`,
      account,
      query.after,
      query.limit,
    )
    .map((row) => ({
      eventId: row.event_id,
      conversationId: row.conversation_id,
      timeline: timelineRefOf(row),
      messageId: row.entry_id,
      seq: row.seq,
      author: row.author_id,
      mentionsYou: row.mention,
      direct: row.kind === "dm",
      inThread: row.root_entry_id !== null,
    }));
}

const SummaryRow = z.object({
  conversation_id: Id,
  root_entry_id: Id.nullable(),
  kind: ConversationKind,
  label: z.string(),
  unread: z.number(),
  mentions: z.number(),
  latest_sender: z.string(),
});

/**
 * Unread counts for the timelines the account follows, which are exactly the timelines whose messages notify it. A
 * count is the number of entries by others after
 * the account's read position, which is what `readUnread` reports as `unread`.
 */
export function unreadSummary(db: ChatDatabase, actor: Actor): UnreadSummary {
  const rows = db.all(
    SummaryRow,
    `WITH followed AS (
       SELECT t.id, t.conversation_id, t.root_entry_id FROM followed_timelines ft
       JOIN timelines t ON t.id = ft.timeline_id WHERE ft.account_id = ?1
     )
     SELECT f.conversation_id, f.root_entry_id, c.kind,
       CASE WHEN c.kind = 'dm'
         THEN (SELECT group_concat(handle, ', ') FROM (SELECT a.handle FROM accounts a
               WHERE a.id IN (c.dm_low, c.dm_high) AND a.id <> ?1 ORDER BY a.id))
         ELSE c.name END AS label,
       -- Every row has an unread entry by others, so the newest entry by others is an unread one.
       (SELECT a.handle FROM entries le JOIN accounts a ON a.id = le.author_id
        WHERE le.timeline_id = f.id AND le.author_id <> ?1 ORDER BY le.seq DESC LIMIT 1) AS latest_sender,
       count(e.id) AS unread,
       count(e.id) FILTER (WHERE EXISTS
         (SELECT 1 FROM mentions mn WHERE mn.entry_id = e.id AND mn.account_id = ?1)) AS mentions
     FROM followed f
     JOIN conversations c ON c.id = f.conversation_id
     JOIN entries e ON e.timeline_id = f.id AND e.author_id <> ?1
       AND e.seq > coalesce((SELECT seq FROM read_positions r WHERE r.account_id = ?1 AND r.timeline_id = f.id), 0)
     GROUP BY f.id ORDER BY f.id`,
    actor.id,
  );
  return {
    total: rows.reduce((sum, row) => sum + row.unread, 0),
    mentions: rows.reduce((sum, row) => sum + row.mentions, 0),
    timelines: rows.map((row) => ({
      conversationId: row.conversation_id,
      timeline: timelineRefOf(row),
      kind: row.kind,
      label: row.label,
      inThread: row.root_entry_id !== null,
      unread: row.unread,
      mentioned: row.mentions > 0,
      latestSender: row.latest_sender,
    })),
  };
}
