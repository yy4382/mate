import { z } from "zod";
import { targetAccount, type Actor } from "./accounts.ts";
import { Attachment, SentMessage, SendResult, TimelineRef, type Entry } from "./contracts.ts";
import { READABLE_BY, requireWritable, type Conversation } from "./conversations.ts";
import { idList, type ChatDatabase } from "./database.ts";
import { loadEntries, appendEntry } from "./entries.ts";
import { FreshnessOptions, freshWrite } from "./forward-reading.ts";
import { Id, RequestId } from "./identifiers.ts";
import { notifyMessage } from "./inbox.ts";
import { createTimeline, resolveTimeline } from "./timelines.ts";
import { insertTask, TaskTitle } from "./tasks.ts";

export const SendRequest = z.object({
  requestId: RequestId,
  body: z.string().min(1).max(20_000),
  attachments: z.array(Attachment).max(20).default([]),
  /**
   * Who the message notifies. It is a set: mentioning one account twice is the same statement as
   * mentioning it once, and the order accounts are listed in does not change the request. The
   * mentions table holds one row per (entry, account), and the requestId receipt keys on this value.
   */
  mentions: z
    .array(Id)
    .max(100)
    .transform((ids) => [...new Set(ids)].sort((left, right) => left - right))
    .default([]),
  createTask: z.object({ title: TaskTitle }).optional(),
  ...FreshnessOptions,
});

/** Send a message to `timeline`. One transaction: message, thread timeline (if top-level), task, and inbox events. */
export function sendMessage(
  db: ChatDatabase,
  actor: Actor,
  timeline: {
    id: number;
    ref: TimelineRef;
    conversation: Conversation;
    rootEntryId: number | null;
  },
  request: z.output<typeof SendRequest>,
): SentMessage {
  requireWritable(db, actor, timeline.conversation);
  const { entryId, seq } = appendEntry(db, timeline.id, {
    kind: "message",
    author: actor.id,
    body: request.body,
    attachments: request.attachments,
    mentions: request.mentions,
  });
  // Top-level messages create their own thread timeline so replies can be addressed to { thread: messageId }.
  if (timeline.rootEntryId === null) createTimeline(db, timeline.conversation.id, entryId);
  notifyMessage(db, { entryId, author: actor.id, timelineId: timeline.id });
  const newTask =
    request.createTask !== undefined
      ? insertTask(db, actor, { entryId, timelineId: timeline.id }, request.createTask.title)
      : null;
  return {
    status: "sent",
    conversationId: timeline.conversation.id,
    timeline: timeline.ref,
    seq,
    messageId: entryId,
    task: newTask !== null ? { taskId: newTask.task.taskId, title: newTask.task.title } : null,
  };
}

/** Validate and dispatch a send through the freshness gate and idempotency layer (managed by the caller). */
export function send(
  db: ChatDatabase,
  actor: Actor,
  ref: TimelineRef,
  request: z.output<typeof SendRequest>,
): SendResult {
  const timeline = resolveTimeline(db, actor, ref);
  // Every mentioned account must exist before anything is written, so the write itself has no refusal left in it.
  for (const mentioned of request.mentions) targetAccount(db, mentioned);
  const outcome = freshWrite(db, actor, timeline, request, () =>
    sendMessage(db, actor, timeline, request),
  );
  return "held" in outcome ? { status: "held", page: outcome.held } : outcome.written;
}

/** A page of history: entries at or before seq `before` (from the newest if absent), newest first. */
export const HistoryQuery = z.object({
  before: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(200).default(50),
});

/** History: the newest `limit` entries at or before `before`, newest first. Does not move the read position. */
export function readHistory(
  db: ChatDatabase,
  actor: Actor,
  ref: TimelineRef,
  { before, limit }: z.output<typeof HistoryQuery>,
): Entry[] {
  const timeline = resolveTimeline(db, actor, ref);
  return loadEntries(
    db,
    { where: "e.timeline_id = ? AND e.seq <= ?", order: "e.seq DESC", limit },
    timeline.id,
    before ?? Number.MAX_SAFE_INTEGER,
  );
}

/** A keyword, matched literally against message bodies. */
export const SearchQuery = z.string().min(1).max(1000);

/** At most this many hits come back: the newest ones. */
const SEARCH_LIMIT = 50;

const SearchHit = z.object({ entry_id: Id });

/** A LIKE pattern that matches `query` literally, so `%` and `_` are ordinary characters. */
const likeContains = (query: string): string => `%${query.replace(/[\\%_]/g, "\\$&")}%`;

/** Keyword search: the newest messages whose body contains `query` literally, in any timeline `actor` can read. */
export function search(db: ChatDatabase, actor: Actor, query: string): Entry[] {
  const hits = db.all(
    SearchHit,
    `SELECT e.id AS entry_id FROM entries e
     JOIN timelines t ON t.id = e.timeline_id
     JOIN conversations c ON c.id = t.conversation_id
     ${READABLE_BY}
     WHERE e.kind = 'message' AND e.body LIKE ? ESCAPE '\\'
     ORDER BY e.id DESC LIMIT ?`,
    actor.id,
    likeContains(query),
    SEARCH_LIMIT,
  );
  return loadEntries(
    db,
    { where: "e.id IN (SELECT value FROM json_each(?))", order: "e.id" },
    idList(hits.map((hit) => hit.entry_id)),
  );
}
