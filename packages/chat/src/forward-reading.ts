import { ReadPage } from "./contracts.ts";
import { z } from "zod";
import type { Actor } from "./accounts.ts";
import type { ChatDatabase } from "./database.ts";
import { entryCosts, loadEntries } from "./entries.ts";
import { advanceReadPosition, readPosition } from "./read-positions.ts";
import { lastSeq, type Timeline } from "./timelines.ts";

/** How much one forward read may return: characters of text plus bytes of attachments. */
export const Budget = z.number().int().positive();
export const DEFAULT_BUDGET = 16_000;

/** Read forward from `reader`'s position: the newest entries that fit `budget`. Advances the position to the end. */
export function readForward(
  db: ChatDatabase,
  reader: Actor,
  timeline: Timeline,
  budget: number,
): ReadPage {
  const from = readPosition(db, reader.id, timeline.id);
  const end = lastSeq(db, timeline.id);
  const pending = entryCosts(db, timeline.id, from);
  let spent = 0;
  let firstReturned = end + 1;
  for (const entry of pending) {
    spent += entry.cost;
    if (spent > budget) break;
    firstReturned = entry.seq;
  }
  advanceReadPosition(db, reader.id, timeline.id, end);
  const skippedLast = firstReturned - 1;
  return {
    timeline: timeline.ref,
    entries: loadEntries(
      db,
      { where: "e.timeline_id = ? AND e.seq >= ?", order: "e.seq" },
      timeline.id,
      firstReturned,
    ),
    unread: pending.filter((entry) => entry.author_id !== reader.id).length,
    returned: firstReturned <= end ? { first: firstReturned, last: end } : null,
    skipped:
      skippedLast > from
        ? {
            first: from + 1,
            last: skippedLast,
            mentions: mentionsOf(db, reader, timeline.id, from, skippedLast),
          }
        : null,
    position: end,
  };
}

const MentionSeq = z.object({ seq: z.number() });

function mentionsOf(
  db: ChatDatabase,
  reader: Actor,
  timelineId: number,
  afterSeq: number,
  throughSeq: number,
): number[] {
  return db
    .all(
      MentionSeq,
      `SELECT e.seq FROM entries e JOIN mentions m ON m.entry_id = e.id
       WHERE e.timeline_id = ? AND e.seq > ? AND e.seq <= ? AND m.account_id = ? AND e.author_id <> ?
       ORDER BY e.seq`,
      timelineId,
      afterSeq,
      throughSeq,
      reader.id,
      reader.id,
    )
    .map((row) => row.seq);
}

const Count = z.object({ missed: z.number() });

/** Whether other accounts wrote in the timeline after `actor`'s read position. */
function missedEntries(db: ChatDatabase, actor: Actor, timelineId: number): boolean {
  const row = db.get(
    Count,
    "SELECT count(*) AS missed FROM entries WHERE timeline_id = ? AND seq > ? AND author_id <> ?",
    timelineId,
    readPosition(db, actor.id, timelineId),
    actor.id,
  );
  return (row?.missed ?? 0) > 0;
}

export const FreshnessOptions = {
  /** Refuse the write if others wrote after the actor's read position. The calling code decides; default on. */
  freshness: z.boolean().default(true),
  /** The read budget of the entries a refused write returns. */
  budget: Budget.default(DEFAULT_BUDGET),
};

/**
 * Run a write in a timeline behind the freshness check. If the check is on and others wrote entries the actor has
 * not read, nothing is written: the actor reads them instead. When the actor had seen everything before writing,
 * its read position moves past its own write, so its own entries never count as unread or hold it back.
 */
export function freshWrite<T>(
  db: ChatDatabase,
  actor: Actor,
  timeline: Timeline,
  options: { freshness: boolean; budget: number },
  write: () => T,
): { held: ReadPage } | { written: T } {
  const missed = missedEntries(db, actor, timeline.id);
  if (missed && options.freshness)
    return { held: readForward(db, actor, timeline, options.budget) };
  const written = write();
  if (!missed) advanceReadPosition(db, actor.id, timeline.id, lastSeq(db, timeline.id));
  return { written };
}
