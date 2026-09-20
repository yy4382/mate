import { encode } from '../storage/store.js';
import type { Collaboration } from '../collaboration/service.js';
import { messageKey, type NormalMessage } from '../slack/messages.js';
/** Durable replay never creates fresh budget roots for peer echoes or external bots. */
export class Ingress {
  constructor(readonly collaboration: Collaboration) {}
  replay(appId: string, eventId: string): void {
    const c = this.collaboration, s = c.store;
    s.atomic(() => {
      const row = s.db.prepare('SELECT body FROM ingress WHERE app_id=? AND event_id=? AND normalized=0').get(appId, eventId) as { body: string } | undefined;
      if (!row) return;
      const body = JSON.parse(row.body), event = body.event;
      if (body.team_id !== c.config.teamId) throw new Error('Wrong workspace');
      const agent = c.config.agents.find(a => a.slackAppId === appId); if (!agent) throw new Error('Unknown app');
      // DMs received through this authenticated bot connection establish visibility.
      if (event?.type === 'message' && /^D[A-Z0-9]+$/.test(event.channel)) c.messages.membership(agent.id, event.channel, true);
      c.messages.normalize(appId, eventId);
      const pending = s.db.prepare("SELECT d.id,d.agent_id,d.payload FROM deliveries d LEFT JOIN delivery_work w ON w.delivery_id=d.id WHERE w.work_id IS NULL AND d.status='pending'").all() as { id: string; agent_id: string; payload: string }[];
      for (const delivery of pending) {
        const payload = JSON.parse(delivery.payload); if (!payload.messageKey) continue;
        const message = s.db.prepare('SELECT body FROM messages WHERE key=?').get(payload.messageKey) as { body: string } | undefined;
        if (!message) continue; const msg = JSON.parse(message.body) as NormalMessage;
        const bound = s.db.prepare('SELECT work_id FROM message_work WHERE message_key=?').get(payload.messageKey) as { work_id: string } | undefined;
        let workId = bound?.work_id;
        if (!workId && payload.source?.kind === 'human' && payload.source.id) {
          const threadRoot = messageKey({ team: msg.team, channel: msg.channel, ts: msg.thread });
          const parent = s.db.prepare('SELECT work_id FROM message_work WHERE message_key=?').get(threadRoot) as { work_id: string } | undefined;
          workId = parent?.work_id ?? c.createWork(`human:${payload.messageKey}`, payload.target);
          s.db.prepare('INSERT INTO message_work VALUES(?,?) ON CONFLICT DO NOTHING').run(payload.messageKey, workId);
        }
        if (workId) c.bindDelivery(delivery.id, workId);
        // Unmapped peers remain held until the sent outbox receipt binds their message.
        else if (payload.source?.kind === 'external_bot') s.db.prepare("UPDATE deliveries SET status='handled' WHERE id=?").run(delivery.id);
      }
      s.audit('ingress_replayed', { appId, eventId });
    });
  }
  /** A peer echo can arrive before the sender's HTTP receipt; bind after outbox reconciliation. */
  bindPeerEchoes(): void {
    const s = this.collaboration.store;
    s.db.prepare(`INSERT INTO delivery_work(delivery_id,work_id)
      SELECT d.id,m.work_id FROM deliveries d JOIN message_work m ON m.message_key=json_extract(d.payload,'$.messageKey')
      WHERE d.status='pending' ON CONFLICT DO NOTHING`).run();
  }
}
