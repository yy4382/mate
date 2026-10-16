import { z } from "zod";
import type { Actor } from "./accounts.ts";
import { ChatError } from "./chat-error.ts";
import { readableConversation, type Conversation } from "./conversations.ts";
import type { ChatDatabase } from "./database.ts";
import { Id } from "./identifiers.ts";

/**
 * Where entries live: a conversation's top level, or the thread under one top-level message (named by that
 * message's ID).
 */
export const TimelineRef = z.union([
  z.object({ conversation: Id }).strict(),
  z.object({ thread: Id }).strict(),
]);
export type TimelineRef = z.output<typeof TimelineRef>;

const TimelineRow = z.object({
  id: Id,
  conversation_id: Id,
  root_entry_id: Id.nullable(),
  last_seq: z.number(),
});
type TimelineRow = z.output<typeof TimelineRow>;

export type Timeline = {
  readonly id: number;
  readonly ref: TimelineRef;
  readonly conversation: Conversation;
  /** The thread's root message, or null for a conversation's top level. */
  readonly rootEntryId: number | null;
};

const SELECT_TIMELINE = "SELECT id, conversation_id, root_entry_id, last_seq FROM timelines";

export const timelineRefOf = (row: {
  conversation_id: number;
  root_entry_id: number | null;
}): TimelineRef =>
  row.root_entry_id === null
    ? { conversation: row.conversation_id }
    : { thread: row.root_entry_id };

/** The timeline `ref` names, if `actor` may read its conversation; otherwise `not-found`. */
export function resolveTimeline(db: ChatDatabase, actor: Actor, ref: TimelineRef): Timeline {
  const row =
    "conversation" in ref
      ? db.get(
          TimelineRow,
          `${SELECT_TIMELINE} WHERE conversation_id = ? AND root_entry_id IS NULL`,
          ref.conversation,
        )
      : db.get(TimelineRow, `${SELECT_TIMELINE} WHERE root_entry_id = ?`, ref.thread);
  if (row === undefined)
    throw new ChatError("not-found", `timeline ${JSON.stringify(ref)} not found`);
  return withConversation(db, actor, row);
}

/** The timeline holding an entry, if `actor` may read it. */
export function timelineOfEntry(db: ChatDatabase, actor: Actor, entryId: number): Timeline {
  const row = db.get(
    TimelineRow,
    `${SELECT_TIMELINE} WHERE id = (SELECT timeline_id FROM entries WHERE id = ?)`,
    entryId,
  );
  if (row === undefined) throw new ChatError("not-found", `entry ${entryId} not found`);
  return withConversation(db, actor, row);
}

function withConversation(db: ChatDatabase, actor: Actor, row: TimelineRow): Timeline {
  return {
    id: row.id,
    ref: timelineRefOf(row),
    conversation: readableConversation(db, actor, row.conversation_id),
    rootEntryId: row.root_entry_id,
  };
}

export function lastSeq(db: ChatDatabase, timelineId: number): number {
  const row = db.get(TimelineRow, `${SELECT_TIMELINE} WHERE id = ?`, timelineId);
  if (row === undefined) throw new Error(`timeline ${timelineId} vanished`);
  return row.last_seq;
}

/** The top-level timeline of a conversation. */
export function topLevelTimeline(
  db: ChatDatabase,
  conversationId: number,
): { id: number; lastSeq: number } {
  const row = db.get(
    TimelineRow,
    `${SELECT_TIMELINE} WHERE conversation_id = ? AND root_entry_id IS NULL`,
    conversationId,
  );
  if (row === undefined)
    throw new Error(`conversation ${conversationId} has no top-level timeline`);
  return { id: row.id, lastSeq: row.last_seq };
}

/** Create a timeline: a conversation's top level (no root) or the thread of a top-level message. */
export function createTimeline(
  db: ChatDatabase,
  conversationId: number,
  rootEntryId: number | null,
): void {
  db.run(
    "INSERT INTO timelines (conversation_id, root_entry_id) VALUES (?, ?)",
    conversationId,
    rootEntryId,
  );
}
