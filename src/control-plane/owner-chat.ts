import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

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
  author: { kind: "human"; id: "owner" };
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
          created_at: at,
        });
        this.queueDeliveries(message, at);
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
                m.order_seq,m.revision,m.text,m.created_at
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

  listMessages(
    channelId: string,
    before: number | undefined,
    limit: number,
  ): OwnerMessagePage | undefined {
    if (!this.db.prepare("SELECT 1 FROM owner_channels WHERE id=?").get(channelId))
      return undefined;
    const rows = this.db
      .prepare(
        "SELECT id,channel_id,order_seq,revision,text,created_at FROM owner_messages WHERE channel_id=? AND (? IS NULL OR order_seq < ?) ORDER BY order_seq DESC LIMIT ?",
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
    author: { kind: "human", id: "owner" },
    text: row.text,
    order: String(row.order_seq),
    revision: String(row.revision),
    createdAt: row.created_at,
  };
}
