import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  agentConversationOperations,
  agentToolSchemas,
  type AgentConversationOperation,
} from "./agent-tools.js";

export type ChannelVisibility = "public" | "private";
export type OwnerPrincipalKind = "human" | "agent";

export interface OwnerChannel {
  id: string;
  name: string;
  description: string;
  visibility: ChannelVisibility;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface OwnerMessage {
  id: string;
  channelId: string;
  rootId: null;
  author: { kind: "human"; id: "owner" } | { kind: "agent"; id: string };
  text: string;
  order: string;
  revision: string;
  createdAt: number;
}

export interface OwnerMessagePage {
  messages: OwnerMessage[];
  nextBefore: string | null;
}

export interface OwnerMessageDelivery {
  sequence: number;
  id: string;
  messageId: string;
  channelId: string;
  recipient: { kind: OwnerPrincipalKind; id: string };
  state: "pending";
  createdAt: number;
  message: OwnerMessage;
}

export interface OwnerMessageDeliveryPage {
  deliveries: OwnerMessageDelivery[];
  nextAfter: number | null;
}

export interface AgentSessionJournalEntry {
  sequence: number;
  role: "user" | "assistant";
  text: string;
  sourceChannelId: string;
  sourceVisibility: ChannelVisibility;
  currentRunInput: boolean;
}

export interface AgentSessionJournalPage {
  messages: AgentSessionJournalEntry[];
  nextAfter: number | null;
}

export interface AgentRunContextPage {
  messages: AgentSessionJournalEntry[];
  /** Projection-order cursor; each message sequence remains its original journal value. */
  nextCursor: number | null;
}

export interface OwnerChatSnapshot {
  channels: OwnerChannel[];
  cursor: number;
}

export interface OwnerChatEvent {
  seq: number;
  kind: string;
  channelId: string;
  payload: unknown;
  createdAt: number;
}

export interface NewOwnerChannel {
  name: string;
  description: string;
  visibility: ChannelVisibility;
}

export interface OwnerChannelUpdate {
  name?: string | undefined;
  description?: string | undefined;
  visibility?: ChannelVisibility | undefined;
  archived?: boolean | undefined;
}

export type AgentToolCallResult = { ok: true; result: unknown } | { ok: false; error: string };

interface ActiveAgentToolRun {
  agent_id: string;
  node_id: string;
  session_id: string;
  state: string;
  independent_review: number;
}

class AgentToolRefusal extends Error {}

export class ArchivedChannelError extends Error {
  constructor() {
    super("Archived channels are read-only");
    this.name = "ArchivedChannelError";
  }
}

interface ChannelRow {
  id: string;
  name: string;
  description: string;
  visibility: ChannelVisibility;
  archived: number;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  channel_id: string;
  order_seq: number;
  revision: number;
  text: string;
  author_kind: OwnerPrincipalKind;
  author_id: string;
  created_at: number;
}

interface EventRow {
  seq: number;
  kind: string;
  channel_id: string;
  payload: string;
  created_at: number;
}

interface PendingDeliveryRow {
  delivery_sequence: number;
  delivery_id: string;
  message_id: string;
  channel_id: string;
  recipient_kind: OwnerPrincipalKind;
  recipient_id: string;
  state: "pending";
  delivery_created_at: number;
  order_seq: number;
  revision: number;
  text: string;
  author_kind: OwnerPrincipalKind;
  author_id: string;
  created_at: number;
}

const eventRetention = 1000;

/** Owner-facing channel facts committed in the control-plane database. */
export class OwnerChat {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

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
    const rows = this.db
      .prepare(
        "SELECT id,name,description,visibility,archived,created_at,updated_at FROM owner_channels ORDER BY created_at,id",
      )
      .all() as ChannelRow[];
    return rows.map(toChannel);
  }

  /** The only entry point through which a running Agent may call shared conversation tools. */
  executeAgentTool(
    runId: string,
    nodeId: string,
    agentId: string,
    toolCallId: string,
    operation: string,
    input: Record<string, unknown>,
  ): AgentToolCallResult {
    try {
      const result = this.db
        .transaction(() => {
          const run = this.activeAgentToolRun(runId, nodeId, agentId),
            reviewSeat = run.independent_review === 1;
          if (operation === "tools.list") {
            agentToolSchemas["tools.list"].parse(input);
            return {
              tools: Object.entries(agentConversationOperations)
                .filter(([, entry]) => !reviewSeat || entry.seatPolicy !== "deny")
                .map(([name, entry]) => ({ name, description: entry.description })),
            };
          }
          if (operation === "tools.describe") {
            const request = agentToolSchemas["tools.describe"].parse(input),
              entry = agentConversationOperations[request.name as AgentConversationOperation];
            if (!entry || (reviewSeat && entry.seatPolicy === "deny"))
              throw new AgentToolRefusal("Unknown operation");
            return {
              name: request.name,
              description: entry.description,
              inputSchema: z.toJSONSchema(entry.schema),
            };
          }
          if (operation !== "tools.call") throw new AgentToolRefusal("Unknown operation");
          const request = agentToolSchemas["tools.call"].parse(input);
          return this.executeConversationOperation(
            run,
            reviewSeat,
            toolCallId,
            request.name,
            request.input,
          );
        })
        .immediate();
      return { ok: true, result };
    } catch (error) {
      if (error instanceof AgentToolRefusal) return { ok: false, error: error.message };
      if (error instanceof z.ZodError) return { ok: false, error: "Invalid tool input" };
      return { ok: false, error: "Agent tool request was refused" };
    }
  }

