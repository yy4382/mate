export interface InputNormalizer {
  normalize(appId: string, eventId: string): void;
}
import { encode } from "../storage/store.js";
import type { Collaboration } from "../collaboration/service.js";

/** Message provenance selects an activity; each recipient spends its existing Agent account. */
export class Ingress {
  constructor(
    readonly collaboration: Collaboration,
    readonly normalizer: InputNormalizer,
  ) {}
  replay(appId: string, eventId: string): void {
    const c = this.collaboration,
      s = c.store;
    s.atomic(() => {
      const row = s.db
        .prepare("SELECT body FROM ingress WHERE app_id=? AND event_id=? AND normalized=0")
        .get(appId, eventId) as { body: string } | undefined;
      if (!row) return;
      this.normalizer.normalize(appId, eventId);
      const pending = s.db
        .prepare(
          "SELECT d.id,d.agent_id,d.payload FROM deliveries d LEFT JOIN delivery_work w ON w.delivery_id=d.id WHERE w.work_id IS NULL AND d.status='pending'",
        )
        .all() as { id: string; agent_id: string; payload: string }[];
      for (const delivery of pending) {
        const payload = JSON.parse(delivery.payload);
        if (!payload.messageKey) continue;
        const msg = c.messages.records.message(payload.messageKey);
        if (!msg) continue;
        const bound = s.db
          .prepare("SELECT work_id FROM message_work WHERE message_key=?")
          .get(payload.messageKey) as { work_id: string } | undefined;
        let workId = bound?.work_id;
        if (
          !workId &&
          ["human", "agent", "external"].includes(payload.source?.kind) &&
          payload.source.id
        ) {
          const threadRoot = msg.rootId;
          const parent = s.db
            .prepare("SELECT work_id FROM message_work WHERE message_key=?")
            .get(threadRoot) as { work_id: string } | undefined;
          workId = parent?.work_id ?? c.createWork(`message:${payload.messageKey}`, payload.target);
          s.db
            .prepare("INSERT INTO message_work VALUES(?,?) ON CONFLICT DO NOTHING")
            .run(payload.messageKey, workId);
        }
        if (workId) c.bindDelivery(delivery.id, workId);
        // Non-message deliveries require a trusted scheduler binding.
        else if (payload.source?.kind === "external_bot")
          s.db.prepare("UPDATE deliveries SET status='handled' WHERE id=?").run(delivery.id);
      }
      s.audit("ingress_replayed", { appId, eventId });
    });
  }
  /** A peer echo can arrive before the sender's HTTP receipt; bind after outbox reconciliation. */
  bindPeerEchoes(): void {
    const s = this.collaboration.store;
    s.db
      .prepare(
        `INSERT INTO delivery_work(delivery_id,work_id)
      SELECT d.id,m.work_id FROM deliveries d JOIN message_work m ON m.message_key=json_extract(d.payload,'$.messageKey')
      WHERE d.status='pending' ON CONFLICT DO NOTHING`,
      )
      .run();
  }
}
