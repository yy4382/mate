import {
  agentDraftRowSchema,
  conversationRowSchema,
  type AgentDraftRow,
  type ConversationRow,
} from "./rows.js";
import { channelVisibilitySchema, ownerPrincipalKindSchema } from "@mate/protocol/owner";
import {
  channelRowSchema,
  messageRowSchema,
  eventRowSchema,
  pendingDeliveryRowSchema,
} from "./rows.js";
import { toChannel, toMessage } from "./rows.js";
import { AgentToolRefusal, ArchivedChannelError } from "./errors.js";
import type {
  ChannelVisibility,
  OwnerPrincipalKind,
  OwnerChannel,
  OwnerMessage,
  OwnerTask,
  OwnerMessagePage,
  OwnerMessageDeliveryPage,
  OwnerChatSnapshot,
  OwnerChatEvent,
} from "@mate/protocol/owner";
import type { AgentConversationFacts, NewOwnerChannel, OwnerChannelUpdate } from "./contracts.js";
import { conversationToolDefinitions } from "./tool-contracts.js";
import { AgentSession } from "../runtime/session/service.js";
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CurrentAgentToolRun } from "../runtime/tools/entry.js";
import { nodeAccountOf } from "../nodes/directory.js";

import { TaskService } from "./tasks.js";
import { ConversationToolActions, defineConversationTool } from "./tool-actions.js";

const eventRetention = 1000;

/** Owner-facing channel facts committed in the control-plane database. */
export class OwnerChat {
  private readonly toolActions: ConversationToolActions;
  private readonly tasks: TaskService;
  private pushMessage?: (message: OwnerMessage, directToOwner: boolean) => void;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {
    this.toolActions = new ConversationToolActions(db, now);
    this.tasks = new TaskService(
      db,
      {
        requireMembership: (agentId, channelId) => {
          this.requireAgentConversation(agentId, channelId);
        },
        isMember: (agentId, channelId) => this.isAgentChannelMember(agentId, channelId),
        inspectPositionChanges: (agentId, sequence, channelId, rootId) =>
          this.inspectAgentPositionChanges(agentId, sequence, channelId, rootId),
        ownerDirectChannel: (agentId) => this.getOrCreateAgentDirectChannel(agentId),
        recordTaskEvent: (kind, channelId, task) => this.record(kind, channelId, task),
      },
      now,
      this.toolActions,
    );
  }

  setPushHandler(handler: (message: OwnerMessage, directToOwner: boolean) => void): void {
    this.pushMessage = handler;
  }

  createChannel(input: NewOwnerChannel): OwnerChannel {
    const id = randomUUID(),
      at = this.now();
    return this.db
      .transaction(() => {
        this.db
          .prepare(
            "INSERT INTO owner_channels(id,name,description,visibility,created_at,updated_at) VALUES(?,?,?,?,?,?)",
          )
          .run(id, input.name, input.description, input.visibility, at, at);
        this.db
          .prepare(
            "INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at) VALUES(?,'human','owner',1,?)",
          )
          .run(id, at);
        const channel = this.readChannel(id);
        this.record("channel.created", channel.id, channel);
        return channel;
      })
      .immediate();
  }

  listChannels(): OwnerChannel[] {
    const rows = channelRowSchema
      .array()
      .parse(
        this.db
          .prepare(
            "SELECT id,name,description,visibility,archived,created_at,updated_at FROM owner_channels ORDER BY created_at,id",
          )
          .all(),
      );
    return rows.map(toChannel);
  }

  listInvitableChannels(): OwnerChannel[] {
    const rows = channelRowSchema.array().parse(
      this.db
        .prepare(
          `SELECT c.id,c.name,c.description,c.visibility,c.archived,c.created_at,c.updated_at
         FROM owner_channels c
         WHERE c.archived=0
           AND NOT EXISTS (SELECT 1 FROM owner_agent_direct_channels d WHERE d.channel_id=c.id)
           AND NOT EXISTS (SELECT 1 FROM owner_agent_peer_direct_channels p WHERE p.channel_id=c.id)
         ORDER BY c.created_at,c.id`,
        )
        .all(),
    );
    return rows.map(toChannel);
  }

