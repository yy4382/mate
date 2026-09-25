import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type ChannelVisibility = "public" | "private";

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
        this.record("message.created", channelId, message);
        return message;
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
