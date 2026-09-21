import type { ConversationRecords } from '../storage/conversations.js';
import type { ConversationWrites } from '../storage/conversation-writes.js';
// E1 compatibility model: platform-shaped payloads are migrated in E2.
import { z } from 'zod';
import { Store, encode } from '../storage/store.js';
import type { AgentConfig, MateConfig } from '../config.js';

export const slackTs = z.string().regex(/^\d{1,16}\.\d{1,6}$/);
export const targetSchema = z.object({ channel: z.string().regex(/^[CDG][A-Z0-9]+$/), thread: slackTs.optional() }).strict();
export type Target = z.infer<typeof targetSchema>;
export interface NormalMessage { team: string; channel: string; ts: string; thread: string; revision: string; text: string; user?: string; bot?: string; deleted: boolean;systemGenerated?:boolean;files?: {id:string;name?:string|undefined;title?:string|undefined;mimetype?:string|undefined;size?:number|undefined}[] }
interface MessageRow { key: string; channel: string; ts: string; thread: string; revision: string; body: string; deleted: number }
function timestamp(value: string): bigint { const [a, b] = value.split('.'); return BigInt(a!) * 1000000n + BigInt(b!.padEnd(6, '0')); }
export function messageKey(message: Pick<NormalMessage, 'team' | 'channel' | 'ts'>): string { return encode([message.team, message.channel, message.ts]); }

