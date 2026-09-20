import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Store, encode } from '../storage/store.js';
import type { AgentConfig, MateConfig } from '../config.js';

export const slackTs = z.string().regex(/^\d{1,16}\.\d{1,6}$/);
export const targetSchema = z.object({ channel: z.string().regex(/^[CDG][A-Z0-9]+$/), thread: slackTs }).strict();
export type Target = z.infer<typeof targetSchema>;
export interface NormalMessage { team: string; channel: string; ts: string; thread: string; revision: string; text: string; user?: string; bot?: string; deleted: boolean }
interface MessageRow { key: string; channel: string; ts: string; thread: string; revision: string; body: string; deleted: number }
function timestamp(value: string): bigint { const [a, b] = value.split('.'); return BigInt(a!) * 1000000n + BigInt(b!.padEnd(6, '0')); }
export function messageKey(message: Pick<NormalMessage, 'team' | 'channel' | 'ts'>): string { return encode([message.team, message.channel, message.ts]); }
const rawMessage = z.object({ type: z.string(), channel: z.string(), ts: slackTs.optional(), event_ts: slackTs.optional(), thread_ts: slackTs.optional(),
  text: z.string().optional(), user: z.string().optional(), bot_id: z.string().optional(), subtype: z.string().optional(), deleted_ts: slackTs.optional(),
  message: z.object({ ts: slackTs, thread_ts: slackTs.optional(), text: z.string().optional(), user: z.string().optional(), bot_id: z.string().optional(), edited: z.object({ ts: slackTs }).optional() }).optional() }).passthrough();

