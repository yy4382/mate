import { directRequest } from "./attention-policy.js";
import type { AgentDirectory } from "../agents/directory.js";
import { compareMessageOrder, parseMessage, type MessageDTO } from "../domain/messages.js";
import type { ConversationTarget } from "../domain/conversations.js";
import { encode, type Store } from "../storage/store.js";
import type { ConversationRecords } from "../storage/conversations.js";
import type { CanonicalWrites } from "../storage/conversation-writes.js";
import type { References } from "./references.js";

export interface ParticipationPolicy {
  participates(actor: string, conversationId: string): boolean;
}
/** Canonical ingestion, independent of transports. Visibility is supplied by a trusted adapter. */
export class MessageIngestion {
  constructor(
    readonly store: Store,
    readonly references: References,
    readonly records: ConversationRecords,
    readonly writes: CanonicalWrites,
    readonly agents: AgentDirectory,
    readonly policy: ParticipationPolicy,
    readonly matchesText: (expected: string, observed: string) => boolean = (a, b) => a === b,
  ) {}
  record(
    input: MessageDTO,
    visibleTo: readonly string[],
    mode: "event" | "history" = "event",
  ): void {
    const message = parseMessage(input);
    this.store.atomic(() => {
      this.writes.assertFormat();
      const conversation = this.references.conversation(message.conversationId);
      const old = this.records.message(message.id);
      if (old && (old.conversationId !== message.conversationId || old.order !== message.order))
        throw new Error("Message location/order is immutable");
      if (old?.rootId && message.rootId && old.rootId !== message.rootId)
        throw new Error("Message root conflict");
      let effective = old;
      let kind: string | undefined;
      let globalEvent = false;
      if (!old || compareMessageOrder(message.revision, old.revision) > 0) {
        effective = {
          ...message,
          rootId: message.rootId ?? old?.rootId ?? null,
          ...(message.author.kind === "unknown" && old ? { author: old.author } : {}),
          ...(message.deleted && old ? { origin: old.origin } : {}),
        };
        kind = message.deleted ? "delete" : old ? "edit" : "message";
      } else if (old.rootId === null && message.rootId !== null) {
        effective = { ...old, rootId: message.rootId };
        kind = old.deleted ? "delete" : "location_enriched";
      }
      if (
        old &&
        !old.deleted &&
        compareMessageOrder(message.revision, old.revision) === 0 &&
        message.attachments.length &&
        !old.attachments.length
      ) {
        effective = { ...(effective ?? old), attachments: message.attachments };
        kind = "files_enriched";
      }
      if (!effective) throw new Error("Message missing");
      if (effective.rootId === null)
        this.references.reserveMessage(effective.conversationId, effective.id);
      else {
        const root =
          effective.rootId !== effective.id ? this.records.message(effective.rootId) : undefined;
        this.references.createMessage(effective.conversationId, effective.rootId);
        if (root && root.rootId === null) {
          this.writes.message({ ...root, rootId: root.id });
          this.store.db
            .prepare(
              "INSERT INTO conversation_events(channel,thread,message_key,revision,kind) VALUES(?,?,?,?,?)",
            )
            .run(root.conversationId, root.id, root.id, root.revision, "location_enriched");
        }
        this.references.createMessage(effective.conversationId, effective.id, effective.rootId);
      }
      if (kind) {
        this.writes.message(effective);
        if (conversation.authority === "internal" && old) {
          this.store.db
            .prepare(
              "UPDATE projection_outbox SET drift='source_changed',state=CASE WHEN state IN ('pending','held') THEN 'failed' ELSE state END,reason=CASE WHEN state IN ('pending','held') THEN 'source_changed_before_publication' ELSE reason END WHERE message_id=? AND anchor=0 AND source_revision!=?",
            )
            .run(effective.id, effective.revision);
        }
        // Same-revision external enrichment is installation-specific. Actor-scoped
        // visibility events below carry its freshness without waking other apps.
        if (
          conversation.authority !== "external" ||
          !old ||
          compareMessageOrder(message.revision, old.revision) !== 0
        ) {
          this.store.db
            .prepare(
              "INSERT INTO conversation_events(channel,thread,message_key,revision,kind) VALUES(?,?,?,?,?)",
            )
            .run(
              effective.conversationId,
              effective.rootId,
              effective.id,
              effective.revision,
              kind,
            );
          globalEvent = true;
        }
      }
      this.writes.revision(message);
      for (const actor of new Set(visibleTo)) {
        this.agents.get(actor);
        if (
          !this.store.db
            .prepare("SELECT 1 FROM channel_access WHERE agent_id=? AND channel=? AND active=1")
            .get(actor, effective.conversationId)
        )
          continue;
        const prior = this.store.db
          .prepare("SELECT revision,body FROM message_visibility WHERE agent_id=? AND key=?")
          .get(actor, effective.id) as { revision: string; body: string } | undefined;
        const priorRevision = prior?.revision,
          newerPrior = priorRevision && compareMessageOrder(priorRevision, message.revision) > 0;
        const observedRevision = newerPrior ? priorRevision : message.revision;
        const observedBody =
          newerPrior && prior ? prior.body : encode({ format: "mate.message.v2", message });
        const visibilityChanged =
          !prior || priorRevision !== observedRevision || prior.body !== observedBody;
        this.store.db
          .prepare(
            "INSERT INTO message_visibility(agent_id,key,revision,body) VALUES(?,?,?,?) ON CONFLICT(agent_id,key) DO UPDATE SET revision=excluded.revision,body=excluded.body",
          )
          .run(actor, effective.id, observedRevision, observedBody);
        if (old && !globalEvent && (!prior || visibilityChanged))
          this.store.db
            .prepare(
              "INSERT INTO conversation_events(channel,thread,message_key,revision,kind,audience) VALUES(?,?,?,?,?,?)",
            )
            .run(
              effective.conversationId,
              effective.rootId,
              effective.id,
              observedRevision,
              "visibility",
              actor,
            );
        if (mode === "history") continue; // History never consumes event dedupe or acknowledges presentation.
        if (priorRevision && compareMessageOrder(priorRevision, message.revision) > 0) continue;
        if (priorRevision === message.revision && visibilityChanged)
          this.store.db
            .prepare("DELETE FROM attention_seen WHERE agent_id=? AND key=?")
            .run(actor, message.id);
        const observed = message;
        if (
          !observed.deleted &&
          observed.author.kind === "agent" &&
          observed.attachments.length === 1
        ) {
          const publications = this.store.db
            .prepare(
              "SELECT o.id,o.agent_id,o.request FROM outbox o JOIN attention_seen seen ON seen.agent_id=? AND seen.key='artifact:'||json_extract(o.receipt,'$.fileId') WHERE o.state='sent' AND json_extract(o.receipt,'$.fileId')=?",
            )
            .all(actor, observed.attachments[0]!.id) as {
            id: string;
            agent_id: string;
            request: string;
          }[];
          for (const publication of publications) {
            const target = this.records.targetedEffect("outbox", publication.id).target;
            if (
              publication.agent_id === observed.author.id &&
              target.conversationId === observed.conversationId &&
              observed.rootId === (target.threadId ?? observed.id) &&
              this.matchesText(JSON.parse(publication.request).text, observed.text)
            ) {
              this.store.db
                .prepare(
                  "INSERT INTO attention_seen VALUES(?,?,?) ON CONFLICT(agent_id,key) DO UPDATE SET revision=excluded.revision",
                )
                .run(actor, observed.id, observed.revision);
              break;
            }
          }
        }
        if (
          !this.store.db
            .prepare("INSERT INTO message_observations VALUES(?,?,?) ON CONFLICT DO NOTHING")
            .run(actor, observed.id, observed.revision).changes
        )
          continue;
        if (
          observed.deleted ||
          observed.origin === "system" ||
          (observed.author.kind === "agent" && observed.author.id === actor)
        )
          continue;
        const direct = directRequest(actor, observed, conversation.kind);
        const watched =
          !!this.store.db
            .prepare("SELECT 1 FROM channel_watches WHERE agent_id=? AND channel=?")
            .get(actor, observed.conversationId) ||
          !!this.store.db
            .prepare("SELECT 1 FROM thread_watches WHERE agent_id=? AND channel=? AND thread=?")
            .get(actor, observed.conversationId, observed.rootId);
        if (!direct && !watched && !this.policy.participates(actor, observed.conversationId))
          continue;
        const target: ConversationTarget = {
          conversationId: observed.conversationId,
          ...(observed.rootId ? { threadId: observed.rootId } : {}),
        };
        const now = Date.now();
        if (
          this.store.db
            .prepare(
              "SELECT 1 FROM attention_state WHERE agent_id=? AND target IN (?,?) AND ((muted=1 AND ?=0) OR deferred_until>?)",
            )
            .get(
              actor,
              encode({ conversationId: effective.conversationId }),
              encode(target),
              Number(direct),
              now,
            )
        )
          continue;
        const work = this.store.db
          .prepare("SELECT work_id FROM message_work WHERE message_key=?")
          .get(observed.id) as { work_id: string } | undefined;
        const notice = !direct && !watched,
          bucket = Math.floor(now / 20000);
        const delivery = this.writes.enqueue(
          actor,
          notice
            ? `notice:${observed.conversationId}:${work?.work_id ?? "unbound"}:${bucket}`
            : `message:${observed.id}:${observed.revision}`,
          {
            kind: notice ? "notice" : "message",
            messageKey: observed.id,
            revision: observed.revision,
            source: observed.author,
            target,
            receivedAt: now,
            ...(notice
              ? {
                  notBefore: (bucket + 1) * 20000,
                  conversationId: observed.conversationId,
                  windowStart: bucket * 20000,
                }
              : {}),
          },
          direct ? (observed.author.kind === "agent" ? 50 : 100) : watched ? 20 : 0,
          now,
        );
        if (work)
          this.store.db
            .prepare("INSERT INTO delivery_work VALUES(?,?) ON CONFLICT DO NOTHING")
            .run(delivery, work.work_id);
      }
    });
  }
}