export class Messages {
  private readonly membershipVersions = new Map<string, number>();
  membershipVersion(actor: string): number { return this.membershipVersions.get(actor) ?? 0; }
  constructor(readonly store: Store, readonly config: MateConfig, readonly persistence: { records: ConversationRecords; writes: ConversationWrites }) {}
  agent(id: string): AgentConfig { const a = this.config.agents.find(a => a.id === id); if (!a) throw new Error('Unknown Agent'); return a; }
  access(agentId: string, channel: string): boolean {
    return !!this.store.db.prepare('SELECT 1 FROM channel_access WHERE agent_id=? AND channel=? AND active=1').get(agentId, channel);
  }
  isolated(actor:string):boolean{return !!this.store.db.prepare('SELECT 1 FROM review_seats WHERE agent_id=? AND active=1').get(actor);}
  requireReadable(actor:string):void{if(this.isolated(actor))throw new Error('Independent review seat isolates conversation inputs');}
  requireAccess(agentId: string, channel: string): void { this.agent(agentId); if (!this.access(agentId, channel)) throw new Error('Channel access denied'); }
  /** Only trusted Slack membership reconciliation or authenticated member events call this. */
  membership(agentId: string, channel: string, active: boolean): void {
    this.agent(agentId);
    this.membershipVersions.set(agentId, this.membershipVersion(agentId) + 1);
    this.store.atomic(() => {
      this.persistence.writes.target('membership', encode([agentId, channel]), { channel });
      this.store.db.prepare('INSERT INTO channel_access VALUES(?,?,?) ON CONFLICT(agent_id,channel) DO UPDATE SET active=excluded.active').run(agentId, channel, Number(active));
    });
  }
  watch(agentId: string, target: Target, active: boolean): void {
    targetSchema.parse(target); this.requireAccess(agentId, target.channel);
    this.store.atomic(() => {
    if (!target.thread) {
      if(active)this.store.db.prepare('INSERT INTO channel_watches VALUES(?,?) ON CONFLICT DO NOTHING').run(agentId,target.channel);
      else this.store.db.prepare('DELETE FROM channel_watches WHERE agent_id=? AND channel=?').run(agentId,target.channel);
      return;
    }
    if (active) this.store.db.prepare('INSERT INTO thread_watches VALUES(?,?,?) ON CONFLICT DO NOTHING').run(agentId, target.channel, target.thread);
    else this.store.db.prepare('DELETE FROM thread_watches WHERE agent_id=? AND channel=? AND thread=?').run(agentId, target.channel, target.thread);
    const id = encode([agentId,target.channel,target.thread]);
    if(active)this.persistence.writes.target('thread_watch',id,target);
    else this.store.db.prepare("DELETE FROM canonical_targets WHERE object_type='thread_watch' AND object_id=?").run(id);
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
        this.store.db.prepare('INSERT INTO conversation_events(channel,thread,message_key,revision,kind) VALUES(?,?,?,?,?)').run(message.channel, message.thread, key, message.revision, message.deleted ? 'delete' : old ? 'edit' : 'message');
      }
      // Older caches discarded file metadata. Enrich an equal-revision live message without inventing a Slack edit timestamp.
      if(old&&!old.deleted&&timestamp(message.revision)===timestamp(old.revision)&&message.files?.length&&!(JSON.parse(old.body) as NormalMessage).files){
        this.store.db.prepare('UPDATE messages SET body=? WHERE key=?').run(encode({...JSON.parse(old.body),files:message.files}),key);
        this.store.db.prepare('DELETE FROM attention_seen WHERE key=?').run(key);
        this.store.db.prepare('INSERT INTO conversation_events(channel,thread,message_key,revision,kind) VALUES(?,?,?,?,?)').run(old.channel,old.thread,key,old.revision,'files_enriched');
      }
      // A tombstone can arrive before the original reply, without thread metadata.
      // Enrich its immutable location without resurrecting text or decreasing revision.
      if (old?.deleted && old.thread === old.ts && message.thread !== message.ts && timestamp(message.revision) <= timestamp(old.revision)) {
        const tombstone = { ...JSON.parse(old.body), thread: message.thread };
        this.store.db.prepare('UPDATE messages SET thread=?,body=? WHERE key=?').run(message.thread, encode(tombstone), key);
        this.store.db.prepare('INSERT INTO conversation_events(channel,thread,message_key,revision,kind) VALUES(?,?,?,?,?)').run(message.channel, message.thread, key, old.revision, 'delete');
      }
      const current = this.store.db.prepare('SELECT * FROM messages WHERE key=?').get(key) as MessageRow;
      this.persistence.writes.message(current.body);
      const effective = JSON.parse(current.body) as NormalMessage;
      for (const id of visibleTo) {
        const agent = this.agent(id);
        if (!this.access(id, message.channel)) continue;
        const addedVisibility=this.store.db.prepare('INSERT INTO message_visibility VALUES(?,?) ON CONFLICT DO NOTHING').run(id, key).changes;
        if(effective.files?.length===1){
          const published=this.store.db.prepare("SELECT o.agent_id,o.request FROM outbox o JOIN canonical_targets ct ON ct.object_type='outbox' AND ct.object_id=o.id JOIN attention_seen seen ON seen.agent_id=? AND seen.key='artifact:'||json_extract(o.receipt,'$.fileId') WHERE o.state='sent' AND json_extract(o.receipt,'$.fileId')=? AND ct.conversation_id=?").get(id,effective.files[0]!.id,message.channel) as {agent_id:string;request:string}|undefined;
          if(published){const request=JSON.parse(published.request),author=this.agent(published.agent_id);if(effective.user===author.slackUserId&&effective.text===request.text&&(request.target.thread??effective.ts)===effective.thread)this.store.db.prepare('INSERT INTO attention_seen VALUES(?,?,?) ON CONFLICT(agent_id,key) DO UPDATE SET revision=excluded.revision').run(id,key,current.revision);}
        }
        if(old && addedVisibility)this.store.db.prepare('INSERT INTO conversation_events(channel,thread,message_key,revision,kind,audience) VALUES(?,?,?,?,?,?)').run(current.channel,current.thread,key,current.revision,'visibility',id);
        if (this.store.db.prepare('INSERT INTO message_observations VALUES(?,?,?) ON CONFLICT DO NOTHING').run(id, key, current.revision).changes === 0) continue;
        if(effective.systemGenerated)continue;
        if (effective.user === agent.slackUserId || effective.bot === agent.slackBotId || current.deleted) continue;
        const sender = this.config.agents.find(a => a.slackUserId === effective.user || a.slackBotId === effective.bot);
        const mention = effective.text.includes(`<@${agent.slackUserId}>`);
        const watched = !!this.store.db.prepare('SELECT 1 FROM channel_watches WHERE agent_id=? AND channel=?').get(id,effective.channel) || !!this.store.db.prepare('SELECT 1 FROM thread_watches WHERE agent_id=? AND channel=? AND thread=?').get(id, effective.channel, effective.thread);
        const direct = effective.channel.startsWith('D') || mention;
        const participating = agent.channels[effective.channel] === 'participate';
        if (!(direct || watched || participating)) continue;
        const quiet=this.store.db.prepare('SELECT 1 FROM attention_state WHERE agent_id=? AND target IN (?,?) AND (muted=1 OR deferred_until>?)').get(id,encode({channel:effective.channel}),encode({channel:effective.channel,thread:effective.thread}),Date.now());
        if(quiet)continue;
        const now = Date.now(), isNotice = !direct && !watched, bucket = Math.floor(now / 20000);
        const work = this.store.db.prepare('SELECT work_id FROM message_work WHERE message_key=?').get(key) as { work_id: string } | undefined;
        const delivery = this.persistence.writes.enqueue(id, isNotice ? `notice:${effective.channel}:${work?.work_id ?? 'unbound'}:${bucket}` : `message:${key}:${current.revision}`, { kind: isNotice ? 'notice' : 'message',
          messageKey: key, revision: current.revision, source: sender ? { kind: 'agent', id: sender.id } : { kind: effective.bot ? 'external_bot' : 'human', id: effective.user ?? effective.bot },
          target: { channel: effective.channel, thread: effective.thread }, receivedAt: now,
          ...(isNotice ? { notBefore: (bucket + 1) * 20000, channel: effective.channel, windowStart: bucket * 20000 } : {}) }, direct ? (sender ? 50 : 100) : watched ? 20 : 0);
        if (work) this.store.db.prepare('INSERT INTO delivery_work VALUES(?,?) ON CONFLICT DO NOTHING').run(delivery, work.work_id);
      }
    });
  }
  read(agentId: string, target: Target): NormalMessage[] {
    this.requireReadable(agentId);
    targetSchema.parse(target); this.requireAccess(agentId, target.channel);
    const rows = this.store.db.prepare('SELECT m.body FROM messages m JOIN message_visibility v ON v.key=m.key WHERE v.agent_id=? AND m.channel=? AND (? IS NULL OR m.thread=?) AND m.deleted=0 ORDER BY length(m.ts),m.ts').all(agentId, target.channel, target.thread ?? null, target.thread ?? null) as { body: string }[];
    return rows.map(r => JSON.parse(r.body) as NormalMessage);
  }
  search(agentId: string, query: string): NormalMessage[] {
    this.requireReadable(agentId);
    this.agent(agentId); if (!query || query.length > 1000) throw new Error('Invalid search');
    const rows = this.store.db.prepare('SELECT m.body FROM messages m JOIN message_visibility v ON v.key=m.key JOIN channel_access a ON a.agent_id=v.agent_id AND a.channel=m.channel WHERE v.agent_id=? AND a.active=1 AND m.deleted=0 AND instr(m.body,?)>0 LIMIT 100').all(agentId, query) as { body: string }[];
    return rows.map(r => JSON.parse(r.body) as NormalMessage);
  }
  recent(agentId: string, channel: string): NormalMessage[] {
    this.requireReadable(agentId);
    this.requireAccess(agentId, channel);
    const rows = this.store.db.prepare('SELECT m.body FROM messages m JOIN message_visibility v ON v.key=m.key WHERE v.agent_id=? AND m.channel=? AND m.deleted=0 ORDER BY length(m.ts) DESC,m.ts DESC LIMIT 100').all(agentId, channel) as { body: string }[];
    return rows.reverse().map(r => JSON.parse(r.body) as NormalMessage);
  }
}
