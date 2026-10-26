import { Attachment, TaskChange, Entry } from "./contracts.ts";
export { Attachment, TaskChange, MessageEntry, TaskEntry, Entry } from "./contracts.ts";
import { z } from "zod";
import { idList, type ChatDatabase } from "./database.ts";
import { Id } from "./identifiers.ts";

const EntryRow = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    id: Id,
    seq: z.number(),
    author_id: Id,
    created_at: z.number(),
    body: z.string(),
  }),
  z.object({
    kind: z.literal("task"),
    id: Id,
    seq: z.number(),
    author_id: Id,
    created_at: z.number(),
    task_id: Id,
    change: TaskChange,
    task_owner_id: Id.nullable(),
    title: z.string(),
    message_id: Id,
  }),
]);

const SELECT_ENTRY = `SELECT e.id, e.seq, e.kind, e.author_id, e.created_at, e.body, e.task_id, e.change,
  e.task_owner_id, t.title, t.message_id FROM entries e LEFT JOIN tasks t ON t.id = e.task_id`;

const AttachmentRow = z.object({
  entry_id: Id,
  name: z.string(),
  size: z.number(),
  storage_key: z.string(),
});
const MentionRow = z.object({ entry_id: Id, account_id: Id });

/**
 * Load the entries `where` selects (a SQL predicate over `e`, the entries table), ordered by `order`, at most `limit`
 * of them.
 */
export function loadEntries(
  db: ChatDatabase,
  select: { where: string; order: string; limit?: number },
  ...params: (number | string)[]
): Entry[] {
  const rows = db.all(
    EntryRow,
    `${SELECT_ENTRY} WHERE ${select.where} ORDER BY ${select.order} LIMIT ?`,
    ...params,
    select.limit ?? -1,
  );
  const ids = idList(rows.map((row) => row.id));
  const attachments = Map.groupBy(
    db.all(
      AttachmentRow,
      `SELECT entry_id, name, size, storage_key FROM attachments
       WHERE entry_id IN (SELECT value FROM json_each(?)) ORDER BY entry_id, position`,
      ids,
    ),
    (row) => row.entry_id,
  );
  const mentions = Map.groupBy(
    db.all(
      MentionRow,
      `SELECT entry_id, account_id FROM mentions
       WHERE entry_id IN (SELECT value FROM json_each(?)) ORDER BY account_id`,
      ids,
    ),
    (row) => row.entry_id,
  );
  return rows.map((row): Entry =>
    row.kind === "message"
      ? {
          kind: "message",
          seq: row.seq,
          messageId: row.id,
          author: row.author_id,
          body: row.body,
          attachments: (attachments.get(row.id) ?? []).map((attachment) => ({
            name: attachment.name,
            size: attachment.size,
            storageKey: attachment.storage_key,
          })),
          mentions: (mentions.get(row.id) ?? []).map((mention) => mention.account_id),
          at: row.created_at,
        }
      : {
          kind: "task",
          seq: row.seq,
          taskId: row.task_id,
          messageId: row.message_id,
          actor: row.author_id,
          change: row.change,
          title: row.title,
          owner: row.task_owner_id,
          at: row.created_at,
        },
  );
}

const Appended = z.object({ id: Id });
const NextSeq = z.object({ last_seq: z.number() });

type NewEntry =
  | {
      kind: "message";
      author: number;
      body: string;
      attachments: readonly z.output<typeof Attachment>[];
      mentions: readonly number[];
    }
  | {
      kind: "task";
      author: number;
      taskId: number;
      change: z.output<typeof TaskChange>;
      owner: number | null;
    };

/** Append an entry at the next sequence number of a timeline. */
export function appendEntry(
  db: ChatDatabase,
  timelineId: number,
  entry: NewEntry,
): { entryId: number; seq: number } {
  const seq = db.get(
    NextSeq,
    "UPDATE timelines SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq",
    timelineId,
  )?.last_seq;
  if (seq === undefined) throw new Error(`timeline ${timelineId} vanished`);
  const appended =
    entry.kind === "message"
      ? db.get(
          Appended,
          `INSERT INTO entries (timeline_id, seq, kind, author_id, created_at, body)
           VALUES (?, ?, 'message', ?, ?, ?) RETURNING id`,
          timelineId,
          seq,
          entry.author,
          db.now(),
          entry.body,
        )
      : db.get(
          Appended,
          `INSERT INTO entries (timeline_id, seq, kind, author_id, created_at, task_id, change, task_owner_id)
           VALUES (?, ?, 'task', ?, ?, ?, ?, ?) RETURNING id`,
          timelineId,
          seq,
          entry.author,
          db.now(),
          entry.taskId,
          entry.change,
          entry.owner,
        );
  if (appended === undefined) throw new Error("entry insert returned no row");
  if (entry.kind === "message") {
    entry.attachments.forEach((attachment, position) =>
      db.run(
        "INSERT INTO attachments (entry_id, position, name, size, storage_key) VALUES (?, ?, ?, ?, ?)",
        appended.id,
        position,
        attachment.name,
        attachment.size,
        attachment.storageKey,
      ),
    );
    for (const account of entry.mentions)
      db.run("INSERT INTO mentions (entry_id, account_id) VALUES (?, ?)", appended.id, account);
  }
  return { entryId: appended.id, seq };
}

/**
 * The read cost of an entry: its characters plus the bytes of its attachments. A task entry costs its title.
 * Used by `costs` below; kept as one SQL expression so the budget is computed in one place.
 */
const ENTRY_COST = `CASE e.kind
  WHEN 'message' THEN length(e.body)
    + coalesce((SELECT sum(a.size) FROM attachments a WHERE a.entry_id = e.id), 0)
  ELSE (SELECT length(t.title) FROM tasks t WHERE t.id = e.task_id) END`;

const CostRow = z.object({ seq: z.number(), author_id: Id, cost: z.number() });

/** Seq, author and read cost of every entry after `afterSeq`, newest first. */
export function entryCosts(db: ChatDatabase, timelineId: number, afterSeq: number) {
  return db.all(
    CostRow,
    `SELECT e.seq, e.author_id, ${ENTRY_COST} AS cost FROM entries e
     WHERE e.timeline_id = ? AND e.seq > ? ORDER BY e.seq DESC`,
    timelineId,
    afterSeq,
  );
}
