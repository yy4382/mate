import { z } from "zod";
import type { Actor } from "./accounts.ts";
import { ChatError } from "./chat-error.ts";
import { readableConversation, requireWritable } from "./conversations.ts";
import type { ChatDatabase } from "./database.ts";
import { Attachment, loadEntries, appendEntry } from "./entries.ts";
import { FreshnessOptions, ReadPage, freshWrite } from "./forward-reading.ts";
import { Id, RequestId } from "./identifiers.ts";
import { notifyMessage } from "./inbox.ts";
import { readableConversation as _rc, type Conversation } from "./conversations.ts";
import { TimelineRef, createTimeline, resolveTimeline } from "./timelines.ts";
import { insertTask, TaskTitle, type Task } from "./tasks.ts";
import type { Entry } from "./entries.ts";

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

/** A message that reached the timeline. `task` is present when `createTask` was passed. */
export const SentMessage = z.object({
  status: z.literal("sent"),
  conversationId: Id,
  timeline: TimelineRef,
  seq: z.number(),
  messageId: Id,
  task: z.object({ taskId: Id, title: z.string() }).nullable(),
});
export type SentMessage = z.output<typeof SentMessage>;

/** A message blocked by the freshness check: the timeline had new entries the caller had not read. */
export const HeldMessage = z.object({ status: z.literal("held"), page: ReadPage });

export const SendResult = z.discriminatedUnion("status", [SentMessage, HeldMessage]);
export type SendResult = z.output<typeof SendResult>;

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
  notifyMessage(db, { entryId, author: actor.id, timeline, mentions: request.mentions });
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
  const outcome = freshWrite(db, actor, timeline, request, () =>
    sendMessage(db, actor, timeline, request),
  );
  return "held" in outcome ? { status: "held", page: outcome.held } : outcome.written;
}

/** History: entries at or before `beforeSeq`, newest first, up to `limit`. Does not move the read position. */
export function readHistory(
  db: ChatDatabase,
  actor: Actor,
  ref: TimelineRef,
  { before = Number.MAX_SAFE_INTEGER, limit = 50 }: { before?: number; limit?: number },
): Entry[] {
  const timeline = resolveTimeline(db, actor, ref);
  return loadEntries(
    db,
    "e.timeline_id = ? AND e.seq <= ?",
    "e.seq DESC",
    timeline.id,
    before,
  ).slice(0, limit);
}

const SearchHit = z.object({ entry_id: Id, timeline_id: Id });

/** Full-text keyword search: all messages whose body contains `query` in any timeline `actor` can read. */
export function search(db: ChatDatabase, actor: Actor, query: string): Entry[] {
  const q = `%${query}%`;
  const hits = db.all(
    SearchHit,
    `SELECT e.id AS entry_id, e.timeline_id FROM entries e
     JOIN timelines t ON t.id = e.timeline_id
     JOIN conversations c ON c.id = t.conversation_id
     WHERE e.kind = 'message' AND e.body LIKE ?
       AND (? = 1 OR c.kind = 'public'
         OR EXISTS (SELECT 1 FROM memberships m WHERE m.conversation_id = c.id AND m.account_id = ?))
     ORDER BY e.id`,
    q,
    actor.owner ? 1 : 0,
    actor.id,
  );
  return loadEntries(
    db,
    `e.id IN (SELECT value FROM json_each(?))`,
    "e.seq",
    hits.map((hit) => hit.entry_id).join(",") === ""
      ? "[]"
      : JSON.stringify(hits.map((hit) => hit.entry_id)),
  );
}
