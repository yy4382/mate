import { agentDraftRowSchema, type AgentDraftRow } from "../rows.js";

import type { OwnerMessage } from "@mate/protocol/owner";
import { AgentToolRefusal } from "../errors.js";
import { messageRowSchema, toMessage } from "../rows.js";

import { conversationToolDefinitions } from "../tools/contracts.js";

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { defineConversationTool, type ConversationToolActions } from "../tools/actions.js";

import type { ConversationDirectory } from "../channels/directory.js";

import type { MessageWriter } from "./writer.js";

export class ConversationAttention {
  constructor(
    private readonly db: Database.Database,
    private readonly directory: ConversationDirectory,
    private readonly now: () => number,
    private readonly toolActions: ConversationToolActions,
  ) {}

  listAgentAttention(agentId: string, channelId: string) {
    return z
      .looseObject({
        messageId: z.string(),
        unread: z.number(),
        seen: z.number(),
        deferred: z.number(),
        muted: z.number(),
        presented: z.number(),
      })
      .array()
      .parse(
        this.db
          .prepare(
            `SELECT a.message_id AS messageId,a.unread,a.seen,a.deferred,a.muted,a.presented FROM owner_agent_message_attention a JOIN owner_messages m ON m.id=a.message_id WHERE a.agent_id=? AND m.channel_id=? ORDER BY m.order_seq`,
          )
          .all(agentId, channelId),
      );
  }

  readPersistedAgentDraft(agentId: string, id: string) {
    const row = z
      .looseObject({ state: z.string(), text: z.string(), channelId: z.string() })
      .optional()
      .parse(
        this.db
          .prepare(
            "SELECT state,text,channel_id AS channelId FROM owner_agent_drafts WHERE id=? AND agent_id=?",
          )
          .get(id, agentId),
      );
    return row;
  }

  private validateMessagePosition(channelId: string, rootId?: string, quoteId?: string): void {
    if (rootId && quoteId) throw new AgentToolRefusal("Choose one reply position");
    const id = rootId ?? quoteId;
    if (!id) return;
    const row = z
      .looseObject({ channel_id: z.string(), root_id: z.string().nullable() })
      .optional()
      .parse(this.db.prepare("SELECT channel_id,root_id FROM owner_messages WHERE id=?").get(id));
    if (!row || row.channel_id !== channelId || (rootId && row.root_id))
      throw new AgentToolRefusal("Reply target is not available");
  }

  /** Shared per-message freshness check for an authorized Agent send or task change. */
  inspectAgentPositionChanges(
    agentId: string,
    inputEndSequence: number,
    channelId: string,
    rootId?: string,
  ): { changes: OwnerMessage[] } {
    return {
      changes: this.unpresentedPositionMessages(agentId, inputEndSequence, channelId, rootId),
    };
  }

  private unpresentedPositionMessages(
    agentId: string,
    inputEndSequence: number,
    channelId: string,
    rootId?: string,
  ): OwnerMessage[] {
    const rows = messageRowSchema.array().parse(
      this.db
        .prepare(
          `SELECT m.id,m.channel_id,m.order_seq,m.text,m.root_id,m.quote_id,m.author_kind,m.author_id,m.created_at
      FROM owner_messages m WHERE m.channel_id=?
      AND NOT (m.author_kind='agent' AND m.author_id=?)
      AND (? IS NULL OR m.id=? OR m.root_id=?)
      AND NOT EXISTS (SELECT 1 FROM owner_agent_message_attention a WHERE a.agent_id=? AND a.message_id=m.id AND a.presented=1)
      AND NOT EXISTS (SELECT 1 FROM owner_message_deliveries d WHERE d.recipient_id=? AND d.recipient_kind='agent' AND d.message_id=m.id AND d.seq<=?)
      ORDER BY m.order_seq`,
        )
        .all(
          channelId,
          agentId,
          rootId ?? null,
          rootId ?? null,
          rootId ?? null,
          agentId,
          agentId,
          inputEndSequence,
        ),
    );
    return rows.map(toMessage);
  }