export class Messages {
  constructor(readonly store: Store, readonly config: MateConfig) {}
  agent(id: string): AgentConfig { const a = this.config.agents.find(a => a.id === id); if (!a) throw new Error('Unknown Agent'); return a; }
  access(agentId: string, channel: string): boolean {
    return !!this.store.db.prepare('SELECT 1 FROM channel_access WHERE agent_id=? AND channel=? AND active=1').get(agentId, channel);
  }
  requireAccess(agentId: string, channel: string): void { this.agent(agentId); if (!this.access(agentId, channel)) throw new Error('Channel access denied'); }
  /** Only trusted Slack membership reconciliation or authenticated member events call this. */
  membership(agentId: string, channel: string, active: boolean): void {
    this.agent(agentId);
    this.store.db.prepare('INSERT INTO channel_access VALUES(?,?,?) ON CONFLICT(agent_id,channel) DO UPDATE SET active=excluded.active').run(agentId, channel, Number(active));
  }
  watch(agentId: string, target: Target, active: boolean): void {
    targetSchema.parse(target); this.requireAccess(agentId, target.channel);
    if (active) this.store.db.prepare('INSERT INTO thread_watches VALUES(?,?,?) ON CONFLICT DO NOTHING').run(agentId, target.channel, target.thread);
    else this.store.db.prepare('DELETE FROM thread_watches WHERE agent_id=? AND channel=? AND thread=?').run(agentId, target.channel, target.thread);
  }
  normalize(appId: string, eventId: string): void {
    this.store.atomic(() => {
      const row = this.store.db.prepare('SELECT * FROM ingress WHERE app_id=? AND event_id=? AND normalized=0').get(appId, eventId) as { body: string } | undefined;
      if (!row) return;
      const installation = this.config.agents.find(a => a.slackAppId === appId);
      if (!installation) throw new Error('Unknown Slack installation');
      const body = JSON.parse(row.body) as Record<string, unknown>;
      if (body.team_id !== this.config.teamId) throw new Error('Wrong workspace');
      const event = rawMessage.safeParse(body.event);
      if (event.success) {
        const e = event.data;
        if ((e.type === 'member_left_channel' || e.type === 'member_joined_channel') && e.user === installation.slackUserId) {
          this.membership(installation.id, e.channel, e.type === 'member_joined_channel');
        }
        if (e.type === 'message' || e.type === 'app_mention') {
          const source = e.subtype === 'message_changed' ? e.message : e;
          const ts = e.subtype === 'message_deleted' ? e.deleted_ts : source?.ts;
          if (ts && source) {
            const revision = e.subtype === 'message_changed' ? (e.message?.edited?.ts ?? e.event_ts ?? ts)
              : e.subtype === 'message_deleted' ? (e.event_ts ?? ts) : ts;
            const msg: NormalMessage = { team: this.config.teamId, channel: e.channel, ts, thread: source.thread_ts ?? ts,
              revision, text: source.text ?? '', deleted: e.subtype === 'message_deleted',
              ...(source.user ? { user: source.user } : {}), ...(source.bot_id ? { bot: source.bot_id } : {}) };
            this.record(msg, [installation.id]);
          }
        }
      }
      this.store.db.prepare('UPDATE ingress SET normalized=1 WHERE app_id=? AND event_id=?').run(appId, eventId);
    });
  }
  record(message: NormalMessage, visibleTo: string[]): void {
    this.store.atomic(() => {
      slackTs.parse(message.ts); slackTs.parse(message.revision); slackTs.parse(message.thread);
      if (message.team !== this.config.teamId) throw new Error('Wrong workspace');
      const key = messageKey(message);
      const old = this.store.db.prepare('SELECT * FROM messages WHERE key=?').get(key) as MessageRow | undefined;
      if (!old || timestamp(message.revision) > timestamp(old.revision)) {
        this.store.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET thread=excluded.thread,revision=excluded.revision,body=excluded.body,deleted=excluded.deleted').run(key, message.channel, message.ts, message.thread, message.revision, encode(message), Number(message.deleted));
        this.store.db.prepare('INSERT INTO message_revisions VALUES(?,?,?) ON CONFLICT DO NOTHING').run(key, message.revision, encode(message));
      }
      const current = this.store.db.prepare('SELECT * FROM messages WHERE key=?').get(key) as MessageRow;
      const effective = JSON.parse(current.body) as NormalMessage;
      for (const id of visibleTo) {
        const agent = this.agent(id);
        if (!this.access(id, message.channel)) continue;
        this.store.db.prepare('INSERT INTO message_visibility VALUES(?,?) ON CONFLICT DO NOTHING').run(id, key);
        if (this.store.db.prepare('INSERT INTO message_observations VALUES(?,?,?) ON CONFLICT DO NOTHING').run(id, key, current.revision).changes === 0) continue;
        if (effective.user === agent.slackUserId || effective.bot === agent.slackBotId || current.deleted) continue;
        const sender = this.config.agents.find(a => a.slackUserId === effective.user || a.slackBotId === effective.bot);
        const mention = effective.text.includes(`<@${agent.slackUserId}>`);
        const watched = !!this.store.db.prepare('SELECT 1 FROM thread_watches WHERE agent_id=? AND channel=? AND thread=?').get(id, effective.channel, effective.thread);
        const direct = effective.channel.startsWith('D') || mention;
        const participating = agent.channels[effective.channel] === 'participate';
        if (!(direct || watched || participating)) continue;
        const now = Date.now(), isNotice = !direct && !watched, bucket = Math.floor(now / 20000);
        const work = this.store.db.prepare('SELECT work_id FROM message_work WHERE message_key=?').get(key) as { work_id: string } | undefined;
        const delivery = this.store.enqueue(id, isNotice ? `notice:${effective.channel}:${work?.work_id ?? 'unbound'}:${bucket}` : `message:${key}:${current.revision}`, { kind: isNotice ? 'notice' : 'message',
          messageKey: key, revision: current.revision, source: sender ? { kind: 'agent', id: sender.id } : { kind: effective.bot ? 'external_bot' : 'human', id: effective.user ?? effective.bot },
          target: { channel: effective.channel, thread: effective.thread }, receivedAt: now,
          ...(isNotice ? { notBefore: (bucket + 1) * 20000, channel: effective.channel, windowStart: bucket * 20000 } : {}) }, direct ? (sender ? 50 : 100) : watched ? 20 : 0);
        if (work) this.store.db.prepare('INSERT INTO delivery_work VALUES(?,?) ON CONFLICT DO NOTHING').run(delivery, work.work_id);
      }
    });
  }
  read(agentId: string, target: Target): NormalMessage[] {
    targetSchema.parse(target); this.requireAccess(agentId, target.channel);
    const rows = this.store.db.prepare('SELECT m.body FROM messages m JOIN message_visibility v ON v.key=m.key WHERE v.agent_id=? AND m.channel=? AND m.thread=? AND m.deleted=0 ORDER BY length(m.ts),m.ts').all(agentId, target.channel, target.thread) as { body: string }[];
    return rows.map(r => JSON.parse(r.body) as NormalMessage);
  }
  search(agentId: string, query: string): NormalMessage[] {
    this.agent(agentId); if (!query || query.length > 1000) throw new Error('Invalid search');
    const rows = this.store.db.prepare('SELECT m.body FROM messages m JOIN message_visibility v ON v.key=m.key JOIN channel_access a ON a.agent_id=v.agent_id AND a.channel=m.channel WHERE v.agent_id=? AND a.active=1 AND m.deleted=0 AND instr(m.body,?)>0 LIMIT 100').all(agentId, query) as { body: string }[];
    return rows.map(r => JSON.parse(r.body) as NormalMessage);
  }
  recent(agentId: string, channel: string): NormalMessage[] {
    this.requireAccess(agentId, channel);
    const rows = this.store.db.prepare('SELECT m.body FROM messages m JOIN message_visibility v ON v.key=m.key WHERE v.agent_id=? AND m.channel=? AND m.deleted=0 ORDER BY length(m.ts) DESC,m.ts DESC LIMIT 100').all(agentId, channel) as { body: string }[];
    return rows.reverse().map(r => JSON.parse(r.body) as NormalMessage);
  }
}