  /** Create or return the one private owner conversation bound to this verified Agent. */
  getOrCreateAgentDirectChannel(agentId: string): OwnerChannel | undefined {
    return this.db
      .transaction(() => {
        const agent = z
          .looseObject({ id: z.string(), name: z.string(), stage: z.string() })
          .optional()
          .parse(
            this.db
              .prepare("SELECT a.id,a.name,a.stage FROM owner_agents a WHERE a.id=?")
              .get(agentId),
          );
        if (!agent || agent.stage !== "complete") return undefined;
        const existing = channelRowSchema.optional().parse(
          this.db
            .prepare(
              `SELECT c.id,c.name,c.description,c.visibility,c.archived,c.created_at,c.updated_at
             FROM owner_agent_direct_channels d JOIN owner_channels c ON c.id=d.channel_id
             WHERE d.agent_id=?`,
            )
            .get(agentId),
        );
        if (existing) return toChannel(existing);

        const id = randomUUID(),
          at = this.now(),
          channel: OwnerChannel = {
            id,
            name: `${agent.name} 私信`,
            description: `与 ${agent.name} 的所有者私信。`,
            visibility: "private",
            archived: false,
            createdAt: at,
            updatedAt: at,
          };
        this.db
          .prepare(
            "INSERT INTO owner_channels(id,name,description,visibility,created_at,updated_at) VALUES(?,?,?,'private',?,?)",
          )
          .run(id, channel.name, channel.description, at, at);
        this.db
          .prepare(
            "INSERT INTO owner_agent_direct_channels(agent_id,channel_id,created_at) VALUES(?,?,?)",
          )
          .run(agentId, id, at);
        this.db
          .prepare(
            "INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at) VALUES(?,'human','owner',1,?),(?, 'agent', ?,1,?)",
          )
          .run(id, at, id, agentId, at);
        this.record("channel.created", id, channel);
        return channel;
      })
      .immediate();
  }

  /** Add a provisioned Agent to an active channel before its messages can be delivered. */
  inviteAgentToChannel(channelId: string, agentId: string): boolean {
    return this.db
      .transaction(() => {
        const session = z
          .looseObject({
            stage: z.string(),
            linux_username: z.string().nullable(),
            uid: z.number().nullable(),
            gid: z.number().nullable(),
            home: z.string().nullable(),
          })
          .optional()
          .parse(
            this.db
              .prepare(
                `SELECT a.stage,a.home,n.linux_username,n.uid,n.gid
             FROM owner_agent_sessions s JOIN owner_agents a ON a.id=s.agent_id
             JOIN nodes n ON n.id=a.node_id
             WHERE s.agent_id=?`,
              )
              .get(agentId),
          );
        if (!session || session.stage !== "complete" || !nodeAccountOf(session) || !session.home)
          return false;
        const channel = z
          .looseObject({ archived: z.number() })
          .optional()
          .parse(
            this.db
              .prepare(
                `SELECT c.archived FROM owner_channels c
             WHERE c.id=?
               AND NOT EXISTS (
                 SELECT 1 FROM owner_agent_direct_channels d WHERE d.channel_id=c.id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM owner_agent_peer_direct_channels p WHERE p.channel_id=c.id
               )`,
              )
              .get(channelId),
          );
        if (!channel || channel.archived) return false;
        this.db
          .prepare(
            "INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at) VALUES(?,'agent',?,1,?) ON CONFLICT(channel_id,principal_kind,principal_id) DO UPDATE SET active=1",
          )
          .run(channelId, agentId, this.now());
        return true;
      })
      .immediate();
  }

  /**
   * Let an Agent join a public channel it chose to take part in, under the same commit
   * that records the decision. Joining grants no read of the past: unread state is still
   * created only by the delivery snapshot of a later message, so old history is never
   * backfilled as unread, and an earlier re-join keeps the original joined_at.
   */
  joinAgentToPublicChannel(agentId: string, channelId: string): OwnerChannel | undefined {
    return this.db
      .transaction(() => {
        const channel = channelRowSchema.optional().parse(
          this.db
            .prepare(
              `SELECT c.id,c.name,c.description,c.visibility,c.archived,c.created_at,c.updated_at
             FROM owner_channels c
             WHERE c.id=? AND c.archived=0 AND c.visibility='public'
               AND NOT EXISTS (SELECT 1 FROM owner_agent_direct_channels d WHERE d.channel_id=c.id)
               AND NOT EXISTS (
                 SELECT 1 FROM owner_agent_peer_direct_channels p WHERE p.channel_id=c.id
               )`,
            )
            .get(channelId),
        );
        if (!channel) return undefined;
        this.db
          .prepare(
            "INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at) VALUES(?,'agent',?,1,?) ON CONFLICT(channel_id,principal_kind,principal_id) DO UPDATE SET active=1",
          )
          .run(channelId, agentId, this.now());
        return toChannel(channel);
      })
      .immediate();
  }

  snapshot(): OwnerChatSnapshot {
    return this.db
      .transaction(() => ({
        channels: this.listChannels(),
        cursor: this.eventCursor(),
      }))
      .deferred();
  }