  /** Create or return the one private owner conversation bound to this verified Agent. */
  getOrCreateAgentDirectChannel(agentId: string): OwnerChannel | undefined {
    return this.db
      .transaction(() => {
        const agent = this.db
          .prepare(
            `SELECT a.id,a.name,s.verified_at FROM owner_agents a
             JOIN owner_agent_sessions s ON s.agent_id=a.id WHERE a.id=?`,
          )
          .get(agentId) as { id: string; name: string; verified_at: number | null } | undefined;
        if (!agent || agent.verified_at === null) return undefined;
        const existing = this.db
          .prepare(
            `SELECT c.id,c.name,c.description,c.visibility,c.archived,c.created_at,c.updated_at
             FROM owner_agent_direct_channels d JOIN owner_channels c ON c.id=d.channel_id
             WHERE d.agent_id=?`,
          )
          .get(agentId) as ChannelRow | undefined;
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
        const session = this.db
          .prepare(
            `SELECT s.verified_at,a.status,a.linux_username,a.uid,a.gid,a.home
             FROM owner_agent_sessions s JOIN owner_agents a ON a.id=s.agent_id
             WHERE s.agent_id=?`,
          )
          .get(agentId) as
          | {
              verified_at: number | null;
              status: string;
              linux_username: string | null;
              uid: number | null;
              gid: number | null;
              home: string | null;
            }
          | undefined;
        if (
          !session ||
          session.verified_at === null ||
          session.status !== "waiting_credentials" ||
          !session.linux_username ||
          session.uid === null ||
          session.gid === null ||
          !session.home
        )
          return false;
        const channel = this.db
          .prepare("SELECT archived FROM owner_channels WHERE id=?")
          .get(channelId) as { archived: number } | undefined;
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

  snapshot(): OwnerChatSnapshot {
    return this.db
      .transaction(() => ({
        channels: this.listChannels(),
        cursor: this.eventCursor(),
      }))
      .deferred();
  }

  eventsAfter(cursor: number, limit = 100): { stale: boolean; events: OwnerChatEvent[] } {
    const first = this.db.prepare("SELECT MIN(seq) AS first FROM owner_chat_events").get() as {
      first: number | null;
    };
    if (first.first !== null && cursor < first.first - 1) return { stale: true, events: [] };
    const rows = this.db
      .prepare(
        "SELECT seq,kind,channel_id,payload,created_at FROM owner_chat_events WHERE seq>? ORDER BY seq LIMIT ?",
      )
      .all(cursor, limit) as EventRow[];
    return {
      stale: false,
      events: rows.map((row) => ({
        seq: row.seq,
        kind: row.kind,
        channelId: row.channel_id,
        payload: JSON.parse(row.payload) as unknown,
        createdAt: row.created_at,
      })),
    };
  }

  private eventCursor(): number {
    const result = this.db
      .prepare("SELECT COALESCE(MAX(seq),0) AS cursor FROM owner_chat_events")
      .get() as { cursor: number };
    return result.cursor;
  }

  updateChannel(id: string, input: OwnerChannelUpdate): OwnerChannel | undefined {
    return this.db
      .transaction(() => {
        const current = this.db.prepare("SELECT id FROM owner_channels WHERE id=?").get(id);
        if (!current) return undefined;

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

  createMessage(channelId: string, text: string): OwnerMessage | undefined {
    const id = randomUUID(),
      at = this.now();
    return this.db
      .transaction(() => {
        const channel = this.db
          .prepare("SELECT archived FROM owner_channels WHERE id=?")
          .get(channelId) as { archived: number } | undefined;
        if (!channel) return undefined;
        if (channel.archived) throw new ArchivedChannelError();

        const sequence = this.db
          .prepare(
            "SELECT COALESCE(MAX(order_seq),0)+1 AS next FROM owner_messages WHERE channel_id=?",
          )
          .get(channelId) as { next: number };
        this.db
          .prepare(
            "INSERT INTO owner_messages(id,channel_id,order_seq,text,created_at) VALUES(?,?,?,?,?)",
          )
          .run(id, channelId, sequence.next, text, at);
        const message = toMessage({
          id,
          channel_id: channelId,
          order_seq: sequence.next,
          revision: 1,
          text,
          author_kind: "human",
          author_id: "owner",
          created_at: at,
        });
        this.queueDeliveries(message, at);
        const agentRecipients = this.db
          .prepare(
            `SELECT d.recipient_id AS agent_id,s.id AS session_id
             FROM owner_message_deliveries d
             JOIN owner_agent_sessions s ON s.agent_id=d.recipient_id
             WHERE d.message_id=? AND d.recipient_kind='agent' ORDER BY d.seq`,
          )
          .all(id) as Array<{ agent_id: string; session_id: string }>;
        for (const recipient of agentRecipients) {
          this.db
            .prepare(
              "INSERT INTO owner_agent_session_journal(session_id,agent_id,channel_id,message_id,role,text,created_at) VALUES(?,?,?,?,'user',?,?)",
            )
            .run(recipient.session_id, recipient.agent_id, channelId, id, text, at);
        }
        this.record("message.created", channelId, message);
        return message;
      })
      .immediate();
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
    const rows = this.db
      .prepare(
        `SELECT d.seq AS delivery_sequence,d.id AS delivery_id,d.message_id,d.channel_id,
                d.recipient_kind,d.recipient_id,d.state,d.created_at AS delivery_created_at,
                m.order_seq,m.revision,m.text,m.author_kind,m.author_id,m.created_at
         FROM owner_message_deliveries d JOIN owner_messages m ON m.id=d.message_id
         WHERE d.recipient_kind=? AND d.recipient_id=? AND d.state='pending' AND d.seq>?
         ORDER BY d.seq LIMIT ?`,
      )
      .all(recipientKind, recipientId, after, limit + 1) as PendingDeliveryRow[];
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
          revision: row.revision,
          text: row.text,
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
    return (
      this.db
        .prepare(
          "UPDATE owner_message_deliveries SET state='handled',handled_at=? WHERE id=? AND recipient_kind=? AND recipient_id=? AND state='pending'",
        )
        .run(this.now(), deliveryId, recipientKind, recipientId).changes === 1
    );
  }

  listAgentSessionJournal(
    agentId: string,
    after: number,
    limit: number,
    throughSequence?: number,
    currentInputFromSequence?: number,
  ): AgentSessionJournalPage {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (throughSequence !== undefined &&
        (!Number.isSafeInteger(throughSequence) || throughSequence < 0)) ||
      (currentInputFromSequence !== undefined &&
        (!Number.isSafeInteger(currentInputFromSequence) ||
          currentInputFromSequence < 1 ||
          throughSequence === undefined ||
          currentInputFromSequence > throughSequence))
    )
      throw new Error("Agent session journal cursor is invalid");
    const rows = this.db
      .prepare(
        `SELECT j.seq,j.role,j.text,j.channel_id,c.visibility
         FROM owner_agent_session_journal j
         JOIN owner_agent_sessions s ON s.id=j.session_id
         JOIN owner_channels c ON c.id=j.channel_id
         WHERE s.agent_id=? AND j.seq>? AND (? IS NULL OR j.seq<=?)
         ORDER BY j.seq LIMIT ?`,
      )
      .all(agentId, after, throughSequence ?? null, throughSequence ?? null, limit + 1) as Array<{
      seq: number;
      role: "user" | "assistant";
      text: string;
      channel_id: string;
      visibility: ChannelVisibility;
    }>;
    const hasMore = rows.length > limit,
      messages = rows.slice(0, limit).map((row) => ({
        sequence: row.seq,
        role: row.role,
        text: row.text,
        sourceChannelId: row.channel_id,
        sourceVisibility: row.visibility,
        currentRunInput:
          row.role === "user" &&
          currentInputFromSequence !== undefined &&
          row.seq >= currentInputFromSequence,
      }));
    return {
      messages,
      nextAfter: hasMore ? (messages.at(-1)?.sequence ?? after) : null,
    };
  }

  listAgentRunContext(
    agentId: string,
    cursor: number,
    limit: number,
    historyThroughSequence: number,
    channelId: string,
    inputFromSequence: number,
    inputThroughSequence: number,
  ): AgentRunContextPage {
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(historyThroughSequence) ||
      historyThroughSequence < 0 ||
      !Number.isSafeInteger(inputFromSequence) ||
      inputFromSequence < 1 ||
      !Number.isSafeInteger(inputThroughSequence) ||
      inputThroughSequence < inputFromSequence
    )
      throw new Error("Agent run context cursor is invalid");
    const rows = this.db
      .prepare(
        `WITH run_context AS (
           SELECT j.seq AS journal_sequence,j.role,j.text,j.channel_id,c.visibility,
                  0 AS entry_group,0 AS current_run_input
           FROM owner_agent_session_journal j
           JOIN owner_agent_sessions s ON s.id=j.session_id AND s.agent_id=@agent_id
           JOIN owner_channels c ON c.id=j.channel_id
           WHERE j.agent_id=@agent_id AND j.seq<=@history_end_seq
             AND (
               (j.role='user' AND EXISTS (
                 SELECT 1 FROM owner_message_deliveries d
                 WHERE d.recipient_kind='agent' AND d.recipient_id=@agent_id
                   AND d.message_id=j.message_id AND d.state='handled'
               ))
               OR (j.role='assistant' AND EXISTS (
                 SELECT 1 FROM owner_agent_runs r
                 WHERE r.id=j.run_id AND r.agent_id=@agent_id AND r.state='completed'
               ))
             )
           UNION ALL
           SELECT j.seq AS journal_sequence,j.role,j.text,j.channel_id,c.visibility,
                  1 AS entry_group,1 AS current_run_input
           FROM owner_agent_session_journal j
           JOIN owner_agent_sessions s ON s.id=j.session_id AND s.agent_id=@agent_id
           JOIN owner_channels c ON c.id=j.channel_id
           JOIN owner_message_deliveries d
             ON d.message_id=j.message_id AND d.channel_id=j.channel_id
                AND d.recipient_kind='agent' AND d.recipient_id=@agent_id
           WHERE j.agent_id=@agent_id AND j.role='user' AND d.state='pending'
             AND j.channel_id=@channel_id
             AND j.seq>=@input_start_seq AND j.seq<=@input_end_seq
         ), ordered_context AS (
           SELECT ROW_NUMBER() OVER (ORDER BY entry_group,journal_sequence) AS context_position,
                  journal_sequence,role,text,channel_id,visibility,current_run_input
           FROM run_context
         )
         SELECT context_position,journal_sequence,role,text,channel_id,visibility,current_run_input
         FROM ordered_context
         WHERE context_position>@cursor
         ORDER BY context_position LIMIT @limit`,
      )
      .all({
        agent_id: agentId,
        history_end_seq: historyThroughSequence,
        channel_id: channelId,
        input_start_seq: inputFromSequence,
        input_end_seq: inputThroughSequence,
        cursor,
        limit: limit + 1,
      }) as Array<{
      context_position: number;
      journal_sequence: number;
      role: "user" | "assistant";
      text: string;
      channel_id: string;
      visibility: ChannelVisibility;
      current_run_input: number;
    }>;
    const hasMore = rows.length > limit,
      pageRows = rows.slice(0, limit),
      messages = pageRows.map((row) => ({
        sequence: row.journal_sequence,
        role: row.role,
        text: row.text,
        sourceChannelId: row.channel_id,
        sourceVisibility: row.visibility,
        currentRunInput: row.current_run_input === 1,
      }));
    return {
      messages,
      nextCursor: hasMore ? (pageRows.at(-1)?.context_position ?? cursor) : null,
    };
  }

  /** Commit the run's one visible reply before acknowledging its journal to the node. */
  commitAgentReply(
    runId: string,
    nodeId: string,
    agentId: string,
    requestId: string,
    text: string,
    replayOnly = false,
  ): boolean {
    const contentHash = createHash("sha256").update(text, "utf8").digest("hex");
    return this.db
      .transaction(() => {
        const run = this.db
          .prepare(
            `SELECT r.state,r.node_id,r.delivery_id,r.input_end_seq,
                    d.channel_id,d.message_id,s.id AS session_id,c.archived AS channel_archived
             FROM owner_agent_runs r
             JOIN owner_message_deliveries d ON d.id=r.delivery_id
             JOIN owner_agent_sessions s ON s.agent_id=r.agent_id
             JOIN owner_channels c ON c.id=d.channel_id
            WHERE r.id=? AND r.node_id=? AND r.agent_id=?`,
          )
          .get(runId, nodeId, agentId) as
          | {
              state: "running" | "completed" | "failed";
              node_id: string;
              delivery_id: string;
              input_end_seq: number;
              channel_id: string;
              message_id: string;
              session_id: string;
              channel_archived: number;
            }
          | undefined;
        if (!run) return false;
        const committed = this.db
          .prepare("SELECT 1 FROM owner_agent_session_journal WHERE run_id=? AND role='assistant'")
          .get(runId);
        if (committed) {
          const existing = this.db
            .prepare(
              `SELECT j.seq,j.message_id,j.request_id,j.content_hash,j.text,
                      m.id AS visible_message_id,m.channel_id AS visible_channel_id,
                      m.author_kind AS visible_author_kind,m.author_id AS visible_author_id,
                      m.text AS visible_text
               FROM owner_agent_session_journal j
               JOIN owner_messages m ON m.id=j.message_id
               WHERE j.run_id=? AND j.agent_id=? AND j.session_id=? AND j.channel_id=? AND j.role='assistant'`,
            )
            .get(runId, agentId, run.session_id, run.channel_id) as
            | {
                seq: number;
                message_id: string;
                request_id: string;
                content_hash: string;
                text: string;
                visible_message_id: string;
                visible_channel_id: string;
                visible_author_kind: string;
                visible_author_id: string;
                visible_text: string;
              }
            | undefined;
          return Boolean(
            run.state === "completed" &&
            existing &&
            Number.isSafeInteger(existing.seq) &&
            existing.seq > 0 &&
            existing.message_id === existing.visible_message_id &&
            existing.request_id === requestId &&
            existing.content_hash === contentHash &&
            existing.text === text &&
            existing.visible_channel_id === run.channel_id &&
            existing.visible_author_kind === "agent" &&
            existing.visible_author_id === agentId &&
            existing.visible_text === text,
          );
        }
        if (replayOnly || run.state !== "running") return false;
        if (run.channel_archived === 1) {
          this.db
            .prepare(
              `UPDATE owner_agent_runs SET state='failed',error_code='channel_archived',
                 retry_at=NULL,completed_at=? WHERE id=? AND agent_id=? AND state='running'`,
            )
            .run(this.now(), runId, agentId);
          return false;
        }

        const at = this.now(),
          messageId = randomUUID(),
          sequence = this.db
            .prepare(
              "SELECT COALESCE(MAX(order_seq),0)+1 AS next FROM owner_messages WHERE channel_id=?",
            )
            .get(run.channel_id) as { next: number };
        this.db
          .prepare(
            "INSERT INTO owner_messages(id,channel_id,order_seq,text,author_kind,author_id,created_at) VALUES(?,?,?,?, 'agent', ?,?)",
          )
          .run(messageId, run.channel_id, sequence.next, text, agentId, at);
        const message = toMessage({
          id: messageId,
          channel_id: run.channel_id,
          order_seq: sequence.next,
          revision: 1,
          text,
          author_kind: "agent",
          author_id: agentId,
          created_at: at,
        });
        this.db
          .prepare(
            "INSERT INTO owner_agent_session_journal(session_id,agent_id,channel_id,message_id,run_id,request_id,content_hash,role,text,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            run.session_id,
            agentId,
            run.channel_id,
            messageId,
            runId,
            requestId,
            contentHash,
            "assistant",
            text,
            at,
          );
        this.queueDeliveries(message, at);
        this.record("message.created", run.channel_id, message);
        this.db
          .prepare(
            `UPDATE owner_message_deliveries SET state='handled',handled_at=?
             WHERE recipient_kind='agent' AND recipient_id=? AND channel_id=? AND state='pending'
               AND message_id IN (
                 SELECT j.message_id FROM owner_agent_session_journal j
                 WHERE j.agent_id=? AND j.session_id=? AND j.role='user'
                   AND j.seq<=? AND j.message_id IS NOT NULL
               )`,
          )
          .run(at, agentId, run.channel_id, agentId, run.session_id, run.input_end_seq);
        this.db
          .prepare(
            "UPDATE owner_agent_runs SET state='completed',completed_at=?,retry_at=NULL,error_code=NULL WHERE id=? AND state='running'",
          )
          .run(at, runId);
        return true;
      })
      .immediate();
  }

  /** A successful silent turn consumes only the owner inputs captured by its run boundary. */
  completeAgentRunSilently(runId: string, agentId: string): boolean {
    return this.db
      .transaction(() => {
        const run = this.db
          .prepare(
            `SELECT r.state,r.input_end_seq,s.id AS session_id,d.channel_id,
                    c.archived AS channel_archived
             FROM owner_agent_runs r JOIN owner_agent_sessions s ON s.agent_id=r.agent_id
             JOIN owner_message_deliveries d ON d.id=r.delivery_id
             JOIN owner_channels c ON c.id=d.channel_id
             WHERE r.id=? AND r.agent_id=?`,
          )
          .get(runId, agentId) as
          | {
              state: string;
              input_end_seq: number;
              session_id: string;
              channel_id: string;
              channel_archived: number;
            }
          | undefined;
        if (!run || run.state !== "running") return false;
        const at = this.now();
        if (run.channel_archived === 1) {
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
                 SELECT j.message_id FROM owner_agent_session_journal j
                 WHERE j.agent_id=? AND j.session_id=? AND j.role='user'
                   AND j.seq<=? AND j.message_id IS NOT NULL
               )`,
          )
          .run(at, agentId, run.channel_id, agentId, run.session_id, run.input_end_seq);
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
    const rows = this.db
      .prepare(
        "SELECT id,channel_id,order_seq,revision,text,author_kind,author_id,created_at FROM owner_messages WHERE channel_id=? AND (? IS NULL OR order_seq < ?) ORDER BY order_seq DESC LIMIT ?",
      )
      .all(channelId, before ?? null, before ?? null, limit + 1) as MessageRow[];
    const hasMore = rows.length > limit,
      messages = rows.slice(0, limit).reverse().map(toMessage);
    return { messages, nextBefore: hasMore ? (messages[0]?.order ?? null) : null };
  }

  private readChannel(id: string): OwnerChannel {
    const row = this.db
      .prepare(
        "SELECT id,name,description,visibility,archived,created_at,updated_at FROM owner_channels WHERE id=?",
      )
      .get(id) as ChannelRow | undefined;
    if (!row) throw new Error("Created channel was not persisted");
    return toChannel(row);
  }

  private activeAgentToolRun(runId: string, nodeId: string, agentId: string): ActiveAgentToolRun {
    const run = this.db
      .prepare(
        `SELECT r.agent_id,r.node_id,r.state,r.independent_review,s.id AS session_id,
                a.node_id AS current_node_id
         FROM owner_agent_runs r
         JOIN owner_agents a ON a.id=r.agent_id
         JOIN owner_agent_sessions s ON s.agent_id=a.id
         WHERE r.id=? AND r.agent_id=?`,
      )
      .get(runId, agentId) as (ActiveAgentToolRun & { current_node_id: string }) | undefined;
    if (!run || run.state !== "running" || run.node_id !== nodeId || run.current_node_id !== nodeId)
      throw new AgentToolRefusal("Agent run is no longer active");
    return run;
  }

  private executeConversationOperation(
    run: ActiveAgentToolRun,
    reviewSeat: boolean,
    toolCallId: string,
    name: string,
    input: Record<string, unknown>,
  ): unknown {
    if (!Object.hasOwn(agentConversationOperations, name))
      throw new AgentToolRefusal("Unknown operation");
    const entry = agentConversationOperations[name as AgentConversationOperation];
    if (reviewSeat && entry.seatPolicy === "deny")
      throw new AgentToolRefusal("Independent review seat isolates this input path");

    switch (name as AgentConversationOperation) {
      case "agents.list":
        agentConversationOperations["agents.list"].schema.parse(input);
        return { agents: this.listContactableAgents(run.agent_id) };
      case "conversations.list":
        agentConversationOperations["conversations.list"].schema.parse(input);
        return { conversations: this.listAgentConversations(run.agent_id) };
      case "conversations.read": {
        const args = agentConversationOperations["conversations.read"].schema.parse(input),
          conversation = this.requireAgentConversation(run.agent_id, args.conversationId),
          before = args.before === undefined ? undefined : Number(args.before);
        if (before !== undefined && !Number.isSafeInteger(before)) throw new z.ZodError([]);
        const page = this.listMessages(args.conversationId, before, args.limit);
        if (!page) throw new AgentToolRefusal("Conversation is not available");
        return { conversation, ...page };
      }
      case "conversations.open_dm": {
        const args = agentConversationOperations["conversations.open_dm"].schema.parse(input);
        if (args.targetAgentId === run.agent_id)
          throw new AgentToolRefusal("An Agent cannot open a direct message with itself");
        if (!this.isInviteableAgent(args.targetAgentId))
          throw new AgentToolRefusal("Direct-message target is not available");
        return this.recordAgentToolAction(run, toolCallId, "conversations.open_dm", args, () =>
          this.getOrCreateAgentPeerDirectChannel(run.agent_id, args.targetAgentId),
        );
      }
      case "messages.send": {
        const args = agentConversationOperations["messages.send"].schema.parse(input);
        this.requireAgentConversation(run.agent_id, args.conversationId);
        return this.recordAgentToolAction(run, toolCallId, "messages.send", args, () =>
          this.createAgentToolMessage(run, args.conversationId, args.text),
        );
      }
      case "conversations.invite": {
        const args = agentConversationOperations["conversations.invite"].schema.parse(input),
          conversation = this.requireAgentConversation(run.agent_id, args.conversationId);
        if (conversation.kind !== "channel")
          throw new AgentToolRefusal("Only a channel can receive an invitation");
        if (args.agentId === run.agent_id)
          throw new AgentToolRefusal("An Agent cannot invite itself");
        const currentMember = this.db
          .prepare(
            "SELECT active FROM owner_channel_memberships WHERE channel_id=? AND principal_kind='agent' AND principal_id=?",
          )
          .get(args.conversationId, args.agentId) as { active: number } | undefined;
        // A valid Agent invitation is effective at this same control-plane commit.
        if (!this.isInviteableAgent(args.agentId))
          throw new AgentToolRefusal("Invitation target is not available");
        return this.recordAgentToolAction(run, toolCallId, "conversations.invite", args, () => {
          if (!this.inviteAgentToChannel(args.conversationId, args.agentId))
            throw new AgentToolRefusal("Invitation target is not available");
          return {
            conversationId: args.conversationId,
            agentId: args.agentId,
            status: "succeeded",
            alreadyMember: currentMember?.active === 1,
          };
        });
      }
    }
  }

  private listAgentConversations(agentId: string): Array<{
    id: string;
    name: string;
    description: string;
    visibility: ChannelVisibility;
    kind: "channel" | "dm";
    member: boolean;
  }> {
    const rows = this.db
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
         WHERE c.archived=0 AND (c.visibility='public' OR m.active=1)
         ORDER BY c.created_at,c.id`,
      )
      .all(agentId) as Array<{
      id: string;
      name: string;
      description: string;
      visibility: ChannelVisibility;
      direct_agent_id: string | null;
      conversation_kind: "channel" | "dm";
      member: number;
    }>;
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
    return this.db
      .prepare(
        `SELECT a.id,a.name,a.role,a.description
         FROM owner_agents a JOIN owner_agent_sessions s ON s.agent_id=a.id
         WHERE a.id<>? AND s.verified_at IS NOT NULL AND a.status='waiting_credentials'
           AND a.linux_username IS NOT NULL AND a.uid IS NOT NULL AND a.gid IS NOT NULL
           AND a.home IS NOT NULL
         ORDER BY a.created_at,a.id`,
      )
      .all(agentId) as Array<{ id: string; name: string; role: string; description: string }>;
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
    const existing = this.db
      .prepare(
        `SELECT channel_id FROM owner_agent_peer_direct_channels
           WHERE first_agent_id=? AND second_agent_id=?`,
      )
      .get(first, second) as { channel_id: string } | undefined;
    if (existing) {
      const channel = this.readChannel(existing.channel_id);
      if (channel.archived) throw new AgentToolRefusal("Direct message is archived");
      return channel;
    }
    const participants = this.db
      .prepare("SELECT id,name FROM owner_agents WHERE id IN (?,?) ORDER BY id")
      .all(first, second) as Array<{ id: string; name: string }>;
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

  private requireAgentConversation(
    agentId: string,
    conversationId: string,
  ): {
    id: string;
    name: string;
    description: string;
    visibility: ChannelVisibility;
    kind: "channel" | "dm";
  } {
    const row = this.db
      .prepare(
        `SELECT c.id,c.name,c.description,c.visibility,
                CASE WHEN d.agent_id IS NOT NULL OR p.channel_id IS NOT NULL
                     THEN 'dm' ELSE 'channel' END AS conversation_kind
         FROM owner_channels c
         JOIN owner_channel_memberships m
           ON m.channel_id=c.id AND m.principal_kind='agent' AND m.principal_id=? AND m.active=1
         LEFT JOIN owner_agent_direct_channels d ON d.channel_id=c.id
         LEFT JOIN owner_agent_peer_direct_channels p ON p.channel_id=c.id
         WHERE c.id=? AND c.archived=0`,
      )
      .get(agentId, conversationId) as
      | {
          id: string;
          name: string;
          description: string;
          visibility: ChannelVisibility;
          conversation_kind: "channel" | "dm";
        }
      | undefined;
    if (!row) throw new AgentToolRefusal("Conversation is not available");
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      kind: row.conversation_kind,
    };
  }

  private isInviteableAgent(agentId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM owner_agent_sessions s JOIN owner_agents a ON a.id=s.agent_id
         WHERE s.agent_id=? AND s.verified_at IS NOT NULL AND a.status='waiting_credentials'
           AND a.linux_username IS NOT NULL AND a.uid IS NOT NULL AND a.gid IS NOT NULL
           AND a.home IS NOT NULL`,
      )
      .get(agentId);
    return !!row;
  }

  private recordAgentToolAction(
    run: ActiveAgentToolRun,
    toolCallId: string,
    operation: AgentConversationOperation,
    input: unknown,
    effect: () => unknown,
  ): unknown {
    const validId = z.string().min(1).max(500).safeParse(toolCallId);
    if (!validId.success) throw new AgentToolRefusal("Invalid action ID");
    const requestHash = createHash("sha256")
        .update(JSON.stringify({ operation, input }))
        .digest("hex"),
      existing = this.db
        .prepare(
          "SELECT request_hash,result_json FROM owner_agent_tool_actions WHERE session_id=? AND action_id=?",
        )
        .get(run.session_id, toolCallId) as
        { request_hash: string; result_json: string } | undefined;
    if (existing) {
      if (existing.request_hash !== requestHash)
        throw new AgentToolRefusal("Action ID was already used for a different request");
      return JSON.parse(existing.result_json) as unknown;
    }
    const result = effect();
    this.db
      .prepare(
        `INSERT INTO owner_agent_tool_actions(
           session_id,action_id,agent_id,operation,request_hash,result_json,created_at
         ) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        run.session_id,
        toolCallId,
        run.agent_id,
        operation,
        requestHash,
        JSON.stringify(result),
        this.now(),
      );
    return result;
  }

  private createAgentToolMessage(
    run: ActiveAgentToolRun,
    channelId: string,
    text: string,
  ): OwnerMessage {
    if (!this.db.inTransaction)
      throw new Error("Agent tool message requires its action transaction");
    const id = randomUUID(),
      at = this.now(),
      sequence = this.db
        .prepare(
          "SELECT COALESCE(MAX(order_seq),0)+1 AS next FROM owner_messages WHERE channel_id=?",
        )
        .get(channelId) as { next: number };
    this.db
      .prepare(
        "INSERT INTO owner_messages(id,channel_id,order_seq,text,author_kind,author_id,created_at) VALUES(?,?,?,?, 'agent', ?,?)",
      )
      .run(id, channelId, sequence.next, text, run.agent_id, at);
    const message = toMessage({
      id,
      channel_id: channelId,
      order_seq: sequence.next,
      revision: 1,
      text,
      author_kind: "agent",
      author_id: run.agent_id,
      created_at: at,
    });
    this.queueDeliveries(message, at);
    const agentRecipients = this.db
      .prepare(
        `SELECT d.recipient_id AS agent_id,s.id AS session_id
         FROM owner_message_deliveries d
         JOIN owner_agent_sessions s ON s.agent_id=d.recipient_id
         WHERE d.message_id=? AND d.recipient_kind='agent' ORDER BY d.seq`,
      )
      .all(id) as Array<{ agent_id: string; session_id: string }>;
    for (const recipient of agentRecipients) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO owner_agent_session_journal(
             session_id,agent_id,channel_id,message_id,role,text,created_at
           ) VALUES(?,?,?,?,'user',?,?)`,
        )
        .run(recipient.session_id, recipient.agent_id, channelId, id, text, at);
    }
    this.db
      .prepare(
        `INSERT INTO owner_agent_session_journal(
           session_id,agent_id,channel_id,message_id,role,text,created_at
         ) VALUES(?,?,?,?,'assistant',?,?)`,
      )
      .run(run.session_id, run.agent_id, channelId, id, text, at);
    this.record("message.created", channelId, message);
    return message;
  }

  private queueDeliveries(message: OwnerMessage, at: number): void {
    if (!this.db.inTransaction)
      throw new Error("Message deliveries require the message transaction");
    // This is the recipient snapshot: later membership changes never backfill this message.
    const members = this.db
      .prepare(
        "SELECT principal_kind,principal_id FROM owner_channel_memberships WHERE channel_id=? AND active=1 ORDER BY principal_kind,principal_id",
      )
      .all(message.channelId) as Array<{
      principal_kind: OwnerPrincipalKind;
      principal_id: string;
    }>;
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
    }
  }

  private record(kind: string, channelId: string, payload: OwnerChannel | OwnerMessage): void {
    if (!this.db.inTransaction)
      throw new Error("Conversation event requires the owning transaction");
    this.db
      .prepare("INSERT INTO owner_chat_events(kind,channel_id,payload,created_at) VALUES(?,?,?,?)")
      .run(kind, channelId, JSON.stringify(payload), this.now());
    this.db
      .prepare(
        "DELETE FROM owner_chat_events WHERE seq <= (SELECT COALESCE(MAX(seq)-?,0) FROM owner_chat_events)",
      )
      .run(eventRetention);
  }
}

function toChannel(row: ChannelRow): OwnerChannel {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): OwnerMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    rootId: null,
    author:
      row.author_kind === "agent"
        ? { kind: "agent", id: row.author_id }
        : { kind: "human", id: "owner" },
    text: row.text,
    order: String(row.order_seq),
    revision: String(row.revision),
    createdAt: row.created_at,
  };
}
