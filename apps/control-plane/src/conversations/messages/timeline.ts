import type { OwnerMessage, OwnerMessagePage } from "@mate/protocol/owner";
import { AgentToolRefusal } from "../errors.js";
import { messageRowSchema, toMessage } from "../rows.js";
import { conversationToolDefinitions } from "../tools/contracts.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { defineConversationTool } from "../tools/actions.js";
import type { ConversationDirectory } from "../channels/directory.js";

const messageProjectionSql = `SELECT id,channel_id,order_seq,text,root_id,quote_id,author_kind,author_id,created_at
  FROM owner_messages`;

export class MessageTimeline {
  constructor(
    private readonly db: Database.Database,
    private readonly directory: ConversationDirectory,
    private readonly now: () => number,
  ) {}

  listMessages(
    channelId: string,
    before: number | undefined,
    limit: number,
  ): OwnerMessagePage | undefined {
    if (!this.db.prepare("SELECT 1 FROM owner_channels WHERE id=?").get(channelId))
      return undefined;
    const rows = messageRowSchema.array().parse(
      this.db
        .prepare(
          `${messageProjectionSql}
             WHERE channel_id=? AND root_id IS NULL AND internal_kind IS NULL
               AND (? IS NULL OR order_seq < ?)
             ORDER BY order_seq DESC LIMIT ?`,
        )
        .all(channelId, before ?? null, before ?? null, limit + 1),
    );
    const hasMore = rows.length > limit;
    const messages = rows
      .slice(0, limit)
      .reverse()
      .map((row) => this.withReplyPreview(toMessage(row)));
    return { messages, nextBefore: hasMore ? (messages[0]?.order ?? null) : null };
  }

  messageContext(channelId: string, messageId: string) {
    const row = messageRowSchema.optional().parse(
      this.db
        .prepare(
          `${messageProjectionSql}
             WHERE id=? AND channel_id=? AND internal_kind IS NULL`,
        )
        .get(messageId, channelId),
    );
    if (!row) return undefined;
    if (row.root_id) {
      const thread = this.listThread(channelId, row.root_id);
      return thread ? { kind: "thread" as const, messageId, thread } : undefined;
    }
    const page = this.listMessages(channelId, row.order_seq + 1, 50);
    if (!page) return undefined;
    const latest = this.listMessages(channelId, undefined, 1)?.messages[0];
    return { kind: "timeline" as const, messageId, page, hasNewer: latest?.id !== messageId };
  }

  listThread(
    channelId: string,
    rootId: string,
  ): { root: OwnerMessage; replies: OwnerMessage[] } | undefined {
    const root = messageRowSchema.optional().parse(
      this.db
        .prepare(
          `${messageProjectionSql}
             WHERE id=? AND channel_id=? AND root_id IS NULL AND internal_kind IS NULL`,
        )
        .get(rootId, channelId),
    );
    if (!root) return undefined;
    const replies = messageRowSchema.array().parse(
      this.db
        .prepare(
          `${messageProjectionSql}
             WHERE channel_id=? AND root_id=? ORDER BY order_seq`,
        )
        .all(channelId, rootId),
    );
    return { root: this.withReplyPreview(toMessage(root)), replies: replies.map(toMessage) };
  }

  private withReplyPreview(message: OwnerMessage) {
    const rows = messageRowSchema.array().parse(
      this.db
        .prepare(
          `${messageProjectionSql}
             WHERE channel_id=? AND root_id=? ORDER BY order_seq DESC LIMIT 3`,
        )
        .all(message.channelId, message.id),
    );
    const count = z
      .looseObject({ count: z.number() })
      .parse(
        this.db
          .prepare("SELECT COUNT(*) AS count FROM owner_messages WHERE channel_id=? AND root_id=?")
          .get(message.channelId, message.id),
      );
    return { ...message, replyCount: count.count, recentReplies: rows.reverse().map(toMessage) };
  }

  agentTools() {
    return {
      "conversations.read": defineConversationTool(
        conversationToolDefinitions["conversations.read"],
        (run, toolCallId, args) => {
          const conversation = this.directory.requireReadableConversation(
            run.agent_id,
            args.conversationId,
          );
          const before = args.before === undefined ? undefined : Number(args.before);
          if (before !== undefined && !Number.isSafeInteger(before)) throw new z.ZodError([]);
          const page = this.listMessages(args.conversationId, before, args.limit);
          if (!page) throw new AgentToolRefusal("Conversation is not available");
          for (const message of page.messages)
            this.db
              .prepare(
                "UPDATE owner_agent_message_attention SET presented=1,updated_at=? WHERE agent_id=? AND message_id=?",
              )
              .run(this.now(), run.agent_id, message.id);
          return { conversation, ...page };
        },
      ),

      "conversations.read_thread": defineConversationTool(
        conversationToolDefinitions["conversations.read_thread"],
        (run, toolCallId, args) => {
          this.directory.requireReadableConversation(run.agent_id, args.conversationId);
          const thread = this.listThread(args.conversationId, args.rootId);
          if (!thread) throw new AgentToolRefusal("Thread is not available");
          for (const message of [thread.root, ...thread.replies])
            this.db
              .prepare(
                "UPDATE owner_agent_message_attention SET presented=1,updated_at=? WHERE agent_id=? AND message_id=?",
              )
              .run(this.now(), run.agent_id, message.id);
          return thread;
        },
      ),
    };
  }
}