  eventsAfter(cursor: number, limit = 100): { stale: boolean; events: OwnerChatEvent[] } {
    const first = z
      .looseObject({ first: z.number().nullable() })
      .parse(this.db.prepare("SELECT MIN(seq) AS first FROM owner_chat_events").get());
    if (first.first !== null && cursor < first.first - 1) return { stale: true, events: [] };
    const rows = eventRowSchema
      .array()
      .parse(
        this.db
          .prepare(
            "SELECT seq,kind,channel_id,payload,created_at FROM owner_chat_events WHERE seq>? ORDER BY seq LIMIT ?",
          )
          .all(cursor, limit),
      );
    return {
      stale: false,
      events: rows.map((row) => ({
        seq: row.seq,
        kind: row.kind,
        channelId: row.channel_id,
        payload: z.json().parse(JSON.parse(row.payload)),
        createdAt: row.created_at,
      })),
    };
  }

  private eventCursor(): number {
    const result = z
      .looseObject({ cursor: z.number() })
      .parse(this.db.prepare("SELECT COALESCE(MAX(seq),0) AS cursor FROM owner_chat_events").get());
    return result.cursor;
  }

  updateChannel(id: string, input: OwnerChannelUpdate): OwnerChannel | undefined {
    return this.db
      .transaction(() => {
        const current = this.db.prepare("SELECT id FROM owner_channels WHERE id=?").get(id);
        if (!current) return undefined;
        // A direct message is a private conversation between fixed participants, so it can
        // never be published: otherwise every Agent could read it through the public path.
        if (input.visibility === "public" && this.isDirectChannel(id))
          throw new Error("A direct message cannot be made public");

        this.db
          .prepare(
            "UPDATE owner_channels SET name=COALESCE(?,name),description=COALESCE(?,description),visibility=COALESCE(?,visibility),archived=COALESCE(?,archived),updated_at=? WHERE id=?",
          )
          .run(
            input.name ?? null,
            input.description ?? null,
            input.visibility ?? null,
            input.archived === undefined ? null : input.archived ? 1 : 0,
            this.now(),
            id,
          );
        const channel = this.readChannel(id);
        this.record("channel.updated", channel.id, channel);
        return channel;
      })
      .immediate();
  }

  createMessage(
    channelId: string,
    text: string,
    position: {
      rootId?: string | undefined;
      quoteId?: string | undefined;
      asTask?: boolean | undefined;
    } = {},
  ): OwnerMessage | undefined {
    const id = randomUUID(),
      at = this.now();
    return this.db
      .transaction(() => {
        const channel = z
          .looseObject({ archived: z.number() })
          .optional()
          .parse(this.db.prepare("SELECT archived FROM owner_channels WHERE id=?").get(channelId));
        if (!channel) return undefined;
        if (channel.archived) throw new ArchivedChannelError();

        if (position.rootId && position.quoteId)
          throw new Error("A message cannot be both a thread and quote reply");
        const targetId = position.rootId ?? position.quoteId;
        if (targetId) {
          const target = z
            .looseObject({ channel_id: z.string(), root_id: z.string().nullable() })
            .optional()
            .parse(
              this.db
                .prepare("SELECT channel_id,root_id FROM owner_messages WHERE id=?")
                .get(targetId),
            );
          if (!target || target.channel_id !== channelId || (position.rootId && target.root_id))
            throw new Error("Reply target is not a root message in this conversation");
        }
        const sequence = z
          .looseObject({ next: z.number() })
          .parse(
            this.db
              .prepare(
                "SELECT COALESCE(MAX(order_seq),0)+1 AS next FROM owner_messages WHERE channel_id=?",
              )
              .get(channelId),
          );
        this.db
          .prepare(
            "INSERT INTO owner_messages(id,channel_id,order_seq,text,root_id,quote_id,created_at) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            id,
            channelId,
            sequence.next,
            text,
            position.rootId ?? null,
            position.quoteId ?? null,
            at,
          );
        const message = toMessage({
          id,
          channel_id: channelId,
          order_seq: sequence.next,
          text,
          root_id: position.rootId ?? null,
          quote_id: position.quoteId ?? null,
          author_kind: "human",
          author_id: "owner",
          created_at: at,
        });
        this.queueDeliveries(message, at);
        this.record("message.created", channelId, message);
        if (position.asTask) this.createTaskForMessage(id, "human", "owner", text.slice(0, 200));
        return message;
      })
      .immediate();
  }

