import { z } from "zod";
import type { Actor } from "./accounts.ts";
import { SqlBoolean, type ChatDatabase } from "./database.ts";
import { Id } from "./identifiers.ts";
import { TimelineRef, timelineRefOf, type Timeline } from "./timelines.ts";

/**
 * Who a new message notifies, in the same transaction as the message:
 * - at a conversation's top level (channel or DM), every other member;
 * - in a thread, its participants (the root's author and everyone who replied) and everyone the reply mentions.
 * Only active accounts that can read the conversation are notified. Task entries never notify.
 */
export function notifyMessage(
  db: ChatDatabase,
  message: { entryId: number; author: number; timeline: Timeline; mentions: readonly number[] },
): void {
  const { timeline } = message;
  if (timeline.rootEntryId === null) {
    // Top-level message: every other active member of the conversation. Membership already implies
    // the right to read, so this needs no further visibility test.
    db.run(
      `INSERT INTO inbox_events (account_id, entry_id)
       SELECT a.id, ? FROM accounts a
       JOIN memberships m ON m.account_id = a.id AND m.conversation_id = ?
       WHERE a.id <> ? AND a.active = 1
       ORDER BY a.id`,
      message.entryId,
      timeline.conversation.id,
      message.author,
    );
  } else {
    // Thread reply: the thread's participants and everyone it mentions, but only while they can still
    // read the conversation — a participant who has left a private channel is not told about it again.
    db.run(
      `INSERT INTO inbox_events (account_id, entry_id)
       SELECT a.id, ? FROM accounts a
       WHERE a.id IN (
         SELECT author_id FROM entries WHERE id = ?
         UNION SELECT author_id FROM entries WHERE timeline_id = ? AND kind = 'message'
         UNION SELECT account_id FROM mentions WHERE entry_id = ?
       ) AND a.id <> ? AND a.active = 1
         AND (a.role = 'owner' OR ? = 'public' OR a.id IN
           (SELECT account_id FROM memberships WHERE conversation_id = ?))
       ORDER BY a.id`,
      message.entryId,
      timeline.rootEntryId,
      timeline.id,
      message.entryId,
      message.author,
      timeline.conversation.kind,
      timeline.conversation.id,
    );
  }
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

export const UnreadSummary = z.object({
  /** Unread entries by other accounts across all listed timelines. */
  total: z.number(),
  /** Unread messages that mention the account. */
  mentions: z.number(),
  timelines: z.array(
    z.object({
      conversationId: Id,
      timeline: TimelineRef,
      unread: z.number(),
      mentioned: z.boolean(),
    }),
  ),
});
export type UnreadSummary = z.output<typeof UnreadSummary>;

const SummaryRow = z.object({
  conversation_id: Id,
  root_entry_id: Id.nullable(),
  unread: z.number(),
  mentions: z.number(),
});

/**
 * Unread counts for the timelines that notify the account: the top level of every conversation it is a member of,
 * and every readable thread it took part in or was mentioned in. A count is the number of entries by others after
 * the account's read position, which is what `readUnread` reports as `unread`.
 */
export function unreadSummary(db: ChatDatabase, actor: Actor): UnreadSummary {
  const rows = db.all(
    SummaryRow,
    `WITH followed AS (
       SELECT t.id, t.conversation_id, t.root_entry_id FROM timelines t
       JOIN memberships m ON m.conversation_id = t.conversation_id AND m.account_id = ?1
       WHERE t.root_entry_id IS NULL
       UNION
       SELECT t.id, t.conversation_id, t.root_entry_id FROM timelines t
       JOIN conversations c ON c.id = t.conversation_id
       WHERE t.root_entry_id IS NOT NULL
         AND (?2 = 1 OR c.kind = 'public'
           OR EXISTS (SELECT 1 FROM memberships m WHERE m.conversation_id = c.id AND m.account_id = ?1))
         AND ((SELECT author_id FROM entries WHERE id = t.root_entry_id) = ?1
           OR EXISTS (SELECT 1 FROM entries e WHERE e.timeline_id = t.id AND e.author_id = ?1 AND e.kind = 'message')
           OR EXISTS (SELECT 1 FROM entries e JOIN mentions mn ON mn.entry_id = e.id
                      WHERE e.timeline_id = t.id AND mn.account_id = ?1))
     )
     SELECT f.conversation_id, f.root_entry_id,
       count(e.id) AS unread,
       count(e.id) FILTER (WHERE EXISTS
         (SELECT 1 FROM mentions mn WHERE mn.entry_id = e.id AND mn.account_id = ?1)) AS mentions
     FROM followed f
     JOIN entries e ON e.timeline_id = f.id AND e.author_id <> ?1
       AND e.seq > coalesce((SELECT seq FROM read_positions r WHERE r.account_id = ?1 AND r.timeline_id = f.id), 0)
     GROUP BY f.id ORDER BY f.id`,
    // ?1 is the account, ?2 whether it is the owner.
    actor.id,
    actor.owner ? 1 : 0,
  );
  return {
    total: rows.reduce((sum, row) => sum + row.unread, 0),
    mentions: rows.reduce((sum, row) => sum + row.mentions, 0),
    timelines: rows.map((row) => ({
      conversationId: row.conversation_id,
      timeline: timelineRefOf(row),
      unread: row.unread,
      mentioned: row.mentions > 0,
    })),
  };
}
