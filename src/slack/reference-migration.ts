import { z } from "zod";
import { References } from "../conversations/references.js";
import type { ConversationTarget } from "../domain/conversations.js";
import { encode, type Store } from "../storage/store.js";

const channelId = z.string().regex(/^[CDG][A-Z0-9]+$/);
const timestamp = z.string().regex(/^\d{1,16}\.\d{1,6}$/);
const legacyTarget = z.object({ channel: channelId, thread: timestamp.optional() }).strict();

/** Offline, trusted legacy adapter. Wire payloads and journal bytes are never rewritten. */
export function migrateLegacyReferences(store: Store, workspace: string): void {
  if (store.db.pragma("user_version", { simple: true }) !== 16)
    throw new Error("Legacy reference migration only supports schema 16");
  z.string()
    .regex(/^T[A-Z0-9]+$/)
    .parse(workspace);
  const references = new References(store);
  const conversation = (channel: string): string => {
    channelId.parse(channel);
    references.createConversation(channel.startsWith("D") ? "dm" : "channel", "external", channel);
    references.bindConversation(
      { provider: "slack", workspace, externalId: channel },
      channel,
      "primary",
    );
    return channel;
  };
  const root = (channel: string, localId: string): string => {
    timestamp.parse(localId);
    const conversationId = conversation(channel),
      id = encode([workspace, channel, localId]);
    references.createMessage(conversationId, id);
    references.bindMessage(
      { provider: "slack", workspace, externalId: channel, messageId: localId },
      id,
    );
    return id;
  };
  const target = (input: unknown): ConversationTarget => {
    const old = legacyTarget.parse(input);
    return {
      conversationId: conversation(old.channel),
      ...(old.thread ? { threadId: root(old.channel, old.thread) } : {}),
    };
  };
  const index = (type: string, id: string, input: unknown): void => {
    references.indexTarget(type, id, target(input));
  };

  store.atomic(() => {
    // Source identity includes workspace; a same-ts message in another channel is distinct.
    const messages = store.db
      .prepare("SELECT key,channel,ts,thread,deleted FROM messages")
      .all() as { key: string; channel: string; ts: string; thread: string; deleted: number }[];
    for (const message of messages) {
      timestamp.parse(message.ts);
      timestamp.parse(message.thread);
      if (message.key !== encode([workspace, message.channel, message.ts]))
        throw new Error("Legacy message workspace or identity conflict");
      const conversationId = conversation(message.channel);
      // A deletion envelope may not identify the original reply's thread. Its
      // legacy self-thread fallback is not evidence that it was a root.
      if (message.deleted && message.ts === message.thread)
        references.reserveMessage(conversationId, message.key);
      else {
        const rootId = root(message.channel, message.thread);
        references.createMessage(conversationId, message.key, rootId);
      }
      references.bindMessage(
        { provider: "slack", workspace, externalId: message.channel, messageId: message.ts },
        message.key,
      );
    }
    for (const row of store.db
      .prepare(
        "SELECT DISTINCT channel FROM channel_access UNION SELECT channel FROM channel_watches",
      )
      .all() as { channel: string }[])
      conversation(row.channel);
    for (const row of store.db
      .prepare("SELECT agent_id,channel,thread FROM thread_watches")
      .all() as { agent_id: string; channel: string; thread: string }[]) {
      index("thread_watch", encode([row.agent_id, row.channel, row.thread]), {
        channel: row.channel,
        thread: row.thread,
      });
    }
    const sources = [
      { table: "works", id: "id" },
      { table: "tasks", id: "id" },
      { table: "schedules", id: "id" },
      { table: "task_intents", id: "id" },
      { table: "review_seats", id: "agent_id" },
    ] as const;
    for (const source of sources) {
      for (const row of store.db
        .prepare(`SELECT ${source.id} id,target FROM ${source.table}`)
        .all() as { id: string; target: string }[])
        index(source.table, row.id, JSON.parse(row.target));
    }
    for (const row of store.db
      .prepare("SELECT id,anchor FROM schedules WHERE anchor IS NOT NULL")
      .all() as { id: string; anchor: string }[]) {
      const anchor = JSON.parse(row.anchor);
      conversation(anchor.channel);
      timestamp.parse(anchor.ts);
      const locator = {
        provider: "slack",
        workspace,
        externalId: anchor.channel,
        messageId: anchor.ts,
      };
      if (!references.findMessage(locator)) {
        const id = encode([workspace, anchor.channel, anchor.ts]);
        references.reserveMessage(anchor.channel, id);
        references.bindMessage(locator, id);
      }
    }
    for (const row of store.db.prepare("SELECT id,args FROM task_intents").all() as {
      id: string;
      args: string;
    }[]) {
      const args = JSON.parse(row.args);
      if (args.message) {
        conversation(args.message.channel);
        timestamp.parse(args.message.ts);
        const locator = {
          provider: "slack",
          workspace,
          externalId: args.message.channel,
          messageId: args.message.ts,
        };
        if (!references.findMessage(locator)) {
          const id = encode([workspace, args.message.channel, args.message.ts]);
          references.reserveMessage(args.message.channel, id);
          references.bindMessage(locator, id);
        }
      }
    }
    for (const row of store.db.prepare("SELECT id,request FROM outbox").all() as {
      id: string;
      request: string;
    }[]) {
      const request = JSON.parse(row.request);
      index("outbox", row.id, request.target);
    }
    for (const row of store.db.prepare("SELECT id,payload FROM deliveries").all() as {
      id: string;
      payload: string;
    }[]) {
      const payload = JSON.parse(row.payload);
      if (payload.target) index("deliveries", row.id, payload.target);
    }
    for (const row of store.db.prepare("SELECT id,request FROM actions").all() as {
      id: string;
      request: string;
    }[]) {
      const request = JSON.parse(row.request);
      if (request.args?.target) index("actions", row.id, request.args.target);
      else if (request.target) index("actions", row.id, request.target);
    }
    for (const row of store.db.prepare("SELECT agent_id,target FROM attention_state").all() as {
      agent_id: string;
      target: string;
    }[])
      index("attention_state", encode([row.agent_id, row.target]), JSON.parse(row.target));
    // Legacy page snapshots are evidence; epoch invalidation prevents reusing them as new views.
    const initialized = store.db
      .prepare("SELECT 1 FROM runtime_meta WHERE key='reference_migration_v16'")
      .get();
    if (!initialized) {
      store.db.prepare("UPDATE sessions SET context_epoch=context_epoch+1").run();
      store.db
        .prepare("INSERT INTO runtime_meta VALUES('reference_migration_v16',?)")
        .run(encode({ workspace }));
    } else {
      const prior = store.db
        .prepare("SELECT value FROM runtime_meta WHERE key='reference_migration_v16'")
        .get() as { value: string };
      if (JSON.parse(prior.value).workspace !== workspace)
        throw new Error("Reference migration workspace mismatch");
    }
  });
}
