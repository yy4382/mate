import { rawMessage } from '../../../../../src/slack/protocol.js';
import { messageKey, type Messages, type NormalMessage } from '../conversations/messages.js';

/** Authenticated Slack ingress adapter. Core services never parse platform envelopes. */
export class SlackMessageNormalizer {
  constructor(private readonly messages: Messages) {}
  normalize(appId: string, eventId: string): void {
    this.messages.store.atomic(() => {
      const row = this.messages.store.db.prepare('SELECT * FROM ingress WHERE app_id=? AND event_id=? AND normalized=0').get(appId, eventId) as { body: string } | undefined;
      if (!row) return;
      const installation = this.messages.config.agents.find(a => a.slackAppId === appId);
      if (!installation) throw new Error('Unknown Slack installation');
      const body = JSON.parse(row.body) as Record<string, unknown>;
      if (body.team_id !== this.messages.config.teamId) throw new Error('Wrong workspace');
      const event = rawMessage.safeParse(body.event);
      if (event.success) {
        const e = event.data;
        if ((e.type === 'member_left_channel' || e.type === 'member_joined_channel') && e.user === installation.slackUserId) {
          this.messages.membership(installation.id, e.channel, e.type === 'member_joined_channel');
        }
        if (e.type === 'message' || e.type === 'app_mention') {
          const source = e.subtype === 'message_changed' ? e.message : e;
          const ts = e.subtype === 'message_deleted' ? e.deleted_ts : source?.ts;
          if (ts && source) {
            const revision = e.subtype === 'message_changed' ? (e.message?.edited?.ts ?? e.event_ts ?? ts)
              : e.subtype === 'message_deleted' ? (e.event_ts ?? ts) : ts;
            const previous = this.messages.store.db.prepare('SELECT thread FROM messages WHERE key=?').get(messageKey({team: this.messages.config.teamId, channel: e.channel, ts})) as { thread: string } | undefined;
            const msg: NormalMessage = { team: this.messages.config.teamId, channel: e.channel, ts, thread: source.thread_ts ?? e.previous_message?.thread_ts ?? previous?.thread ?? ts,
              revision,...(source.files?{files:source.files}:{}), text: source.text ?? '', deleted: e.subtype === 'message_deleted',
              ...(source.user ? { user: source.user } : {}), ...(source.bot_id ? { bot: source.bot_id } : {}) };
            const metadata=source.metadata;
            if(metadata?.event_type==='mate_outbox'&&typeof metadata.event_payload?.id==='string'){
              const output=this.messages.store.output(metadata.event_payload.id);
              if(output&&output.request_hash===metadata.event_payload.request_hash&&source.user===this.messages.agent(output.agent_id).slackUserId&&source.text===JSON.parse(output.request).text&&this.messages.store.db.prepare('SELECT 1 FROM system_projections WHERE output_id=?').get(output.id)){const target=JSON.parse(output.request).target;if(target.channel===msg.channel&&(target.thread??msg.ts)===msg.thread)msg.systemGenerated=true;}
            }
            this.messages.record(msg, [installation.id]);
          }
        }
      }
      this.messages.store.db.prepare('UPDATE ingress SET normalized=1 WHERE app_id=? AND event_id=?').run(appId, eventId);
    });
  }
}
