import { beginCanonicalSchema, finishCanonicalSchema } from "../storage/canonical-schema.js";
import type { MateConfig } from "../config.js";
import { References } from "../conversations/references.js";
import { encode, type Store } from "../storage/store.js";
import { LegacyConversationCodec } from "./legacy-codec.js";
import { migrateLegacyReferences } from "./reference-migration.js";

export const canonicalConversationFormat = "mate.conversations.v2";

/** Offline data conversion. The caller owns the process lock and pre-migration backup.
 * Fresh empty stores use the same conversion; existing stores require the offline command.
 */
export function migrateCanonicalConversations(store: Store, config: MateConfig): void {
  store.atomic(() => {
    const marker = store.db
      .prepare("SELECT value FROM runtime_meta WHERE key='conversation_format'")
      .get() as { value: string } | undefined;
    if (marker) {
      if (
        marker.value !== canonicalConversationFormat ||
        ![17, 18, 19, 20, 21, 22, 23, 24, 25].includes(
          Number(store.db.pragma("user_version", { simple: true })),
        )
      )
        throw new Error("Unsupported conversation data format");
      const source = store.db
        .prepare("SELECT value FROM runtime_meta WHERE key='reference_migration_v16'")
        .get() as { value: string } | undefined;
      // Local-origin canonical stores have no legacy Slack provenance. Their installation
      // identity is governed by the persisted configuration, not a fabricated migration.
      if (source && JSON.parse(source.value).workspace !== config.teamId)
        throw new Error("Conversation migration workspace mismatch");
      if (!source) {
        for (const table of ["messages", "message_revisions"]) {
          if (
            store.db
              .prepare(
                `SELECT 1 FROM ${table} WHERE json_extract(body,'$.format') IS NOT 'mate.message.v2' LIMIT 1`,
              )
              .get()
          )
            throw new Error("Legacy messages require migration provenance");
        }
        if (
          store.db
            .prepare(
              "SELECT 1 FROM outbox WHERE json_extract(request,'$.format') IS NOT 'mate.effect.v2' LIMIT 1",
            )
            .get()
        )
          throw new Error("Legacy outputs require migration provenance");
        if (
          store.db
            .prepare(
              "SELECT 1 FROM actions WHERE json_extract(request,'$.format') IS NOT 'mate.effect.v2' AND (json_extract(request,'$.target') IS NOT NULL OR json_extract(request,'$.args.target') IS NOT NULL OR json_extract(request,'$.operation')='conversations.openDM') LIMIT 1",
            )
            .get()
        )
          throw new Error("Legacy conversation actions require migration provenance");
      }

      return;
    }
    if (store.db.pragma("user_version", { simple: true }) !== 16)
      throw new Error("Unsupported legacy conversation schema");
    migrateLegacyReferences(store, config.teamId);
    beginCanonicalSchema(store);
    const refs = new References(store),
      codec = new LegacyConversationCodec(refs, config);
    const target = (value: string) => encode(codec.target(JSON.parse(value)));
    const localMessage = (channel: string, ts: string): string => {
      const id = refs.findMessage({
        provider: "slack",
        workspace: config.teamId,
        externalId: channel,
        messageId: ts,
      });
      if (!id) throw new Error("Missing legacy message reference");
      return id;
    };
    const revision = (value: string): string => {
      if (!/^\d{1,16}\.\d{1,6}$/.test(value)) throw new Error("Invalid legacy message revision");
      const [whole, fraction] = value.split(".");
      return (BigInt(whole!) * 1000000n + BigInt(fraction!.padEnd(6, "0"))).toString();
    };

    for (const table of ["works", "tasks", "schedules", "task_intents", "review_seats"] as const) {
      const key = table === "review_seats" ? "agent_id" : "id";
      for (const row of store.db.prepare(`SELECT ${key} id,target FROM ${table}`).all() as {
        id: string;
        target: string;
      }[]) {
        store.db
          .prepare(`UPDATE ${table} SET target=? WHERE ${key}=?`)
          .run(target(row.target), row.id);
      }
    }
    for (const row of store.db
      .prepare("SELECT id,anchor FROM schedules WHERE anchor IS NOT NULL")
      .all() as { id: string; anchor: string }[]) {
      const old = JSON.parse(row.anchor);
      store.db
        .prepare("UPDATE schedules SET anchor=? WHERE id=?")
        .run(encode({ messageId: localMessage(old.channel, old.ts) }), row.id);
    }
    for (const row of store.db.prepare("SELECT id,args FROM task_intents").all() as {
      id: string;
      args: string;
    }[]) {
      const args = JSON.parse(row.args);
      if (args.message)
        args.message = { messageId: localMessage(args.message.channel, args.message.ts) };
      store.db.prepare("UPDATE task_intents SET args=? WHERE id=?").run(encode(args), row.id);
    }
    for (const row of store.db.prepare("SELECT agent_id,target FROM attention_state").all() as {
      agent_id: string;
      target: string;
    }[]) {
      const next = target(row.target);
      store.db
        .prepare("UPDATE attention_state SET target=? WHERE agent_id=? AND target=?")
        .run(next, row.agent_id, row.target);
      store.db
        .prepare(
          "DELETE FROM canonical_targets WHERE object_type='attention_state' AND object_id=?",
        )
        .run(encode([row.agent_id, row.target]));
      refs.indexTarget("attention_state", encode([row.agent_id, next]), JSON.parse(next));
    }
    for (const row of store.db
      .prepare("SELECT agent_id,channel,thread FROM thread_watches")
      .all() as { agent_id: string; channel: string; thread: string }[]) {
      const next = codec.target({ channel: row.channel, thread: row.thread });
      store.db
        .prepare(
          "UPDATE thread_watches SET channel=?,thread=? WHERE agent_id=? AND channel=? AND thread=?",
        )
        .run(next.conversationId, next.threadId, row.agent_id, row.channel, row.thread);
      store.db
        .prepare("DELETE FROM canonical_targets WHERE object_type='thread_watch' AND object_id=?")
        .run(encode([row.agent_id, row.channel, row.thread]));
      refs.indexTarget(
        "thread_watch",
        encode([row.agent_id, next.conversationId, next.threadId]),
        next,
      );
    }
    for (const row of store.db.prepare("SELECT key,body FROM messages").all() as {
      key: string;
      body: string;
    }[]) {
      const message = codec.message(row.body);
      if (message.id !== row.key) throw new Error("Stored message identity mismatch");
      store.db
        .prepare("UPDATE messages SET channel=?,ts=?,thread=?,revision=? WHERE key=?")
        .run(message.conversationId, message.order, message.rootId, message.revision, row.key);
    }
    // Historical bodies stay byte-for-byte; only their lookup/comparison columns change.
    for (const row of store.db.prepare("SELECT key,revision FROM message_revisions").all() as {
      key: string;
      revision: string;
    }[]) {
      store.db
        .prepare("UPDATE message_revisions SET revision=? WHERE key=? AND revision=?")
        .run(revision(row.revision), row.key, row.revision);
    }
    for (const row of store.db
      .prepare("SELECT agent_id,key,revision FROM message_observations")
      .all() as { agent_id: string; key: string; revision: string }[]) {
      store.db
        .prepare(
          "UPDATE message_observations SET revision=? WHERE agent_id=? AND key=? AND revision=?",
        )
        .run(revision(row.revision), row.agent_id, row.key, row.revision);
    }
    for (const row of store.db
      .prepare(
        "SELECT s.agent_id,s.key,s.revision FROM attention_seen s JOIN messages m ON m.key=s.key",
      )
      .all() as { agent_id: string; key: string; revision: string }[]) {
      store.db
        .prepare("UPDATE attention_seen SET revision=? WHERE agent_id=? AND key=?")
        .run(revision(row.revision), row.agent_id, row.key);
    }
    for (const row of store.db
      .prepare("SELECT seq,channel,thread,message_key,revision,kind FROM conversation_events")
      .all() as {
      seq: number;
      channel: string;
      thread: string;
      message_key: string;
      revision: string;
      kind: string;
    }[]) {
      const identity = store.db
        .prepare("SELECT root_id FROM message_identities WHERE id=?")
        .get(row.message_key) as { root_id: string | null } | undefined;
      const next = codec.target({
        channel: row.channel,
        ...(row.thread && !identity ? { thread: row.thread } : {}),
      });
      const rootId = identity ? identity.root_id : next.threadId;
      store.db
        .prepare("UPDATE conversation_events SET channel=?,thread=?,revision=? WHERE seq=?")
        .run(
          next.conversationId,
          rootId ?? null,
          ["message", "edit", "delete", "files_enriched", "visibility"].includes(row.kind)
            ? revision(row.revision)
            : row.revision,
          row.seq,
        );
    }
    for (const row of store.db.prepare("SELECT id,payload FROM deliveries").all() as {
      id: string;
      payload: string;
    }[]) {
      const payload = JSON.parse(row.payload);
      if (payload.target) payload.target = codec.target(payload.target);
      if (payload.anchor)
        payload.anchor = { messageId: localMessage(payload.anchor.channel, payload.anchor.ts) };
      if (payload.messageKey && payload.revision) payload.revision = revision(payload.revision);
      if (payload.messageKey) {
        const row = store.db
          .prepare("SELECT body FROM messages WHERE key=?")
          .get(payload.messageKey) as { body: string } | undefined;
        if (row) payload.source = codec.message(row.body).author;
      }
      if (payload.channel) {
        payload.conversationId = codec.target({ channel: payload.channel }).conversationId;
        delete payload.channel;
      }
      store.db.prepare("UPDATE deliveries SET payload=? WHERE id=?").run(encode(payload), row.id);
    }
    for (const row of store.db.prepare("SELECT id,request FROM outbox").all() as {
      id: string;
      request: string;
    }[]) {
      store.db
        .prepare("UPDATE outbox SET target=? WHERE id=?")
        .run(encode(codec.target(JSON.parse(row.request).target)), row.id);
    }
    finishCanonicalSchema(store);
    store.db.exec("DROP TABLE canonical_targets");
    store.db.prepare("UPDATE sessions SET context_epoch=context_epoch+1").run();
    store.db.pragma("user_version=17");
    store.db
      .prepare("INSERT INTO runtime_meta(key,value) VALUES('conversation_format',?)")
      .run(canonicalConversationFormat);
  });
}