  private unreviewedDraftChanges(draft: AgentDraftRow): OwnerMessage[] {
    const rows = messageRowSchema.array().parse(
      this.db
        .prepare(
          `SELECT m.id,m.channel_id,m.order_seq,m.text,m.root_id,m.quote_id,m.author_kind,m.author_id,m.created_at
      FROM owner_messages m WHERE m.channel_id=?
      AND NOT (m.author_kind='agent' AND m.author_id=?)
      AND (? IS NULL OR m.id=? OR m.root_id=?)
      AND NOT EXISTS (SELECT 1 FROM owner_agent_draft_reviews r WHERE r.draft_id=? AND r.message_id=m.id)
      AND NOT EXISTS (SELECT 1 FROM owner_agent_message_attention a WHERE a.agent_id=? AND a.message_id=m.id AND a.presented=1)
      AND NOT EXISTS (SELECT 1 FROM owner_message_deliveries d WHERE d.recipient_id=? AND d.recipient_kind='agent' AND d.message_id=m.id AND d.seq<=?)
      ORDER BY m.order_seq`,
        )
        .all(
          draft.channel_id,
          draft.agent_id,
          draft.root_id,
          draft.root_id,
          draft.root_id,
          draft.id,
          draft.agent_id,
          draft.agent_id,
          draft.input_end_seq,
        ),
    );
    return rows.map(toMessage);
  }

  private recordDraftReviews(draftId: string, messages: OwnerMessage[]): void {
    for (const message of messages) {
      this.db
        .prepare("INSERT OR IGNORE INTO owner_agent_draft_reviews(draft_id,message_id) VALUES(?,?)")
        .run(draftId, message.id);
      const draft = z
        .looseObject({ agent_id: z.string() })
        .parse(this.db.prepare("SELECT agent_id FROM owner_agent_drafts WHERE id=?").get(draftId));
      this.db
        .prepare(
          "INSERT OR IGNORE INTO owner_agent_message_attention(agent_id,message_id,updated_at) VALUES(?,?,?)",
        )
        .run(draft.agent_id, message.id, this.now());
      this.db
        .prepare(
          "UPDATE owner_agent_message_attention SET presented=1,updated_at=? WHERE agent_id=? AND message_id=?",
        )
        .run(this.now(), draft.agent_id, message.id);
    }
  }

