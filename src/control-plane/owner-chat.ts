import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";

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
}

export interface AgentSessionJournalPage {
  messages: AgentSessionJournalEntry[];
  nextAfter: number | null;
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
        const directAgent = this.db
          .prepare("SELECT agent_id FROM owner_agent_direct_channels WHERE channel_id=?")
          .get(channelId) as { agent_id: string } | undefined;
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
        if (directAgent) {
          const session = this.db
            .prepare("SELECT id FROM owner_agent_sessions WHERE agent_id=?")
            .get(directAgent.agent_id) as { id: string } | undefined;
          if (!session) throw new Error("Direct-message Agent session was not persisted");
          this.db
            .prepare(
              "INSERT INTO owner_agent_session_journal(session_id,agent_id,channel_id,message_id,role,text,created_at) VALUES(?,?,?,?,'user',?,?)",
            )
            .run(session.id, directAgent.agent_id, channelId, id, text, at);
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

  listAgentSessionJournal(agentId: string, after: number, limit: number): AgentSessionJournalPage {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("Agent session journal cursor is invalid");
    const rows = this.db
      .prepare(
        `SELECT j.seq,j.role,j.text FROM owner_agent_session_journal j
         JOIN owner_agent_sessions s ON s.id=j.session_id
         WHERE s.agent_id=? AND j.seq>? ORDER BY j.seq LIMIT ?`,
      )
      .all(agentId, after, limit + 1) as Array<{
      seq: number;
      role: "user" | "assistant";
      text: string;
    }>;
    const hasMore = rows.length > limit,
      messages = rows.slice(0, limit).map((row) => ({
        sequence: row.seq,
        role: row.role,
        text: row.text,
      }));
    return {
      messages,
      nextAfter: hasMore ? (messages.at(-1)?.sequence ?? after) : null,
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
            `SELECT r.state,r.node_id,r.delivery_id,d.channel_id,d.message_id,s.id AS session_id
             FROM owner_agent_runs r
             JOIN owner_message_deliveries d ON d.id=r.delivery_id
             JOIN owner_agent_sessions s ON s.agent_id=r.agent_id
             JOIN owner_agent_direct_channels direct ON direct.agent_id=r.agent_id AND direct.channel_id=d.channel_id
            WHERE r.id=? AND r.node_id=? AND r.agent_id=?`,
          )
          .get(runId, nodeId, agentId) as
          | {
              state: "running" | "completed" | "failed";
              node_id: string;
              delivery_id: string;
              channel_id: string;
              message_id: string;
              session_id: string;
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
            "UPDATE owner_message_deliveries SET state='handled',handled_at=? WHERE id=? AND state='pending'",
          )
          .run(at, run.delivery_id);
        this.db
          .prepare(
            "UPDATE owner_agent_runs SET state='completed',completed_at=?,retry_at=NULL,error_code=NULL WHERE id=? AND state='running'",
          )
          .run(at, runId);
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
