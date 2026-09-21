import type { AgentDirectory } from '../agents/directory.js';
import { compareMessageOrder, parseMessage, type MessageDTO } from '../domain/messages.js';
import type { ConversationTarget } from '../domain/conversations.js';
import { encode, type Store } from '../storage/store.js';
import type { ConversationRecords } from '../storage/conversations.js';
import type { CanonicalWrites } from '../storage/conversation-writes.js';
import type { References } from './references.js';

export interface ParticipationPolicy { participates(actor:string,conversationId:string):boolean }
/** Canonical ingestion, independent of transports. Visibility is supplied by a trusted adapter. */
export class MessageIngestion {
  constructor(readonly store:Store,readonly references:References,readonly records:ConversationRecords,readonly writes:CanonicalWrites,readonly agents:AgentDirectory,readonly policy:ParticipationPolicy,readonly matchesText:(expected:string,observed:string)=>boolean=(a,b)=>a===b) {}
  record(input:MessageDTO,visibleTo:readonly string[]):void {
    const message=parseMessage(input);
    this.store.atomic(()=>{
      this.writes.assertFormat();
      const conversation=this.references.conversation(message.conversationId);
      const old=this.records.message(message.id);
      if(old&&(old.conversationId!==message.conversationId||old.order!==message.order))throw new Error('Message location/order is immutable');
      if(old?.rootId&&message.rootId&&old.rootId!==message.rootId)throw new Error('Message root conflict');
      let effective=old;
      let kind:string|undefined;
      if(!old||compareMessageOrder(message.revision,old.revision)>0){
        effective={...message,rootId:message.rootId??old?.rootId??null,...(message.author.kind==='unknown'&&old?{author:old.author}:{}),...(message.deleted&&old?{origin:old.origin}:{})};
        kind=message.deleted?'delete':old?'edit':'message';
      }else if(old.rootId===null&&message.rootId!==null){
        effective={...old,rootId:message.rootId};kind=old.deleted?'delete':'location_enriched';
      }
      if(old&&!old.deleted&&compareMessageOrder(message.revision,old.revision)===0&&message.attachments.length&&!old.attachments.length){
        effective={...(effective??old),attachments:message.attachments};kind='files_enriched';
        this.store.db.prepare('DELETE FROM attention_seen WHERE key=?').run(message.id);
      }
      if(!effective)throw new Error('Message missing');
      if(effective.rootId===null)this.references.reserveMessage(effective.conversationId,effective.id);
      else {
        const root=effective.rootId!==effective.id?this.records.message(effective.rootId):undefined;
        this.references.createMessage(effective.conversationId,effective.rootId);
        if(root&&root.rootId===null){
          this.writes.message({...root,rootId:root.id});
          this.store.db.prepare('INSERT INTO conversation_events(channel,thread,message_key,revision,kind) VALUES(?,?,?,?,?)').run(root.conversationId,root.id,root.id,root.revision,'location_enriched');
        }
        this.references.createMessage(effective.conversationId,effective.id,effective.rootId);
      }
      if(kind){
        this.writes.message(effective);
        this.store.db.prepare('INSERT INTO conversation_events(channel,thread,message_key,revision,kind) VALUES(?,?,?,?,?)')
          .run(effective.conversationId,effective.rootId,effective.id,effective.revision,kind);
      }
      for(const actor of new Set(visibleTo)){
        this.agents.get(actor);
        if(!this.store.db.prepare('SELECT 1 FROM channel_access WHERE agent_id=? AND channel=? AND active=1').get(actor,effective.conversationId))continue;
        const added=this.store.db.prepare('INSERT INTO message_visibility VALUES(?,?) ON CONFLICT DO NOTHING').run(actor,effective.id).changes;
        if(old&&added)this.store.db.prepare('INSERT INTO conversation_events(channel,thread,message_key,revision,kind,audience) VALUES(?,?,?,?,?,?)')
          .run(effective.conversationId,effective.rootId,effective.id,effective.revision,'visibility',actor);
        if(!effective.deleted&&effective.author.kind==='agent'&&effective.attachments.length===1){
          const publications=this.store.db.prepare("SELECT o.id,o.agent_id,o.request FROM outbox o JOIN attention_seen seen ON seen.agent_id=? AND seen.key='artifact:'||json_extract(o.receipt,'$.fileId') WHERE o.state='sent' AND json_extract(o.receipt,'$.fileId')=?").all(actor,effective.attachments[0]!.id) as {id:string;agent_id:string;request:string}[];
          for(const publication of publications){
            const target=this.records.targetedEffect('outbox',publication.id).target;
            if(publication.agent_id===effective.author.id&&target.conversationId===effective.conversationId&&effective.rootId===(target.threadId??effective.id)&&this.matchesText(JSON.parse(publication.request).text,effective.text)){
              this.store.db.prepare('INSERT INTO attention_seen VALUES(?,?,?) ON CONFLICT(agent_id,key) DO UPDATE SET revision=excluded.revision').run(actor,effective.id,effective.revision);break;
            }
          }
        }
        if(!this.store.db.prepare('INSERT INTO message_observations VALUES(?,?,?) ON CONFLICT DO NOTHING').run(actor,effective.id,effective.revision).changes)continue;
        if(effective.deleted||effective.origin==='system'||effective.author.kind==='agent'&&effective.author.id===actor)continue;
        const direct=conversation.kind==='dm'||effective.mentions.some(p=>p.kind==='agent'&&p.id===actor);
        const watched=!!this.store.db.prepare('SELECT 1 FROM channel_watches WHERE agent_id=? AND channel=?').get(actor,effective.conversationId)
          ||!!this.store.db.prepare('SELECT 1 FROM thread_watches WHERE agent_id=? AND channel=? AND thread=?').get(actor,effective.conversationId,effective.rootId);
        if(!direct&&!watched&&!this.policy.participates(actor,effective.conversationId))continue;
        const target:ConversationTarget={conversationId:effective.conversationId,...(effective.rootId?{threadId:effective.rootId}:{})};
        const now=Date.now();
        if(this.store.db.prepare('SELECT 1 FROM attention_state WHERE agent_id=? AND target IN (?,?) AND (muted=1 OR deferred_until>?)')
          .get(actor,encode({conversationId:effective.conversationId}),encode(target),now))continue;
        const work=this.store.db.prepare('SELECT work_id FROM message_work WHERE message_key=?').get(effective.id) as {work_id:string}|undefined;
        const notice=!direct&&!watched,bucket=Math.floor(now/20000);
        const delivery=this.writes.enqueue(actor,notice?`notice:${effective.conversationId}:${work?.work_id??'unbound'}:${bucket}`:`message:${effective.id}:${effective.revision}`,{
          kind:notice?'notice':'message',messageKey:effective.id,revision:effective.revision,source:effective.author,target,receivedAt:now,
          ...(notice?{notBefore:(bucket+1)*20000,conversationId:effective.conversationId,windowStart:bucket*20000}:{}),
        },direct?(effective.author.kind==='agent'?50:100):watched?20:0,now);
        if(work)this.store.db.prepare('INSERT INTO delivery_work VALUES(?,?) ON CONFLICT DO NOTHING').run(delivery,work.work_id);
      }
    });
  }
}
