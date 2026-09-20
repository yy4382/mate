import type { WebClient } from '@slack/web-api';
import type { Collaboration } from '../collaboration/service.js';
import type { Controls } from './control.js';
import type { Ingress } from './ingress.js';
import type { WebSlackTransport } from '../slack/transport.js';
import type { Target } from '../slack/messages.js';
import { encode } from '../storage/store.js';
export class SlackService {
  private reconcileAfter = 0;
  constructor(readonly c: Collaboration, readonly transport: WebSlackTransport, readonly ingress: Ingress, readonly controls: Controls, readonly stopping: () => boolean = () => false) {}
  async verify(): Promise<void> {
    for (const agent of this.c.config.agents) {
      if (this.stopping()) return;
      const client = this.transport.clients.get(agent.id)!;
      const auth = await client.auth.test();
      if (auth.team_id !== this.c.config.teamId || auth.user_id !== agent.slackUserId || auth.bot_id !== agent.slackBotId) throw new Error(`Slack installation mismatch: ${agent.id}`);
      const bot = await client.bots.info({ bot: agent.slackBotId });
      if (bot.bot?.app_id !== agent.slackAppId) throw new Error(`Slack app mismatch: ${agent.id}`);
    }
  }
  async membership(): Promise<void> {
    for (const agent of this.c.config.agents) {
      if (this.stopping()) return;
      const client = this.transport.clients.get(agent.id)!;
      const stored = this.c.store.db.prepare('SELECT channel FROM channel_access WHERE agent_id=?').all(agent.id) as { channel: string }[];
      for (const channel of new Set([...Object.keys(agent.channels), ...stored.map(r => r.channel)])) {
        if (this.stopping()) return;
        // Failure closes permission until a successful membership check.
        this.c.messages.membership(agent.id, channel, false);
        try { const info = await client.conversations.info({ channel }); this.c.messages.membership(agent.id, channel, info.channel?.is_member === true || (channel.startsWith('D') && info.channel?.is_im === true)); }
        catch { this.c.store.audit('membership_unavailable', { agentId: agent.id, channel }); }
      }
    }
  }
  async catchUp(): Promise<void> {
    for (const agent of this.c.config.agents) {
      if (this.stopping()) return;
      const client = this.transport.clients.get(agent.id)!;
      const channels = this.c.store.db.prepare('SELECT channel FROM channel_access WHERE agent_id=? AND active=1').all(agent.id) as { channel: string }[];
      for (const { channel } of channels) {
        if (this.stopping()) return;
        const checkpoint = this.c.store.db.prepare('SELECT ts FROM slack_cursors WHERE agent_id=? AND channel=?').get(agent.id, channel) as { ts: string } | undefined;
        const oldest = checkpoint?.ts ?? `${Math.floor(Date.now()/1000) - 86400}.000000`;
        try {
          let cursor: string | undefined, pages = 0, newest = oldest;
          do {
            if (this.stopping()) return;
            const result = await client.conversations.history({ channel, oldest, limit: 100, include_all_metadata: true, ...(cursor ? { cursor } : {}) });
            for (const msg of result.messages ?? []) if (msg.ts) {
              this.c.store.ingest(agent.slackAppId, `history:${channel}:${msg.ts}:${msg.edited?.ts ?? msg.ts}`, { team_id: this.c.config.teamId, event: { ...msg, type: 'message', channel } });
              if (Number(msg.ts) > Number(newest)) newest = msg.ts;
            }
            cursor = result.response_metadata?.next_cursor || undefined; pages++;
          } while (cursor && pages < 10);
          if (cursor) this.c.store.audit('history_gap', { agentId: agent.id, channel, oldest, reason: 'page_cap; cursor not advanced' });
          else this.c.store.db.prepare('INSERT INTO slack_cursors VALUES(?,?,?) ON CONFLICT(agent_id,channel) DO UPDATE SET ts=excluded.ts').run(agent.id, channel, newest);
        } catch { this.c.store.audit('history_gap', { agentId: agent.id, channel, oldest, reason: 'Slack history unavailable; cursor retained' }); }
      }
    }
    await this.catchUpThreads();
  }
  async catchUpThreads(): Promise<void> {
    const s = this.c.store;
    const watches = s.db.prepare('SELECT t.* FROM thread_watches t JOIN channel_access a ON a.agent_id=t.agent_id AND a.channel=t.channel WHERE a.active=1').all() as { agent_id: string; channel: string; thread: string }[];
    for (const watch of watches) {
      if (this.stopping()) return;
      const agent = this.c.messages.agent(watch.agent_id), client = this.transport.clients.get(agent.id)!;
      const cursorKey = `${watch.channel}:${watch.thread}`;
      const checkpoint = s.db.prepare('SELECT ts FROM slack_cursors WHERE agent_id=? AND channel=?').get(agent.id, cursorKey) as { ts: string } | undefined;
      const oldest = checkpoint?.ts ?? watch.thread;
      try {
        let cursor: string | undefined, pages = 0, newest = oldest;
        do {
          if (this.stopping()) return;
          const result = await client.conversations.replies({ channel: watch.channel, ts: watch.thread, oldest, limit: 100, include_all_metadata: true, ...(cursor ? { cursor } : {}) });
          for (const msg of result.messages ?? []) if (msg.ts) {
            s.ingest(agent.slackAppId, `thread-history:${watch.channel}:${msg.ts}:${msg.edited?.ts ?? msg.ts}`, { team_id: this.c.config.teamId, event: { ...msg, type: 'message', channel: watch.channel, thread_ts: msg.thread_ts ?? watch.thread } });
            if (Number(msg.ts) > Number(newest)) newest = msg.ts;
          }
          cursor = result.response_metadata?.next_cursor || undefined; pages++;
        } while (cursor && pages < 10);
        if (cursor) s.audit('history_gap', { ...watch, reason: 'thread_page_cap' });
        else s.db.prepare('INSERT INTO slack_cursors VALUES(?,?,?) ON CONFLICT(agent_id,channel) DO UPDATE SET ts=excluded.ts').run(agent.id, cursorKey, newest);
      } catch { s.audit('history_gap', { ...watch, reason: 'thread_history_unavailable' }); }
    }
  }
  replay(): void {
    const s = this.c.store;
    const rows = s.db.prepare('SELECT app_id,event_id,body FROM ingress WHERE normalized=0 ORDER BY rowid LIMIT 100').all() as { app_id: string; event_id: string; body: string }[];
    for (const row of rows) {
      const body = JSON.parse(row.body), agent = this.c.config.agents.find(a => a.slackAppId === row.app_id);
      if (!agent) continue;
      try {
        if (body.command === '/team') {
          s.atomic(() => {
            const team = body.team_id ?? body.team?.id, user = body.user_id ?? body.user?.id, channel = body.channel_id ?? body.channel?.id;
            if (team !== this.c.config.teamId || !/^U[A-Z0-9]+$/.test(user ?? '') || !/^[CDG][A-Z0-9]+$/.test(channel ?? '')) throw new Error('Invalid control identity');
            let text = body.text ?? '';
            let reply: string;
            try { reply = this.controls.execute(user, text); } catch (error) { reply = String(error); }
            s.db.prepare('INSERT INTO admin_replies VALUES(?,?,?,?,?,\'pending\') ON CONFLICT DO NOTHING').run(`${row.app_id}:${row.event_id}`, agent.id, channel, user, reply.slice(0, 15000));
            s.db.prepare('UPDATE ingress SET normalized=1 WHERE app_id=? AND event_id=?').run(row.app_id, row.event_id);
          });
        } else this.ingress.replay(row.app_id, row.event_id);
      } catch (error) { s.atomic(() => { s.audit('ingress_rejected', { appId: row.app_id, eventId: row.event_id, error: String(error) }); s.db.prepare('UPDATE ingress SET normalized=1 WHERE app_id=? AND event_id=?').run(row.app_id, row.event_id); }); }
    }
    this.ingress.bindPeerEchoes();
  }
  async flushAdmin(): Promise<void> {
    const s = this.c.store;
    for (const row of s.db.prepare("SELECT * FROM admin_replies WHERE state='pending' LIMIT 10").all() as { id: string; agent_id: string; channel: string; user_id: string; text: string }[]) {
      s.db.prepare("UPDATE admin_replies SET state='unknown' WHERE id=? AND state='pending'").run(row.id);
      try { await this.transport.clients.get(row.agent_id)!.chat.postEphemeral({ channel: row.channel, user: row.user_id, text: row.text }); s.db.prepare("UPDATE admin_replies SET state='sent' WHERE id=?").run(row.id); }
      catch { s.audit('admin_reply_unknown', { id: row.id }); }
    }
  }
  async reconcile(): Promise<void> {
    const s = this.c.store;
    const rows = s.db.prepare("SELECT rowid seq,id,agent_id,request FROM outbox WHERE state='unknown' AND rowid>? ORDER BY rowid LIMIT 20").all(this.reconcileAfter) as { seq: number; id: string; agent_id: string; request: string }[];
    this.reconcileAfter = rows.at(-1)?.seq ?? 0;
    for (const row of rows) {
      const { target,artifact } = JSON.parse(row.request) as { target: Target;artifact?:unknown };
      if (!this.c.messages.access(row.agent_id, target.channel)) continue;
      try {
        const client = this.transport.clients.get(row.agent_id)!;
        if(artifact){
          const receipt=JSON.parse(s.output(row.id)!.receipt??'{}');if(!receipt.fileId)continue;
          const result=await client.files.info({file:receipt.fileId});const file=result.file;
          if(!file||!file.id||file.id!==receipt.fileId||!file.user)continue;
          for(const scope of [file.shares?.public,file.shares?.private])for(const share of scope?.[target.channel]??[]){
            if(share.ts&&(target.thread??share.ts)===(share.thread_ts??share.ts)){this.c.output.reconcileArtifact(row.id,file.id,{channel:target.channel,ts:share.ts,user:file.user,...(share.thread_ts?{thread:share.thread_ts}:{})});break;}
          }
          continue;
        }
        let cursor: string | undefined, pages = 0;
        do {
          const options = { channel: target.channel, limit: 100, include_all_metadata: true, ...(cursor ? { cursor } : {}) };
          const result = target.thread ? await client.conversations.replies({ ...options, ts: target.thread }) : await client.conversations.history(options);
          for (const msg of result.messages ?? []) {
            const metadata = msg.metadata as { event_type?: string; event_payload?: { id?: string; request_hash?: string } } | undefined;
            if (msg.ts && msg.user && metadata?.event_type === 'mate_outbox' && metadata.event_payload?.id === row.id && metadata.event_payload.request_hash) {
              this.c.output.reconcile(row.id, { ts: msg.ts, user: msg.user, channel: target.channel, thread: msg.thread_ts ?? msg.ts, text: msg.text ?? '', outboxId: row.id, requestHash: metadata.event_payload.request_hash });
              break;
            }
          }
          cursor = result.response_metadata?.next_cursor || undefined; pages++;
        } while (cursor && pages < 5 && s.output(row.id)?.state === 'unknown');
      } catch { /* keep unknown; never resend blindly */ }
    }
  }
  async upload(agentId:string,target:Target,text:string,artifact:import('../slack/messages.js').ArtifactPayload,prepared:(fileId:string)=>void,beforeShare:()=>boolean):Promise<{fileId:string}>{
    const client=this.transport.clients.get(agentId)!;
    const filename=`${artifact.title.replace(/[^a-zA-Z0-9._-]/g,'_')}.txt`,bytes=Buffer.from(artifact.content);
    const allocated=await client.files.getUploadURLExternal({filename,length:bytes.length});
    if(!allocated.file_id||!allocated.upload_url)throw new Error('Missing upload allocation');
    prepared(allocated.file_id);
    const url=new URL(allocated.upload_url);if(url.protocol!=='https:'||url.hostname!=='files.slack.com'||url.port||url.username||url.password)throw new Error('Unexpected Slack upload host');
    const response=await fetch(url,{method:'POST',body:bytes,redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('Slack byte upload failed');await response.body?.cancel();
    if(this.stopping()||!beforeShare())throw new Error('Publication deferred before sharing');
    const result=await client.files.completeUploadExternal({files:[{id:allocated.file_id,title:artifact.title}],channel_id:target.channel,...(target.thread?{thread_ts:target.thread}:{}),initial_comment:text});
    if(!result.ok)throw new Error('Missing publication receipt');return{fileId:allocated.file_id};
  }
}
