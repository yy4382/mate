import {z} from 'zod';
import {hash,encode,type RunToken} from '../storage/store.js';
import {conversationTargetSchema,type ConversationTarget} from '../domain/conversations.js';
import {principalSchema,parseMessage,type MessageDTO} from '../domain/messages.js';
import type {Conversations} from './messages.js';
const id=z.string().min(1).max(1000),limit=z.number().int().min(1).max(100).default(20),cursor=z.string().max(20000).optional();
export const historySchemas={
 'history.page':z.object({target:conversationTargetSchema,limit,cursor,before:id.optional(),after:id.optional()}).strict(),
 'history.search':z.object({query:z.string().min(1).max(1000),target:conversationTargetSchema.optional(),author:principalSchema.optional(),limit,cursor}).strict(),
 'history.around':z.object({messageId:id,before:z.number().int().min(0).max(50).default(10),after:z.number().int().min(0).max(50).default(10)}).strict(),
 'history.fetch':z.object({target:conversationTargetSchema,limit,cursor,before:id.optional(),after:id.optional()}).strict()
};
export interface HistoryRange {limit:number;before?:string;after?:string;cursor?:string}
export interface SourcePage {messages:MessageDTO[];nextCursor:string|null;exhausted:boolean;scope:string;gaps:string[];available:boolean}
/** Adapter verifies the acting installation. Canonical IDs and a fenced run cross this port. */
export interface HistorySource {fetch(run:RunToken,target:ConversationTarget,range:HistoryRange,signal:AbortSignal):Promise<SourcePage>}
interface Position {channel:string;order:string;id:string}
interface Query {target?:ConversationTarget|undefined;limit:number;cursor?:string|undefined;before?:string|undefined;after?:string|undefined;query?:string|undefined;author?:z.infer<typeof principalSchema>|undefined}
interface Cursor {key:string;position?:Position|undefined;remote?:string|undefined}
export class ConversationHistory {
  constructor(readonly messages:Conversations,readonly source?:HistorySource){}
  private authorize(run:RunToken,target?:ConversationTarget):void {
    const m=this.messages;if(Number(m.store.db.pragma('user_version',{simple:true}))<21)throw new Error('History storage migration required');m.store.assertRun(run);m.requireReadable(run.agentId);
    if(target){m.references.validateTarget(target);m.requireAccess(run.agentId,target.conversationId);
      const room=m.references.conversation(target.conversationId);
      if(room.authority==='internal'&&room.kind==='dm'){
        const pair=m.store.db.prepare('SELECT pair FROM internal_dm_pairs WHERE conversation_id=?').get(room.id) as {pair:string}|undefined;
        if(!pair||!(JSON.parse(pair.pair) as string[]).includes(run.agentId))throw new Error('Private DM history denied');
      }
    }
  }
  private authorizedMessage(run:RunToken,id:string):MessageDTO {
    const m=this.messages,message=m.records.message(id);if(!message)throw new Error('Message not found');this.authorize(run,{conversationId:message.conversationId});
    const room=m.references.conversation(message.conversationId);
    if(room.authority==='internal'&&room.kind==='channel')return message;
    return m.message(run.agentId,id);
  }
  private key(run:RunToken,operation:string,input:Query):string {const{cursor:_,...rest}=input;return hash(encode({actor:run.agentId,operation,query:rest,order:'conversation_then_order_desc_id_desc'}));}
  private decode(value:string|undefined,key:string):Cursor|undefined {
    if(!value)return;
    let parsed:unknown;try{parsed=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{throw new Error('Invalid history cursor');}
    const result=z.object({key:z.string(),position:z.object({channel:id,order:z.string().regex(/^(0|[1-9][0-9]*)$/),id}).strict().optional(),remote:z.string().optional()}).strict().parse(parsed);
    if(result.key!==key)throw new Error('History cursor belongs to another actor, target or query');return result;
  }
  private cursor(value:Cursor):string{return Buffer.from(encode(value)).toString('base64url');}
  private boundary(run:RunToken,input:Query,id:string|undefined):MessageDTO|undefined {
    if(!id)return;const message=this.authorizedMessage(run,id);
    if(input.target&&(message.conversationId!==input.target.conversationId||input.target.threadId&&message.rootId!==input.target.threadId))throw new Error('History anchor belongs to another target');return message;
  }
  private query(run:RunToken,input:Query,operation:string){
    this.authorize(run,input.target);const key=this.key(run,operation,input),position=this.decode(input.cursor,key)?.position;
    const before=this.boundary(run,input,input.before),after=this.boundary(run,input,input.after),m=this.messages;
    const less="(length(m.ts)<length(?) OR (length(m.ts)=length(?) AND (m.ts<? OR (m.ts=? AND m.key<?))))";
    const greater="(length(m.ts)>length(?) OR (length(m.ts)=length(?) AND (m.ts>? OR (m.ts=? AND m.key>?))))";
    let rows:{key:string;channel:string;ts:string}[]=[];
    if(input.target){
      const clauses=["a.agent_id=? AND a.active=1","((c.authority='internal' AND c.kind='channel') OR v.key IS NOT NULL)",'m.channel=?'];
      const params:(string|number)[]=[run.agentId,input.target.conversationId];
      if(input.target.threadId){clauses.push('m.thread=?');params.push(input.target.threadId);}
      for(const [bound,predicate] of [[before,less],[after,greater]] as const)if(bound){clauses.push(predicate);params.push(bound.order,bound.order,bound.order,bound.order,bound.id);}
      if(position){clauses.push(less);params.push(position.order,position.order,position.order,position.order,position.id);}
      const index=input.target.threadId?'message_history_thread':'message_history_conversation';
      rows=m.store.db.prepare(`SELECT m.key,m.channel,m.ts FROM messages m INDEXED BY ${index} JOIN conversation_identities c ON c.id=m.channel JOIN channel_access a ON a.channel=m.channel LEFT JOIN message_visibility v ON v.key=m.key AND v.agent_id=a.agent_id WHERE ${clauses.join(' AND ')} ORDER BY m.channel,length(m.ts) DESC,m.ts DESC,m.key DESC LIMIT 1001`).all(...params) as typeof rows;
    }else{
      // A cross-conversation JOIN makes SQLite sort every authorized candidate in
      // a temporary B-tree. Walk the channel_access primary key and run one bounded
      // index range per channel so message work and memory stay within 1001 rows.
      const channels=m.store.db.prepare('SELECT channel FROM channel_access WHERE agent_id=? AND active=1 AND (? IS NULL OR channel>=?) ORDER BY channel').iterate(run.agentId,position?.channel??null,position?.channel??null) as IterableIterator<{channel:string}>;
      for(const {channel} of channels){
        const clauses=["m.channel=?","((c.authority='internal' AND c.kind='channel') OR v.key IS NOT NULL)"];
        const params:(string|number)[]=[run.agentId,channel];
        if(position?.channel===channel){clauses.push(less);params.push(position.order,position.order,position.order,position.order,position.id);}
        params.push(1001-rows.length);
        const page=m.store.db.prepare(`SELECT m.key,m.channel,m.ts FROM messages m INDEXED BY message_history_conversation JOIN conversation_identities c ON c.id=m.channel LEFT JOIN message_visibility v ON v.key=m.key AND v.agent_id=? WHERE ${clauses.join(' AND ')} ORDER BY m.channel,length(m.ts) DESC,m.ts DESC,m.key DESC LIMIT ?`).all(...params) as typeof rows;
        rows.push(...page);if(rows.length===1001)break;
      }
    }
    const results:MessageDTO[]=[];let scanned=0,last:Position|undefined;
    for(const row of rows.slice(0,1000)){
      scanned++;last={channel:row.channel,order:row.ts,id:row.key};
      const message=this.authorizedMessage(run,row.key);
      if(message.deleted)continue;
      if(input.author&&encode(message.author)!==encode(input.author))continue;
      if(input.query&&!message.text.toLocaleLowerCase().includes(input.query.toLocaleLowerCase()))continue;
      // Current internal room permission includes history, without inventing new work.
      if(m.references.conversation(message.conversationId).authority==='internal')m.recordHistory(message,[run.agentId]);
      results.push(message);if(results.length===input.limit)break;
    }
    const more=rows.length>scanned;
    return{messages:results,nextCursor:more&&last?this.cursor({key,position:last}):null,coverage:{source:'local_visible',scope:input.target??'current_authorized_conversations',exhausted:!more,scanLimited:scanned===1000&&more,scanned,live:true,order:'conversation_then_order_desc_id_desc',remoteComplete:false}};
  }
  page(run:RunToken,value:unknown){return this.query(run,historySchemas['history.page'].parse(value),'page');}
  search(run:RunToken,value:unknown){return this.query(run,historySchemas['history.search'].parse(value),'search');}
  around(run:RunToken,value:unknown){
    const input=historySchemas['history.around'].parse(value),anchor=this.authorizedMessage(run,input.messageId),m=this.messages;
    const target={conversationId:anchor.conversationId,...(anchor.rootId&&anchor.rootId!==anchor.id?{threadId:anchor.rootId}:{})};
    // SQL selects closest neighbors, not an offset or the first page of all later history.
    const side=(direction:'before'|'after',count:number)=>{
      if(!count)return{messages:[] as MessageDTO[],truncated:false};const op=direction==='before'?'<':'>',sort=direction==='before'?'DESC':'ASC';
      const thread=target.threadId?'AND m.thread=?':'';
      const params:(string|number)[]=[run.agentId,target.conversationId,...(target.threadId?[target.threadId]:[]),anchor.order,anchor.order,anchor.order,anchor.order,anchor.id,1001];
      const index=target.threadId?'message_history_thread':'message_history_conversation';
      const rows=m.store.db.prepare(`SELECT m.key FROM messages m INDEXED BY ${index} JOIN conversation_identities c ON c.id=m.channel LEFT JOIN message_visibility v ON v.key=m.key AND v.agent_id=? WHERE m.channel=? ${thread} AND ((c.authority='internal' AND c.kind='channel') OR v.key IS NOT NULL) AND (length(m.ts)${op}length(?) OR (length(m.ts)=length(?) AND (m.ts${op}? OR (m.ts=? AND m.key${op}?)))) ORDER BY length(m.ts) ${sort},m.ts ${sort},m.key ${sort} LIMIT ?`).all(...params) as {key:string}[];
      const visible:MessageDTO[]=[];for(const row of rows.slice(0,1000)){const value=this.authorizedMessage(run,row.key);if(!value.deleted)visible.push(value);if(visible.length===count+1)break;}
      const messages=visible.slice(0,count);if(direction==='before')messages.reverse();return{messages,truncated:visible.length>count||rows.length>1000,scanLimited:rows.length>1000};
    };
    const before=side('before',input.before),after=side('after',input.after),messages=[...before.messages,anchor,...after.messages];
    for(const message of messages)if(m.references.conversation(message.conversationId).authority==='internal')m.recordHistory(message,[run.agentId]);
    return{messages,anchorId:anchor.id,coverage:{source:'local_visible',target,beforeCount:before.messages.length,afterCount:after.messages.length,beforeTruncated:before.truncated,afterTruncated:after.truncated,scanLimited:before.scanLimited||after.scanLimited,live:true,remoteComplete:false}};
  }
  async fetch(run:RunToken,value:unknown,signal:AbortSignal){
    const input=historySchemas['history.fetch'].parse(value);this.authorize(run,input.target);signal.throwIfAborted();
    this.boundary(run,input,input.before);this.boundary(run,input,input.after);
    const key=this.key(run,'fetch',input),remote=this.decode(input.cursor,key)?.remote;
    if(!this.source||this.messages.references.conversation(input.target.conversationId).authority!=='external')return{messages:[],nextCursor:null,coverage:{available:false,source:'remote',exhausted:false,gaps:['External history source unavailable; use local history']}};
    const page=await this.source.fetch(run,input.target,{limit:input.limit,...(input.before?{before:input.before}:{}),...(input.after?{after:input.after}:{}),...(remote?{cursor:remote}:{})},signal);
    this.authorize(run,input.target);signal.throwIfAborted();
    if(page.exhausted&&page.nextCursor)throw new Error('History source returned a continuation after exhaustion');
    return this.messages.store.atomic(()=>{
      const messages:MessageDTO[]=[],gaps=[...page.gaps];
      for(const raw of page.messages){
        let message:MessageDTO;
        try{message=parseMessage(raw);}catch{gaps.push('message_parse_failed');continue;}
        if(message.conversationId!==input.target.conversationId||input.target.threadId&&message.rootId!==input.target.threadId){gaps.push('message_outside_requested_target');continue;}
        // A global cache entry, including one with the same provider revision, may
        // come from another installation. Ingestion stores this actor's exact body.
        try{messages.push(this.messages.store.atomic(()=>{this.messages.recordHistory(message,[run.agentId]);return this.messages.message(run.agentId,message.id);}));}
        catch{gaps.push('message_import_failed');}
      }
      return{messages,nextCursor:page.nextCursor?this.cursor({key,remote:page.nextCursor}):null,coverage:{available:page.available,source:'remote',scope:page.scope,exhausted:page.exhausted,gaps:[...new Set(gaps)],live:true,retention:'unknown',remoteComplete:false}};
    });
  }
}