  /** Queue a private Mate fact so a corrected operation wakes its Agent once. */
  notifyAgentReceiptCorrection(
    agentId: string,
    operationId: string,
    state: "succeeded" | "failed",
  ): void {
    const channel = this.getOrCreateAgentDirectChannel(agentId);
    const at = this.now(),
      id = randomUUID();
    const processReceipt = z
      .looseObject({ receipt_json: z.string().nullable() })
      .optional()
      .parse(
        this.db
          .prepare(
            "SELECT receipt_json FROM owner_agent_process_operations WHERE operation_id=? AND agent_id=?",
          )
          .get(operationId, agentId),
      );
    const workspaceReceipt = z
      .looseObject({ result_json: z.string() })
      .optional()
      .parse(
        this.db
          .prepare(
            "SELECT result_json FROM owner_agent_tool_actions WHERE agent_id=? AND json_extract(CASE WHEN json_valid(result_json) THEN result_json ELSE '{}' END,'$.operationId')=?",
          )
          .get(agentId, operationId),
      );
    const queued = new AgentSession(this.db).queueCorrection(
      agentId,
      {
        operationId,
        state,
        receipt: processReceipt?.receipt_json
          ? JSON.parse(processReceipt.receipt_json)
          : workspaceReceipt?.result_json
            ? JSON.parse(workspaceReceipt.result_json)
            : null,
      },
      at,
    );
    if (!queued || !channel || channel.archived) return;
    const text = `Mate 已核对操作 ${operationId} 的收据：${state === "succeeded" ? "成功" : "失败"}。完整更正将在后续模型上下文中呈现。`;
    this.db
      .transaction(() => {
        const sequence = z
          .looseObject({ next: z.number() })
          .parse(
            this.db
              .prepare(
                "SELECT COALESCE(MAX(order_seq),0)+1 AS next FROM owner_messages WHERE channel_id=?",
              )
              .get(channel.id),
          );
        this.db
          .prepare(
            `INSERT INTO owner_messages(id,channel_id,order_seq,text,author_kind,author_id,created_at)
         VALUES(?,?,?,?,'agent','mate-system',?)`,
          )
          .run(id, channel.id, sequence.next, text, at);
        const message = toMessage({
          id,
          channel_id: channel.id,
          order_seq: sequence.next,
          text,
          author_kind: "agent",
          author_id: "mate-system",
          created_at: at,
        });
        this.queueDeliveries(message, at);
        this.record("message.created", channel.id, message);
      })
      .immediate();
  }

  createTaskForMessage(
    messageId: string,
    actorKind: OwnerPrincipalKind,
    actorId: string,
    title: string,
  ): OwnerTask {
    return this.tasks.createTaskForMessage(messageId, actorKind, actorId, title);
  }

  readTask(id: string): OwnerTask | undefined {
    return this.tasks.readTask(id);
  }
  tasksForMessage(messageId: string): OwnerTask[] {
    return this.tasks.tasksForMessage(messageId);
  }
  listTasks(): OwnerTask[] {
    return this.tasks.listTasks();
  }
  taskActivity(taskId: string): unknown[] {
    return this.tasks.taskActivity(taskId);
  }
  listAgentReminders(agentId: string) {
    return this.tasks.listAgentReminders(agentId);
  }
  fireDueReminders(): number {
    return this.tasks.fireDueReminders();
  }
  syncHandledReminders(): void {
    this.tasks.syncHandledReminders();
  }