export interface SlackTransport { post(agentId: string, target: Target, text: string, id: string): Promise<{ ts: string }> }
export class Output {
  constructor(private messages: Messages, private transport: SlackTransport, private clock: () => number = Date.now) {}
  queue(agentId: string, target: Target, text: string, id: string = randomUUID()): string {
    targetSchema.parse(target); this.messages.requireAccess(agentId, target.channel);
    z.string().min(1).max(35000).parse(text);
    this.messages.store.queueOutput(agentId, id, { target, text }); return id;
  }
  /** Evidence must come from a fresh Slack history response using the sender's credential. */
  reconcile(id: string, evidence: { ts: string; user: string; channel: string; thread: string; text: string; outboxId: string; requestHash: string }): void {
    const row = this.messages.store.output(id);
    if (!row || row.state !== 'unknown') throw new Error('Output does not require reconciliation');
    const { target, text } = JSON.parse(row.request) as { target: Target; text: string };
    if (evidence.outboxId !== id || evidence.requestHash !== row.request_hash || evidence.user !== this.messages.agent(row.agent_id).slackUserId || evidence.channel !== target.channel || evidence.thread !== target.thread) throw new Error('Receipt evidence mismatch');
    slackTs.parse(evidence.ts);
    this.confirm(id, row.agent_id, target, evidence.text, { ts: evidence.ts }, 'unknown');
  }
  private confirm(id: string, agentId: string, target: Target, text: string, receipt: { ts: string }, from: 'sending' | 'unknown'): void {
    this.messages.store.atomic(() => {
      this.messages.store.transitionOutput(id, from, 'sent', receipt);
      const agent = this.messages.agent(agentId);
      const message: NormalMessage = { team: this.messages.config.teamId, channel: target.channel, thread: target.thread,
        ts: receipt.ts, revision: receipt.ts, text, user: agent.slackUserId, bot: agent.slackBotId, deleted: false };
      this.messages.record(message, []);
      const binding = this.messages.store.db.prepare('SELECT work_id FROM output_work WHERE output_id=?').get(id) as { work_id: string } | undefined;
      if (binding) {
        const key = messageKey(message);
        this.messages.store.db.prepare('INSERT INTO message_work VALUES(?,?) ON CONFLICT DO NOTHING').run(key, binding.work_id);
        this.messages.store.db.prepare("INSERT INTO delivery_work SELECT d.id,? FROM deliveries d WHERE json_extract(d.payload,'$.messageKey')=? ON CONFLICT DO NOTHING").run(binding.work_id, key);
      }
      this.messages.record(message, this.messages.config.agents.filter(a => this.messages.access(a.id, target.channel)).map(a => a.id));
    });
  }
  ready(limit = 20): { id: string }[] {
    return this.messages.store.db.prepare("SELECT o.id FROM outbox o LEFT JOIN output_work ow ON ow.output_id=o.id LEFT JOIN works w ON w.id=ow.work_id WHERE o.state='pending' AND (w.state IS NULL OR w.state!='paused') AND COALESCE(json_extract(o.receipt,'$.retryAt'),0)<=? ORDER BY o.rowid LIMIT ?").all(this.clock(), limit) as { id: string }[];
  }
  async send(id: string): Promise<void> {
    const now = this.clock();
    const store = this.messages.store, row = store.output(id);
    if (!row || row.state !== 'pending') return;
    const work = store.db.prepare('SELECT w.state FROM works w JOIN output_work ow ON ow.work_id=w.id WHERE ow.output_id=?').get(id) as { state: string } | undefined;
    if (work && work.state !== 'active') {
      if (work.state === 'cancelled') store.transitionOutput(id, 'pending', 'failed', { reason: 'work_cancelled' });
      return;
    }
    if (row.receipt && (JSON.parse(row.receipt) as { retryAt?: number }).retryAt! > now) return;
    const { target, text } = JSON.parse(row.request) as { target: Target; text: string };
    try { this.messages.requireAccess(row.agent_id, target.channel); }
    catch { store.transitionOutput(id, 'pending', 'failed', { reason: 'access_revoked' }); return; }
    store.transitionOutput(id, 'pending', 'sending');
    let receipt: { ts: string };
    try { receipt = await this.transport.post(row.agent_id, target, text, id); slackTs.parse(receipt.ts); }
    catch (error) {
      const e = error as { code?: string; retryAfter?: number; data?: { error?: string } };
      if (e.code === 'slack_webapi_rate_limited_error' && Number.isFinite(e.retryAfter)) {
        store.transitionOutput(id, 'sending', 'pending', { retryAt: this.clock() + Math.max(1, e.retryAfter!) * 1000 });
      } else if (e.code === 'slack_webapi_platform_error' && ['not_authed', 'invalid_auth', 'token_revoked', 'account_inactive', 'channel_not_found', 'not_in_channel', 'is_archived', 'msg_too_long', 'no_text', 'restricted_action', 'cannot_reply_to_message'].includes(e.data?.error ?? '')) store.transitionOutput(id, 'sending', 'failed', { reason: e.data!.error });
      else store.transitionOutput(id, 'sending', 'unknown', { reason: 'request_outcome_unknown' });
      return;
    }
    // Receipt and replayable internal event commit together. If this fails,
    // sending becomes unknown at restart; never resend an unrecorded success.
    this.confirm(id, row.agent_id, target, text, receipt, 'sending');
  }
}
