import type { AgentDirectory } from '../agents/directory.js';
import type { AgentDefinition } from '../domain/agents.js';
import type { MessageDTO } from '../domain/messages.js';
import { conversationTargetSchema, type ConversationTarget } from '../domain/conversations.js';
import { encode, type Store } from '../storage/store.js';
import type { ConversationRecords } from '../storage/conversations.js';
import type { CanonicalWrites } from '../storage/conversation-writes.js';
import { MessageIngestion, type ParticipationPolicy } from './ingestion.js';
import type { References } from './references.js';

/** Platform-independent conversation application boundary. */
export class Conversations {
  private readonly versions=new Map<string,number>();
  private readonly ingestion:MessageIngestion;
  constructor(readonly store:Store,readonly agents:AgentDirectory,readonly references:References,readonly records:ConversationRecords,readonly writes:CanonicalWrites,readonly policy:ParticipationPolicy,readonly matchesText:(expected:string,observed:string)=>boolean=(a,b)=>a===b){
    this.ingestion=new MessageIngestion(store,references,records,writes,agents,policy,matchesText);
  }
  agent(id:string):AgentDefinition{return this.agents.get(id);}
  membershipVersion(actor:string):number{return this.versions.get(actor)??0;}
  access(actor:string,conversationId:string):boolean {
    return !!this.store.db.prepare('SELECT 1 FROM channel_access WHERE agent_id=? AND channel=? AND active=1').get(actor,conversationId);
  }
  requireAccess(actor:string,conversationId:string):void {
    this.agents.get(actor);this.references.conversation(conversationId);
    if(!this.access(actor,conversationId))throw new Error('Conversation access denied');
  }
  isolated(actor:string):boolean{return !!this.store.db.prepare('SELECT 1 FROM review_seats WHERE agent_id=? AND active=1').get(actor);}
  requireReadable(actor:string):void{if(this.isolated(actor))throw new Error('Independent review seat isolates conversation inputs');}
  /** Only trusted membership evidence may call this method; directory discovery alone is insufficient. */
  membership(actor:string,conversationId:string,active:boolean):void {
    this.writes.assertFormat();this.agents.get(actor);this.references.conversation(conversationId);
    this.store.atomic(()=>{
      this.store.db.prepare('INSERT INTO channel_access VALUES(?,?,?) ON CONFLICT(agent_id,channel) DO UPDATE SET active=excluded.active').run(actor,conversationId,Number(active));
    });
    this.versions.set(actor,this.membershipVersion(actor)+1);
  }
  watch(actor:string,input:ConversationTarget,active:boolean):void {
    const target=this.references.validateTarget(conversationTargetSchema.parse(input));this.requireAccess(actor,target.conversationId);
    this.store.atomic(()=>{
      if(target.threadId){
        if(active)this.store.db.prepare('INSERT INTO thread_watches VALUES(?,?,?) ON CONFLICT DO NOTHING').run(actor,target.conversationId,target.threadId);
        else this.store.db.prepare('DELETE FROM thread_watches WHERE agent_id=? AND channel=? AND thread=?').run(actor,target.conversationId,target.threadId);

      }else{
        if(active)this.store.db.prepare('INSERT INTO channel_watches VALUES(?,?) ON CONFLICT DO NOTHING').run(actor,target.conversationId);
        else this.store.db.prepare('DELETE FROM channel_watches WHERE agent_id=? AND channel=?').run(actor,target.conversationId);
      }
    });
  }
  record(message:MessageDTO,visibleTo:readonly string[]):void{this.ingestion.record(message,visibleTo);}
  message(actor:string,id:string):MessageDTO {
    this.requireReadable(actor);const message=this.records.message(id);
    if(!message)throw new Error('Message not found');this.requireAccess(actor,message.conversationId);
    if(!this.store.db.prepare('SELECT 1 FROM message_visibility WHERE agent_id=? AND key=?').get(actor,id))throw new Error('Message not visible');
    return message;
  }
  read(actor:string,input:ConversationTarget):MessageDTO[] {
    this.requireReadable(actor);const target=this.references.validateTarget(conversationTargetSchema.parse(input));this.requireAccess(actor,target.conversationId);
    const rows=this.store.db.prepare(`SELECT m.key FROM messages m JOIN message_visibility v ON v.key=m.key WHERE v.agent_id=? AND m.channel=? AND (? IS NULL OR m.thread=?) AND m.deleted=0 ORDER BY length(m.ts),m.ts,m.key`)
      .all(actor,target.conversationId,target.threadId??null,target.threadId??null) as {key:string}[];
    return rows.map(row=>this.records.message(row.key)!);
  }
  search(actor:string,query:string):MessageDTO[] {
    this.requireReadable(actor);this.agents.get(actor);
    if(!query.trim() || query.length>35000)throw new Error('Search query required');
    // Search the interpreted body, including preserved v1 evidence, under current ACL.
    const rows=this.store.db.prepare(`SELECT m.key FROM messages m JOIN message_visibility v ON v.key=m.key JOIN channel_access a ON a.channel=m.channel AND a.agent_id=v.agent_id AND a.active=1 WHERE v.agent_id=? AND m.deleted=0 ORDER BY length(m.ts) DESC,m.ts DESC`).all(actor) as {key:string}[];
    const found:MessageDTO[]=[];
    for(const row of rows){const message=this.records.message(row.key)!;if(message.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))found.push(message);if(found.length===100)break;}
    return found;
  }
  recent(actor:string,conversationId:string):MessageDTO[] {
    this.requireReadable(actor);this.requireAccess(actor,conversationId);
    const rows=this.store.db.prepare(`SELECT m.key FROM messages m JOIN message_visibility v ON v.key=m.key WHERE v.agent_id=? AND m.channel=? AND m.deleted=0 ORDER BY length(m.ts) DESC,m.ts DESC,m.key DESC LIMIT 100`).all(actor,conversationId) as {key:string}[];
    return rows.reverse().map(row=>this.records.message(row.key)!);
  }
}
