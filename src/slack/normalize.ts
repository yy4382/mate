import type { Conversations } from '../conversations/messages.js';
import type { CanonicalOutput } from '../conversations/output.js';
import type { SlackMapper } from './mapper.js';
import { rawMessage } from './protocol.js';

/** Authenticated ingress -> canonical facts. Unmatched metadata remains ordinary input. */
export class CanonicalSlackNormalizer {
  constructor(readonly messages:Conversations,readonly mapper:SlackMapper,readonly output:CanonicalOutput,readonly projections?:{handle(event:unknown):boolean}){}
  normalize(appId:string,eventId:string):void {
    const s=this.messages.store;s.atomic(()=>{
      const row=s.db.prepare('SELECT body FROM ingress WHERE app_id=? AND event_id=? AND normalized=0').get(appId,eventId) as {body:string}|undefined;
      if(!row)return;
      const installation=this.mapper.config.agents.find(a=>a.slackAppId===appId);if(!installation)throw new Error('Unknown Slack installation');
      const body=JSON.parse(row.body);if(body.team_id!==this.mapper.config.teamId)throw new Error('Wrong workspace');
      const parsed=rawMessage.safeParse(body.event);
      if(parsed.success){
        const event=parsed.data;
        if(this.projections?.handle(event)){s.db.prepare('UPDATE ingress SET normalized=1 WHERE app_id=? AND event_id=?').run(appId,eventId);return;}
        if((event.type==='member_left_channel'||event.type==='member_joined_channel')&&event.user===installation.slackUserId)this.messages.membership(installation.id,this.mapper.conversation(event.channel),event.type==='member_joined_channel');
        if(event.type==='message'||event.type==='app_mention'){
          if(/^D[A-Z0-9]+$/.test(event.channel))this.messages.membership(installation.id,this.mapper.conversation(event.channel),true);
          const source=event.subtype==='message_changed'?event.message:event;
          const ts=event.subtype==='message_deleted'?event.deleted_ts:source?.ts;
          if(source&&ts){
            const revision=event.subtype==='message_changed'?(event.message?.edited?.ts??event.event_ts??ts):event.subtype==='message_deleted'?(event.event_ts??ts):(source.edited?.ts??ts);
            let message=this.mapper.message({channel:event.channel,ts,thread:source.thread_ts??event.previous_message?.thread_ts,revision,text:source.text??'',deleted:event.subtype==='message_deleted',user:source.user,bot:source.bot_id,files:source.files});
            const metadata=source.metadata;
            if(metadata?.event_type==='mate_outbox'&&typeof metadata.event_payload?.id==='string'){
              const out=s.output(metadata.event_payload.id);
              if(out&&['sending','unknown'].includes(out.state)&&out.request_hash===metadata.event_payload.request_hash&&message.author.kind==='agent'&&message.author.id===out.agent_id&&!JSON.parse(out.request).artifact){
                const expected=this.messages.records.targetedEffect('outbox',out.id).target;
                if(message.conversationId===expected.conversationId&&message.rootId===(expected.threadId??message.id)&&this.output.matchesText(JSON.parse(out.request).text,message.text)&&!message.deleted)this.output.confirm(out.id,out.request_hash,{message,receipt:{ts}});
              }
            }
            // Projection provenance is separate from dispatch confirmation. Even an early
            // authenticated echo must not turn a fixed system receipt into peer work.
            if(metadata?.event_type==='mate_outbox'&&typeof metadata.event_payload?.id==='string'){
              const out=s.output(metadata.event_payload.id);
              if(out&&out.request_hash===metadata.event_payload.request_hash&&message.author.kind==='agent'&&message.author.id===out.agent_id&&this.output.matchesText(JSON.parse(out.request).text,message.text)){
                const target=this.messages.records.targetedEffect('outbox',out.id).target;
                if(target.conversationId===message.conversationId&&message.rootId===(target.threadId??message.id)&&s.db.prepare('SELECT 1 FROM system_projections WHERE output_id=? UNION ALL SELECT 1 FROM task_projections WHERE output_id=?').get(out.id,out.id))message={...message,origin:'system'};
              }
            }
            this.messages.record(message,[installation.id]);
          }
        }
      }
      s.db.prepare('UPDATE ingress SET normalized=1 WHERE app_id=? AND event_id=?').run(appId,eventId);
    });
  }
}
