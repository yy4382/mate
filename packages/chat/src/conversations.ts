import { ConversationView, ConversationKind } from "./contracts.ts";
import { z } from "zod";
import type { Actor } from "./accounts.ts";
import { ChatError } from "./chat-error.ts";
import { SqlBoolean, idList, type ChatDatabase } from "./database.ts";
import { Id } from "./identifiers.ts";
export { ConversationView, ConversationKind } from "./contracts.ts";

const ConversationRow = z.object({
  id: Id,
  kind: ConversationKind,
  name: z.string().nullable(),
  archived: SqlBoolean,
});
export type Conversation = z.output<typeof ConversationRow>;

const SELECT_CONVERSATION = "SELECT c.id, c.kind, c.name, c.archived FROM conversations c";

/**
 * Restricts `c` to the conversations account `?` may read. The rule itself lives in the `readable_conversations`
 * view, which every visibility test in the chat app selects from.
 */
export const READABLE_BY =
  "JOIN readable_conversations r ON r.conversation_id = c.id AND r.account_id = ?";

const Exists = z.object({ found: SqlBoolean });

export function isMember(db: ChatDatabase, account: number, conversationId: number): boolean {
  return (
    db.get(
      Exists,
      "SELECT EXISTS (SELECT 1 FROM memberships WHERE conversation_id = ? AND account_id = ?) AS found",
      conversationId,
      account,
    )?.found ?? false
  );
}

/**
 * The conversation, if `actor` may read it. A conversation the actor may not read is reported exactly like one that
 * does not exist.
 */
export function readableConversation(
  db: ChatDatabase,
  actor: Actor,
  conversationId: number,
): Conversation {
  const conversation = db.get(
    ConversationRow,
    `${SELECT_CONVERSATION} ${READABLE_BY} WHERE c.id = ?`,
    actor.id,
    conversationId,
  );
  if (conversation === undefined)
    throw new ChatError("not-found", `conversation ${conversationId} not found`);
  return conversation;
}

/** Acting in a conversation (posting, task actions, attachments, inviting) needs membership, and it not archived. */
export function requireWritable(db: ChatDatabase, actor: Actor, conversation: Conversation): void {
  if (!isMember(db, actor.id, conversation.id))
    throw new ChatError(
      "not-member",
      `account ${actor.id} is not a member of conversation ${conversation.id}`,
    );
  if (conversation.archived)
    throw new ChatError("archived", `conversation ${conversation.id} is archived`);
}

/** Every conversation `actor` may read, in creation order. */
export function listConversations(db: ChatDatabase, actor: Actor): ConversationView[] {
  const readable = db.all(
    ConversationRow,
    `${SELECT_CONVERSATION} ${READABLE_BY} ORDER BY c.id`,
    actor.id,
  );
  return views(db, actor, readable);
}

export function conversationView(
  db: ChatDatabase,
  actor: Actor,
  conversation: Conversation,
): ConversationView {
  const [view] = views(db, actor, [conversation]);
  if (view === undefined) throw new Error(`no view for conversation ${conversation.id}`);
  return view;
}

const MemberRow = z.object({ conversation_id: Id, account_id: Id });

function views(db: ChatDatabase, actor: Actor, conversations: Conversation[]): ConversationView[] {
  const members = Map.groupBy(
    db.all(
      MemberRow,
      `SELECT conversation_id, account_id FROM memberships
       WHERE conversation_id IN (SELECT value FROM json_each(?)) ORDER BY account_id`,
      idList(conversations.map((conversation) => conversation.id)),
    ),
    (row) => row.conversation_id,
  );
  return conversations.map((conversation) => {
    const accountIds = (members.get(conversation.id) ?? []).map((row) => row.account_id);
    return {
      conversationId: conversation.id,
      kind: conversation.kind,
      name: conversation.name,
      archived: conversation.archived,
      member: accountIds.includes(actor.id),
      members: accountIds,
    };
  });
}

/** Load a conversation by ID without a visibility check, for code that has already established access. */
export function conversationById(db: ChatDatabase, conversationId: number): Conversation {
  const conversation = db.get(
    ConversationRow,
    `${SELECT_CONVERSATION} WHERE c.id = ?`,
    conversationId,
  );
  if (conversation === undefined) throw new Error(`conversation ${conversationId} vanished`);
  return conversation;
}
