import { eventRowSchema } from "./rows.js";
import type { OwnerChannel, OwnerChatEvent, OwnerMessage, OwnerTask } from "@mate/protocol/owner";
import type Database from "better-sqlite3";
import { z } from "zod";

const retainedChatEventCount = 1000;

export class ConversationEvents {
  private pushMessage?: (message: OwnerMessage, directToOwner: boolean) => void;
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number,
  ) {}

  setPushHandler(handler: (message: OwnerMessage, directToOwner: boolean) => void): void {
    this.pushMessage = handler;
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

  eventCursor(): number {
    const result = z
      .looseObject({ cursor: z.number() })
      .parse(this.db.prepare("SELECT COALESCE(MAX(seq),0) AS cursor FROM owner_chat_events").get());
    return result.cursor;
  }

  record(kind: string, channelId: string, payload: OwnerChannel | OwnerMessage | OwnerTask): void {
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
      .run(retainedChatEventCount);
  }
}
