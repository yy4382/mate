import { z } from "zod";
import { targetAccount, type Actor } from "./accounts.ts";
import { ChatError } from "./chat-error.ts";
import {
  conversationById,
  conversationView,
  isMember,
  readableConversation,
  requireWritable,
  type Conversation,
  type ConversationView,
} from "./conversations.ts";
import type { ChatDatabase } from "./database.ts";
import { Id } from "./identifiers.ts";
import { advanceReadPosition } from "./read-positions.ts";
import { createTimeline, topLevelTimeline } from "./timelines.ts";

export const ChannelInput = z.object({
  name: z.string().trim().min(1).max(80),
  visibility: z.enum(["public", "private"]),
});

const Created = z.object({ id: Id });

function createConversation(
  db: ChatDatabase,
  values: { kind: Conversation["kind"]; name: string | null; dmPair: [number, number] | null },
  members: readonly number[],
): Conversation {
  const created = db.get(
    Created,
    "INSERT INTO conversations (kind, name, dm_low, dm_high, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
    values.kind,
    values.name,
    values.dmPair?.[0] ?? null,
    values.dmPair?.[1] ?? null,
    db.now(),
  );
  if (created === undefined) throw new Error("conversation insert returned no row");
  createTimeline(db, created.id, null);
  for (const member of members) addMember(db, created.id, member);
  return conversationById(db, created.id);
}

function addMember(db: ChatDatabase, conversationId: number, account: number): void {
  db.run(
    "INSERT INTO memberships (conversation_id, account_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
    conversationId,
    account,
  );
}

/** Create a channel with its creator as the only member. */
export function createChannel(
  db: ChatDatabase,
  actor: Actor,
  input: z.output<typeof ChannelInput>,
): ConversationView {
  const channel = createConversation(
    db,
    { kind: input.visibility, name: input.name, dmPair: null },
    [actor.id],
  );
  return conversationView(db, actor, channel);
}

/** The single DM between `actor` and `other`, created on first use by either of them. */
export function openDm(db: ChatDatabase, actor: Actor, other: number): ConversationView {
  if (other === actor.id)
    throw new ChatError("invalid-target", "a DM needs two different accounts");
  const partner = targetAccount(db, other);
  const pair: [number, number] =
    actor.id < partner.id ? [actor.id, partner.id] : [partner.id, actor.id];
  const existing = db.get(
    Created,
    "SELECT id FROM conversations WHERE dm_low = ? AND dm_high = ?",
    ...pair,
  );
  if (existing !== undefined) return conversationView(db, actor, conversationById(db, existing.id));
  if (!partner.active) throw new ChatError("invalid-target", `account ${other} is deactivated`);
  return conversationView(
    db,
    actor,
    createConversation(db, { kind: "dm", name: null, dmPair: pair }, pair),
  );
}

function readableChannel(db: ChatDatabase, actor: Actor, conversationId: number): Conversation {
  const conversation = readableConversation(db, actor, conversationId);
  if (conversation.kind === "dm")
    throw new ChatError("invalid-target", "DM membership is fixed to its two accounts");
  return conversation;
}

/** Join a channel one can read. Joining does not move any read position. */
export function join(db: ChatDatabase, actor: Actor, conversationId: number): ConversationView {
  const channel = readableChannel(db, actor, conversationId);
  if (channel.archived)
    throw new ChatError("archived", `conversation ${conversationId} is archived`);
  addMember(db, channel.id, actor.id);
  return conversationView(db, actor, channel);
}

export function leave(db: ChatDatabase, actor: Actor, conversationId: number): ConversationView {
  const channel = readableChannel(db, actor, conversationId);
  db.run(
    "DELETE FROM memberships WHERE conversation_id = ? AND account_id = ?",
    channel.id,
    actor.id,
  );
  return conversationView(db, actor, channel);
}

/**
 * Add `invitee` to a channel at once. The history before the invitation does not count as the invitee's unread:
 * its top-level read position starts at the channel's newest entry.
 */
export function invite(
  db: ChatDatabase,
  actor: Actor,
  conversationId: number,
  invitee: number,
): ConversationView {
  const channel = readableChannel(db, actor, conversationId);
  requireWritable(db, actor, channel);
  const target = targetAccount(db, invitee);
  if (!target.active) throw new ChatError("invalid-target", `account ${invitee} is deactivated`);
  if (!isMember(db, target.id, channel.id)) {
    addMember(db, channel.id, target.id);
    const timeline = topLevelTimeline(db, channel.id);
    advanceReadPosition(db, target.id, timeline.id, timeline.lastSeq);
  }
  return conversationView(db, actor, channel);
}

/** Make a channel read-only, for good. Any member, or a human, may archive it. */
export function archiveChannel(
  db: ChatDatabase,
  actor: Actor,
  conversationId: number,
): ConversationView {
  const channel = readableChannel(db, actor, conversationId);
  if (actor.kind !== "human" && !isMember(db, actor.id, channel.id))
    throw new ChatError(
      "not-member",
      `account ${actor.id} is not a member of conversation ${channel.id}`,
    );
  db.run("UPDATE conversations SET archived = 1 WHERE id = ?", channel.id);
  return conversationView(db, actor, conversationById(db, channel.id));
}