  /** True for the one-to-one conversations that must never follow channel visibility. */
  private isDirectChannel(channelId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 WHERE EXISTS (
           SELECT 1 FROM owner_agent_direct_channels d WHERE d.channel_id=?
         ) OR EXISTS (
           SELECT 1 FROM owner_agent_peer_direct_channels p WHERE p.channel_id=?
         )`,
      )
      .get(channelId, channelId);
    return row !== undefined;
  }

  /** True only while this Agent holds an active membership in a live channel. */
  private isAgentChannelMember(agentId: string, channelId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1
         FROM owner_channels c
         JOIN owner_channel_memberships m
           ON m.channel_id=c.id AND m.principal_kind='agent' AND m.principal_id=? AND m.active=1
         WHERE c.id=? AND c.archived=0`,
      )
      .get(agentId, channelId);
    return row !== undefined;
  }

  listPendingDeliveries(
    recipientKind: OwnerPrincipalKind,
    recipientId: string,
    after = 0,
    limit = 100,
  ): OwnerMessageDeliveryPage {
    if (!Number.isSafeInteger(after) || after < 0)
      throw new Error("Delivery cursor must be a non-negative safe integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
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
    const hasMore = rows.length > limit,
      deliveries = rows.slice(0, limit).map((row) => ({
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

  listMessages(
    channelId: string,
    before: number | undefined,
    limit: number,
  ): OwnerMessagePage | undefined {
    if (!this.db.prepare("SELECT 1 FROM owner_channels WHERE id=?").get(channelId))
      return undefined;
    const rows = messageRowSchema
      .array()
      .parse(
        this.db
          .prepare(
            "SELECT id,channel_id,order_seq,text,root_id,quote_id,author_kind,author_id,created_at FROM owner_messages WHERE channel_id=? AND root_id IS NULL AND internal_kind IS NULL AND (? IS NULL OR order_seq < ?) ORDER BY order_seq DESC LIMIT ?",
          )
          .all(channelId, before ?? null, before ?? null, limit + 1),
      );
    const hasMore = rows.length > limit,
      messages = rows
        .slice(0, limit)
        .reverse()
        .map((row) => this.withReplyPreview(toMessage(row)));
    return { messages, nextBefore: hasMore ? (messages[0]?.order ?? null) : null };
  }

  messageContext(channelId: string, messageId: string) {
    const row = messageRowSchema
      .optional()
      .parse(
        this.db
          .prepare(
            "SELECT id,channel_id,order_seq,text,root_id,quote_id,author_kind,author_id,created_at FROM owner_messages WHERE id=? AND channel_id=? AND internal_kind IS NULL",
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
    const root = messageRowSchema
      .optional()
      .parse(
        this.db
          .prepare(
            "SELECT id,channel_id,order_seq,text,root_id,quote_id,author_kind,author_id,created_at FROM owner_messages WHERE id=? AND channel_id=? AND root_id IS NULL AND internal_kind IS NULL",
          )
          .get(rootId, channelId),
      );
    if (!root) return undefined;
    const replies = messageRowSchema
      .array()
      .parse(
        this.db
          .prepare(
            "SELECT id,channel_id,order_seq,text,root_id,quote_id,author_kind,author_id,created_at FROM owner_messages WHERE channel_id=? AND root_id=? ORDER BY order_seq",
          )
          .all(channelId, rootId),
      );
    return { root: this.withReplyPreview(toMessage(root)), replies: replies.map(toMessage) };
  }

  private withReplyPreview(message: OwnerMessage): OwnerMessage {
    const rows = messageRowSchema
      .array()
      .parse(
        this.db
          .prepare(
            "SELECT id,channel_id,order_seq,text,root_id,quote_id,author_kind,author_id,created_at FROM owner_messages WHERE channel_id=? AND root_id=? ORDER BY order_seq DESC LIMIT 3",
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

  private readChannel(id: string): OwnerChannel {
    const row = channelRowSchema
      .optional()
      .parse(
        this.db
          .prepare(
            "SELECT id,name,description,visibility,archived,created_at,updated_at FROM owner_channels WHERE id=?",
          )
          .get(id),
      );
    if (!row) throw new Error("Created channel was not persisted");
    return toChannel(row);
  }

  agentTools() {
    return {
      "agents.list": defineConversationTool(
        conversationToolDefinitions["agents.list"],
        (run, toolCallId, args) => {
          return { agents: this.listContactableAgents(run.agent_id) };
        },
      ),
      "conversations.list": defineConversationTool(
        conversationToolDefinitions["conversations.list"],
        (run, toolCallId, args) => {
          return { conversations: this.listAgentConversations(run.agent_id) };
        },
      ),
      "conversations.read": defineConversationTool(
        conversationToolDefinitions["conversations.read"],
        (run, toolCallId, args) => {
          const conversation = this.requireReadableConversation(run.agent_id, args.conversationId),
            before = args.before === undefined ? undefined : Number(args.before);
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
          this.requireReadableConversation(run.agent_id, args.conversationId);
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
      "conversations.open_dm": defineConversationTool(
        conversationToolDefinitions["conversations.open_dm"],
        (run, toolCallId, args) => {
          if (args.targetAgentId === run.agent_id)
            throw new AgentToolRefusal("An Agent cannot open a direct message with itself");
          if (!this.isInviteableAgent(args.targetAgentId))
            throw new AgentToolRefusal("Direct-message target is not available");
          return this.toolActions.record(run, toolCallId, "conversations.open_dm", args, () =>
            this.getOrCreateAgentPeerDirectChannel(run.agent_id, args.targetAgentId),
          );
        },
      ),
      "attention.list": defineConversationTool(
        conversationToolDefinitions["attention.list"],
        (run, toolCallId, args) => {
          this.requireAgentConversation(run.agent_id, args.conversationId);
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
          this.requireAgentConversation(run.agent_id, args.conversationId);
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
          this.requireAgentConversation(run.agent_id, args.conversationId);
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
          this.requireAgentConversation(run.agent_id, draft.channel_id);
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
          this.requireAgentConversation(run.agent_id, args.conversationId);
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
            return this.createAgentToolMessage(
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
      ...this.tasks.agentTools(),
      "conversations.join": defineConversationTool(
        conversationToolDefinitions["conversations.join"],
        (run, toolCallId, args) => {
          const alreadyMember = this.isAgentChannelMember(run.agent_id, args.conversationId);
          if (alreadyMember) {
            const conversation = this.requireAgentConversation(run.agent_id, args.conversationId);
            if (conversation.kind !== "channel")
              throw new AgentToolRefusal("Only a public channel can be joined");
            return this.toolActions.record(run, toolCallId, "conversations.join", args, () => ({
              conversationId: conversation.id,
              name: conversation.name,
              visibility: conversation.visibility,
              member: true,
              alreadyMember: true,
            }));
          }
          const conversation = this.requireReadableConversation(run.agent_id, args.conversationId);
          if (conversation.kind !== "channel" || conversation.visibility !== "public")
            throw new AgentToolRefusal("Only a public channel can be joined");
          return this.toolActions.record(run, toolCallId, "conversations.join", args, () => {
            const channel = this.joinAgentToPublicChannel(run.agent_id, args.conversationId);
            if (!channel) throw new AgentToolRefusal("Only a public channel can be joined");
            return {
              conversationId: channel.id,
              name: channel.name,
              visibility: channel.visibility,
              member: true,
              alreadyMember: false,
            };
          });
        },
      ),
      "conversations.invite": defineConversationTool(
        conversationToolDefinitions["conversations.invite"],
        (run, toolCallId, args) => {
          const conversation = this.requireAgentConversation(run.agent_id, args.conversationId);
          if (conversation.kind !== "channel")
            throw new AgentToolRefusal("Only a channel can receive an invitation");
          if (args.agentId === run.agent_id)
            throw new AgentToolRefusal("An Agent cannot invite itself");
          const currentMember = z
            .looseObject({ active: z.number() })
            .optional()
            .parse(
              this.db
                .prepare(
                  "SELECT active FROM owner_channel_memberships WHERE channel_id=? AND principal_kind='agent' AND principal_id=?",
                )
                .get(args.conversationId, args.agentId),
            );
          // A valid Agent invitation is effective at this same control-plane commit.
          if (!this.isInviteableAgent(args.agentId))
            throw new AgentToolRefusal("Invitation target is not available");
          return this.toolActions.record(run, toolCallId, "conversations.invite", args, () => {
            if (!this.inviteAgentToChannel(args.conversationId, args.agentId))
              throw new AgentToolRefusal("Invitation target is not available");
            return {
              conversationId: args.conversationId,
              agentId: args.agentId,
              status: "succeeded",
              alreadyMember: currentMember?.active === 1,
            };
          });
        },
      ),
    };
  }

  listAgentAttention(
    agentId: string,
    channelId: string,
  ): Array<{
    messageId: string;
    unread: number;
    seen: number;
    deferred: number;
    muted: number;
    presented: number;
  }> {
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

  readPersistedAgentDraft(
    agentId: string,
    id: string,
  ): { state: string; text: string; channelId: string } | undefined {
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

  private listAgentConversations(agentId: string): Array<{
    id: string;
    name: string;
    description: string;
    visibility: ChannelVisibility;
    kind: "channel" | "dm";
    member: boolean;
  }> {
    const rows = z
      .looseObject({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        visibility: channelVisibilitySchema,
        direct_agent_id: z.string().nullable(),
        conversation_kind: z.union([z.literal("channel"), z.literal("dm")]),
        member: z.number(),
      })
      .array()
      .parse(
        this.db
          .prepare(
            `SELECT c.id,c.name,c.description,c.visibility,d.agent_id AS direct_agent_id,
                CASE WHEN d.agent_id IS NOT NULL OR p.channel_id IS NOT NULL
                     THEN 'dm' ELSE 'channel' END AS conversation_kind,
                COALESCE(m.active,0) AS member
         FROM owner_channels c
         LEFT JOIN owner_channel_memberships m
           ON m.channel_id=c.id AND m.principal_kind='agent' AND m.principal_id=?
         LEFT JOIN owner_agent_direct_channels d ON d.channel_id=c.id
         LEFT JOIN owner_agent_peer_direct_channels p ON p.channel_id=c.id
         WHERE c.archived=0 AND (m.active=1 OR (
           c.visibility='public' AND d.agent_id IS NULL AND p.channel_id IS NULL
         ))
         ORDER BY c.created_at,c.id`,
          )
          .all(agentId),
      );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      kind: row.conversation_kind,
      member: row.member === 1,
    }));
  }

  private listContactableAgents(agentId: string): Array<{
    id: string;
    name: string;
    role: string;
    description: string;
  }> {
    return z
      .looseObject({ id: z.string(), name: z.string(), role: z.string(), description: z.string() })
      .array()
      .parse(
        this.db
          .prepare(
            `SELECT a.id,a.name,a.role,a.description
         FROM owner_agents a JOIN nodes n ON n.id=a.node_id
         WHERE a.id<>? AND a.stage='complete'
           AND n.linux_username IS NOT NULL AND n.uid IS NOT NULL AND n.gid IS NOT NULL
           AND a.home IS NOT NULL
         ORDER BY a.created_at,a.id`,
          )
          .all(agentId),
      );
  }

  private getOrCreateAgentPeerDirectChannel(
    firstAgentId: string,
    secondAgentId: string,
  ): OwnerChannel {
    const ordered = [firstAgentId, secondAgentId].sort(),
      first = ordered[0],
      second = ordered[1];
    if (first === undefined || second === undefined)
      throw new AgentToolRefusal("Direct-message target is not available");
    const existing = z
      .looseObject({ channel_id: z.string() })
      .optional()
      .parse(
        this.db
          .prepare(
            `SELECT channel_id FROM owner_agent_peer_direct_channels
           WHERE first_agent_id=? AND second_agent_id=?`,
          )
          .get(first, second),
      );
    if (existing) {
      const channel = this.readChannel(existing.channel_id);
      if (channel.archived) throw new AgentToolRefusal("Direct message is archived");
      return channel;
    }
    const participants = z
      .looseObject({ id: z.string(), name: z.string() })
      .array()
      .parse(
        this.db
          .prepare("SELECT id,name FROM owner_agents WHERE id IN (?,?) ORDER BY id")
          .all(first, second),
      );
    if (participants.length !== 2)
      throw new AgentToolRefusal("Direct-message target is not available");
    const id = randomUUID(),
      at = this.now(),
      names = new Map<string, string>(participants.map((agent) => [agent.id, agent.name])),
      firstName = names.get(first),
      secondName = names.get(second);
    if (firstName === undefined || secondName === undefined)
      throw new AgentToolRefusal("Direct-message target is not available");
    this.db
      .prepare(
        `INSERT INTO owner_channels(id,name,description,visibility,created_at,updated_at)
         VALUES(?,?,?,'private',?,?)`,
      )
      .run(
        id,
        `${firstName} ↔ ${secondName} 私信`,
        `${firstName} 与 ${secondName} 的私信。`,
        at,
        at,
      );
    this.db
      .prepare(
        `INSERT INTO owner_agent_peer_direct_channels(
           channel_id,first_agent_id,second_agent_id,created_at
         ) VALUES(?,?,?,?)`,
      )
      .run(id, first, second, at);
    this.db
      .prepare(
        `INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at)
         VALUES(?,'human','owner',1,?),(?, 'agent', ?,1,?),(?, 'agent', ?,1,?)`,
      )
      .run(id, at, id, first, at, id, second, at);
    const channel = this.readChannel(id);
    this.record("channel.created", id, channel);
    return channel;
  }

  /**
   * The one conversation-metadata SELECT. Membership is always probed, so a reader can get
   * the active-member flag without a second round trip.
   */
  private readConversationRow(agentId: string, conversationId: string) {
    return conversationRowSchema.optional().parse(
      this.db
        .prepare(
          `SELECT c.id,c.name,c.description,c.visibility,
                CASE WHEN d.agent_id IS NOT NULL OR p.channel_id IS NOT NULL
                     THEN 'dm' ELSE 'channel' END AS conversation_kind,
                m.active AS active_member
         FROM owner_channels c
         LEFT JOIN owner_channel_memberships m
           ON m.channel_id=c.id AND m.principal_kind='agent' AND m.principal_id=? AND m.active=1
         LEFT JOIN owner_agent_direct_channels d ON d.channel_id=c.id
         LEFT JOIN owner_agent_peer_direct_channels p ON p.channel_id=c.id
         WHERE c.id=? AND c.archived=0`,
        )
        .get(agentId, conversationId),
    );
  }

  private toConversationFacts(row: ConversationRow): AgentConversationFacts {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      kind: row.conversation_kind,
    };
  }

  /**
   * Conversation metadata for a read. A public channel stays readable without membership;
   * a private conversation, or any direct message, is readable only to an active member.
   */
  private readAgentConversation(
    agentId: string,
    conversationId: string,
  ): AgentConversationFacts | undefined {
    const row = this.readConversationRow(agentId, conversationId);
    if (!row) return undefined;
    const readable =
      row.active_member === 1 ||
      (row.conversation_kind === "channel" &&
        row.visibility === "public" &&
        !this.isDirectChannel(conversationId));
    return readable ? this.toConversationFacts(row) : undefined;
  }

  /** Readable conversation metadata, or a refusal when this Agent may not read it. */
  private requireReadableConversation(
    agentId: string,
    conversationId: string,
  ): AgentConversationFacts {
    const conversation = this.readAgentConversation(agentId, conversationId);
    if (!conversation) throw new AgentToolRefusal("Conversation is not available");
    return conversation;
  }

  /** Member-only conversation metadata; every write and every membership change uses this gate. */
  private requireAgentConversation(
    agentId: string,
    conversationId: string,
  ): AgentConversationFacts {
    const row = this.readConversationRow(agentId, conversationId);
    if (!row || row.active_member !== 1)
      throw new AgentToolRefusal("Conversation is not available");
    return this.toConversationFacts(row);
  }

  private isInviteableAgent(agentId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM owner_agents a JOIN nodes n ON n.id=a.node_id
         WHERE a.id=? AND a.stage='complete'
           AND n.linux_username IS NOT NULL AND n.uid IS NOT NULL AND n.gid IS NOT NULL
           AND a.home IS NOT NULL`,
      )
      .get(agentId);
    return !!row;
  }

  private createAgentToolMessage(
    run: CurrentAgentToolRun,
    toolActionId: string,
    channelId: string,
    text: string,
    rootId?: string,
    quoteId?: string,
    asTask?: boolean,
  ): OwnerMessage {
    if (!this.db.inTransaction)
      throw new Error("Agent tool message requires its action transaction");
    const id = randomUUID(),
      at = this.now(),
      sequence = z
        .looseObject({ next: z.number() })
        .parse(
          this.db
            .prepare(
              "SELECT COALESCE(MAX(order_seq),0)+1 AS next FROM owner_messages WHERE channel_id=?",
            )
            .get(channelId),
        );
    this.db
      .prepare(
        "INSERT INTO owner_messages(id,channel_id,order_seq,text,root_id,quote_id,author_kind,author_id,created_at) VALUES(?,?,?,?,?,?, 'agent', ?,?)",
      )
      .run(id, channelId, sequence.next, text, rootId ?? null, quoteId ?? null, run.agent_id, at);
    const message = toMessage({
      id,
      channel_id: channelId,
      order_seq: sequence.next,
      text,
      root_id: rootId ?? null,
      quote_id: quoteId ?? null,
      author_kind: "agent",
      author_id: run.agent_id,
      created_at: at,
    });
    this.queueDeliveries(message, at);
    this.record("message.created", channelId, message);
    if (asTask) this.createTaskForMessage(id, "agent", run.agent_id, text.slice(0, 200));
    return message;
  }

  private queueDeliveries(message: OwnerMessage, at: number): void {
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

  private record(
    kind: string,
    channelId: string,
    payload: OwnerChannel | OwnerMessage | OwnerTask,
  ): void {
    if (!this.db.inTransaction)
      throw new Error("Conversation event requires the owning transaction");
    this.db
      .prepare("INSERT INTO owner_chat_events(kind,channel_id,payload,created_at) VALUES(?,?,?,?)")
      .run(kind, channelId, JSON.stringify(payload), this.now());
    if (
      kind === "message.created" &&
      "author" in payload &&
      payload.author.kind === "agent" &&
      payload.author.id !== "mate-system"
    ) {
      const ownerCanRead = !!this.db
        .prepare(
          "SELECT 1 FROM owner_channel_memberships WHERE channel_id=? AND principal_kind='human' AND principal_id='owner' AND active=1",
        )
        .get(channelId);
      if (ownerCanRead) {
        const directToOwner = !!this.db
          .prepare("SELECT 1 FROM owner_agent_direct_channels WHERE channel_id=?")
          .get(channelId);
        try {
          this.pushMessage?.(payload, directToOwner);
        } catch {
          /* Notifications cannot undo chat. */
        }
      }
    }
    this.db
      .prepare(
        "DELETE FROM owner_chat_events WHERE seq <= (SELECT COALESCE(MAX(seq)-?,0) FROM owner_chat_events)",
      )
      .run(eventRetention);
  }
}
