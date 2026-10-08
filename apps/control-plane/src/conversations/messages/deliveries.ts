import { ownerPrincipalKindSchema } from "@mate/protocol/owner";
import { pendingDeliveryRowSchema, toMessage } from "../rows.js";
import type {
  OwnerMessage,
  OwnerMessageDeliveryPage,
  OwnerPrincipalKind,
} from "@mate/protocol/owner";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const defaultDeliveryPageSize = 100;
const maximumDeliveryPageSize = 500;

export class MessageDeliveries {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number,
  ) {}

  listPendingDeliveries(
    recipientKind: OwnerPrincipalKind,
    recipientId: string,
    after = 0,
    limit = defaultDeliveryPageSize,
  ): OwnerMessageDeliveryPage {
    if (!Number.isSafeInteger(after) || after < 0)
      throw new Error("Delivery cursor must be a non-negative safe integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumDeliveryPageSize)
      throw new Error("Delivery page size must be between 1 and 500");
    const rows = pendingDeliveryRowSchema.array().parse(
      this.db
        .prepare(
          `SELECT d.seq AS delivery_sequence,d.id AS delivery_id,d.message_id,d.channel_id,
                d.recipient_kind,d.recipient_id,d.state,d.created_at AS delivery_created_at,
                m.order_seq,m.text,m.root_id,m.quote_id,m.author_kind,m.author_id,m.created_at
         FROM owner_message_deliveries d JOIN owner_messages m ON m.id=d.message_id
         WHERE d.recipient_kind=? AND d.recipient_id=? AND d.state='pending' AND d.seq>?
         ORDER BY d.seq LIMIT ?`,
        )
        .all(recipientKind, recipientId, after, limit + 1),
    );
    const hasMore = rows.length > limit;
    const deliveries = rows.slice(0, limit).map((row) => ({
      sequence: row.delivery_sequence,
      id: row.delivery_id,
      messageId: row.message_id,
      channelId: row.channel_id,
      recipient: { kind: row.recipient_kind, id: row.recipient_id },
      state: row.state,
      createdAt: row.delivery_created_at,
      message: toMessage({
        id: row.message_id,
        channel_id: row.channel_id,
        order_seq: row.order_seq,
        text: row.text,
        root_id: row.root_id,
        quote_id: row.quote_id,
        author_kind: row.author_kind,
        author_id: row.author_id,
        created_at: row.created_at,
      }),
    }));
    return {
      deliveries,
      nextAfter: hasMore ? (deliveries.at(-1)?.sequence ?? after) : null,
    };
  }

  acknowledgeDelivery(
    deliveryId: string,
    recipientKind: OwnerPrincipalKind,
    recipientId: string,
  ): boolean {
    const reminder = this.db
      .prepare("SELECT 1 FROM owner_reminder_firings WHERE delivery_id=?")
      .get(deliveryId);
    if (
      reminder &&
      !this.db
        .prepare(
          "SELECT 1 FROM owner_agent_runs WHERE delivery_id=? AND agent_id=? AND state='completed'",
        )
        .get(deliveryId, recipientId)
    )
      return false;
    return (
      this.db
        .prepare(
          "UPDATE owner_message_deliveries SET state='handled',handled_at=? WHERE id=? AND recipient_kind=? AND recipient_id=? AND state='pending'",
        )
        .run(this.now(), deliveryId, recipientKind, recipientId).changes === 1
    );
  }

  /**
   * Complete a successful run and mark only the deliveries its boundary captured as handled.
   * Speaking, staying silent and completing a run are separate facts: this never changes a task.
   */
  completeAgentRun(runId: string, agentId: string): boolean {
    return this.db
      .transaction(() => {
        const run = z
          .looseObject({
            state: z.string(),
            input_end_seq: z.number(),
            session_id: z.string(),
            channel_id: z.string(),
            channel_archived: z.number(),
            delivery_kind: z.string().nullable(),
            input_start_seq: z.number(),
          })
          .optional()
          .parse(
            this.db
              .prepare(
                `SELECT r.state,r.input_end_seq,s.id AS session_id,d.channel_id,
                    c.archived AS channel_archived,m.internal_kind AS delivery_kind,
                    d.seq AS input_start_seq
             FROM owner_agent_runs r JOIN owner_agent_sessions s ON s.agent_id=r.agent_id
             JOIN owner_message_deliveries d ON d.id=r.delivery_id
             JOIN owner_channels c ON c.id=d.channel_id
             JOIN owner_messages m ON m.id=d.message_id
             WHERE r.id=? AND r.agent_id=?`,
              )
              .get(runId, agentId),
          );
        if (!run || run.state !== "running") return false;
        const at = this.now();
        if (run.channel_archived === 1 && run.delivery_kind !== "reminder") {
          this.db
            .prepare(
              `UPDATE owner_agent_runs SET state='failed',error_code='channel_archived',
                 retry_at=NULL,completed_at=? WHERE id=? AND agent_id=? AND state='running'`,
            )
            .run(at, runId, agentId);
          return false;
        }
        this.db
          .prepare(
            `UPDATE owner_message_deliveries SET state='handled',handled_at=?
         WHERE recipient_kind='agent' AND recipient_id=? AND channel_id=? AND state='pending'
               AND message_id IN (
                 SELECT d.message_id FROM owner_message_deliveries d
                 JOIN owner_messages m ON m.id=d.message_id
                 WHERE d.recipient_id=? AND d.recipient_kind='agent'
                   AND d.seq>=? AND d.seq<=?
                   AND (?=0 OR m.internal_kind='reminder')
               )`,
          )
          .run(
            at,
            agentId,
            run.channel_id,
            agentId,
            run.input_start_seq,
            run.input_end_seq,
            run.delivery_kind === "reminder" ? 1 : 0,
          );
        this.db
          .prepare(
            `UPDATE owner_agent_runs SET state='completed',completed_at=?,retry_at=NULL,error_code=NULL
             WHERE id=? AND agent_id=? AND state='running'`,
          )
          .run(at, runId, agentId);
        return true;
      })
      .immediate();
  }

  queueDeliveries(message: OwnerMessage, at: number): void {
    if (!this.db.inTransaction)
      throw new Error("Message deliveries require the message transaction");
    // This is the recipient snapshot: later membership changes never backfill this message.
    const members = z
      .looseObject({ principal_kind: ownerPrincipalKindSchema, principal_id: z.string() })
      .array()
      .parse(
        this.db
          .prepare(
            "SELECT principal_kind,principal_id FROM owner_channel_memberships WHERE channel_id=? AND active=1 ORDER BY principal_kind,principal_id",
          )
          .all(message.channelId),
      );
    for (const member of members) {
      if (
        member.principal_kind === message.author.kind &&
        member.principal_id === message.author.id
      )
        continue;
      this.db
        .prepare(
          "INSERT OR IGNORE INTO owner_message_deliveries(id,message_id,channel_id,recipient_kind,recipient_id,state,created_at) VALUES(?,?,?,?,?,'pending',?)",
        )
        .run(
          randomUUID(),
          message.id,
          message.channelId,
          member.principal_kind,
          member.principal_id,
          at,
        );
      if (member.principal_kind === "agent")
        this.db
          .prepare(
            "INSERT OR IGNORE INTO owner_agent_message_attention(agent_id,message_id,updated_at) SELECT id,?,? FROM owner_agents WHERE id=?",
          )
          .run(message.id, at, member.principal_id);
    }
  }
}