  private readAgentDraft(agentId: string, id: string) {
    const row = agentDraftRowSchema
      .optional()
      .parse(
        this.db
          .prepare(
            "SELECT id,agent_id,channel_id,root_id,quote_id,text,input_end_seq,state FROM owner_agent_drafts WHERE id=? AND agent_id=?",
          )
          .get(id, agentId),
      );
    if (!row) throw new AgentToolRefusal("Draft is not available");
    return row;
  }
  agentTools(messages: MessageWriter) {
    return {
      "attention.list": defineConversationTool(
        conversationToolDefinitions["attention.list"],
        (run, toolCallId, args) => {
          this.directory.requireAgentConversation(run.agent_id, args.conversationId);
          return {
            items: this.db
              .prepare(
                `SELECT a.message_id AS messageId,a.unread,a.seen,a.deferred,a.muted,a.presented,m.order_seq AS messageOrder,m.root_id AS rootId FROM owner_agent_message_attention a JOIN owner_messages m ON m.id=a.message_id WHERE a.agent_id=? AND m.channel_id=? ORDER BY m.order_seq`,
              )
              .all(run.agent_id, args.conversationId),
          };
        },
      ),

      "attention.update": defineConversationTool(
        conversationToolDefinitions["attention.update"],
        (run, toolCallId, args) => {
          this.directory.requireAgentConversation(run.agent_id, args.conversationId);
          const message = this.db
            .prepare("SELECT 1 FROM owner_messages WHERE id=? AND channel_id=?")
            .get(args.messageId, args.conversationId);
          if (!message) throw new AgentToolRefusal("Message is not available");
          return this.toolActions.record(run, toolCallId, "attention.update", args, () => {
            const changes = ["unread", "seen", "deferred", "muted"] as const;
            for (const key of changes)
              if (args[key] !== undefined)
                this.db
                  .prepare(
                    `UPDATE owner_agent_message_attention SET ${key}=?,updated_at=? WHERE agent_id=? AND message_id=?`,
                  )
                  .run(args[key] ? 1 : 0, this.now(), run.agent_id, args.messageId);
            return {
              conversationId: args.conversationId,
              messageId: args.messageId,
              updated: true,
            };
          });
        },
      ),

      "drafts.save": defineConversationTool(
        conversationToolDefinitions["drafts.save"],
        (run, toolCallId, args) => {
          this.directory.requireAgentConversation(run.agent_id, args.conversationId);
          this.validateMessagePosition(args.conversationId, args.rootId, args.quoteId);
          return this.toolActions.record(run, toolCallId, "drafts.save", args, () => {
            const id = randomUUID(),
              at = this.now(),
              freshness = this.inspectAgentPositionChanges(
                run.agent_id,
                run.input_end_seq,
                args.conversationId,
                args.rootId,
              );
            this.db
              .prepare(
                "INSERT INTO owner_agent_drafts(id,agent_id,channel_id,root_id,quote_id,text,input_end_seq,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'editing',?,?)",
              )
              .run(
                id,
                run.agent_id,
                args.conversationId,
                args.rootId ?? null,
                args.quoteId ?? null,
                args.text,
                run.input_end_seq,
                at,
                at,
              );
            this.recordDraftReviews(id, freshness.changes);
            return {
              id,
              channelId: args.conversationId,
              state: "editing",
              changes: freshness.changes,
            };
          });
        },
      ),

      "drafts.review": defineConversationTool(
        conversationToolDefinitions["drafts.review"],
        (run, toolCallId, args) => {
          const draft = this.readAgentDraft(run.agent_id, args.draftId);
          this.directory.requireAgentConversation(run.agent_id, draft.channel_id);
          return this.toolActions.record(run, toolCallId, "drafts.review", args, () => {
            const changes = this.unreviewedDraftChanges(draft);
            if (args.choice === "inspect") {
              this.recordDraftReviews(draft.id, changes);
              return {
                channelId: draft.channel_id,
                draftId: draft.id,
                state: draft.state,
                changes,
              };
            }
            if (args.choice === "continue" && changes.length)
              throw new AgentToolRefusal(
                "Conversation changed; inspect the draft before continuing",
              );
            if (draft.state === "sent" || draft.state === "abandoned")
              throw new AgentToolRefusal("Draft is closed");
            const state =
              args.choice === "revise"
                ? "editing"
                : args.choice === "keep"
                  ? "kept"
                  : args.choice === "defer"
                    ? "deferred"
                    : args.choice === "abandon"
                      ? "abandoned"
                      : "ready";
            if (args.choice === "revise" && !args.text)
              throw new AgentToolRefusal("Revised text is required");
            this.recordDraftReviews(draft.id, changes);
            this.db
              .prepare(
                "UPDATE owner_agent_drafts SET text=COALESCE(?,text),state=?,updated_at=? WHERE id=?",
              )
              .run(args.choice === "revise" ? args.text : null, state, this.now(), draft.id);
            return { channelId: draft.channel_id, draftId: draft.id, state, changes };
          });
        },
      ),

      "messages.send": defineConversationTool(
        conversationToolDefinitions["messages.send"],
        (run, toolCallId, args) => {
          this.directory.requireAgentConversation(run.agent_id, args.conversationId);
          this.validateMessagePosition(args.conversationId, args.rootId, args.quoteId);
          return this.toolActions.record(run, toolCallId, "messages.send", args, () => {
            if (!args.draftId) {
              const { changes } = this.inspectAgentPositionChanges(
                run.agent_id,
                run.input_end_seq,
                args.conversationId,
                args.rootId,
              );
              if (changes.length) {
                const id = randomUUID(),
                  at = this.now();
                this.db
                  .prepare(
                    "INSERT INTO owner_agent_drafts(id,agent_id,channel_id,root_id,quote_id,text,input_end_seq,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'editing',?,?)",
                  )
                  .run(
                    id,
                    run.agent_id,
                    args.conversationId,
                    args.rootId ?? null,
                    args.quoteId ?? null,
                    args.text,
                    run.input_end_seq,
                    at,
                    at,
                  );
                this.recordDraftReviews(id, changes);
                return {
                  channelId: args.conversationId,
                  status: "needs_review",
                  draftId: id,
                  changes,
                };
              }
            }
            if (args.draftId) {
              const draft = this.readAgentDraft(run.agent_id, args.draftId);
              if (
                draft.channel_id !== args.conversationId ||
                draft.root_id !== (args.rootId ?? null) ||
                draft.quote_id !== (args.quoteId ?? null) ||
                draft.text !== args.text ||
                draft.state !== "ready"
              )
                throw new AgentToolRefusal("Draft is not ready for this message");
              if (this.unreviewedDraftChanges(draft).length)
                throw new AgentToolRefusal("Conversation changed; review the draft again");
              this.db
                .prepare("UPDATE owner_agent_drafts SET state='sent',updated_at=? WHERE id=?")
                .run(this.now(), draft.id);
            }
            return messages.createAgentToolMessage(
              run,
              toolCallId,
              args.conversationId,
              args.text,
              args.rootId,
              args.quoteId,
              args.asTask,
            );
          });
        },
      ),
    };
  }
}
