import { parseMessage, type MessageDTO } from '../domain/messages.js';
import { conversationTargetSchema, type ConversationTarget } from '../domain/conversations.js';
import type { References } from '../conversations/references.js';
import { encode, type Effect, type Store, type RunToken } from './store.js';
type MutableTargetType='works'|'tasks'|'schedules'|'task_intents'|'review_seats';

/** v2 writes own canonical payloads; adapters only translate at external boundaries. */
export class CanonicalWrites {
  constructor(readonly store: Store, readonly references: References, private readonly legacyEffect?: (value:unknown)=>Record<string,unknown>) {}
  private compatible(old:Effect,request:Record<string,unknown>):unknown {
    const body=JSON.parse(old.request);
    let normalized:Record<string,unknown>;
    if(Object.hasOwn(body,'format')){
      if(body.format!=='mate.effect.v2')throw new Error('Unsupported stored effect format');
      const {format:_,...rest}=body;normalized=rest;
    }else{
      if(!this.legacyEffect)throw new Error('Legacy effect compatibility unavailable');
      normalized=this.legacyEffect(body);
    }
    const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)])):value;
    if(encode(stable(normalized))!==encode(stable(request)))throw new Error('Effect identity conflict');
    return body;
  }
  assertFormat(): void {
    const marker = this.store.db.prepare("SELECT value FROM runtime_meta WHERE key='conversation_format'").get() as {value:string}|undefined;
    if (marker?.value !== 'mate.conversations.v2' || ![17,18,19].includes(Number(this.store.db.pragma('user_version',{simple:true})))) throw new Error('Canonical conversation migration required');
  }
  private target(input:unknown):ConversationTarget {
    this.assertFormat();
    if(!this.store.db.inTransaction)throw new Error('Canonical write requires an authoritative transaction');
    return this.references.validateTarget(conversationTargetSchema.parse(input));
  }
  mutable(type: MutableTargetType,id: string): void {
    const key = type === 'review_seats' ? 'agent_id' : 'id';
    const row = this.store.db.prepare(`SELECT target FROM ${type} WHERE ${key}=?`).get(id) as {target:string}|undefined;
    if (!row) throw new Error('Target object missing after write');
    this.target(JSON.parse(row.target));
  }
  message(input: MessageDTO): MessageDTO {
    this.assertFormat();
    if (!this.store.db.inTransaction) throw new Error('Message write requires an authoritative transaction');
    const message = parseMessage(input);
    const identity = this.references.message(message.id);
    if (identity.conversationId !== message.conversationId || identity.rootId !== message.rootId) throw new Error('Message identity mismatch');
    const body = encode({format:'mate.message.v2',message});
    this.store.db.prepare(`INSERT INTO messages(key,channel,ts,thread,revision,body,deleted) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET thread=excluded.thread,revision=excluded.revision,body=excluded.body,deleted=excluded.deleted`)
      .run(message.id,message.conversationId,message.order,message.rootId,message.revision,body,Number(message.deleted));
    this.store.db.prepare('INSERT INTO message_revisions(key,revision,body) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(message.id,message.revision,body);
    return message;
  }
  queueOutput(actor:string,id:string,input:{target:ConversationTarget;text:string;[key:string]:unknown}): Effect {
    return this.store.atomic(()=>{
      this.assertFormat();this.references.validateTarget(conversationTargetSchema.parse(input.target));
      if (Object.hasOwn(input,'format')) throw new Error('Effect format is controlled by persistence');
      const old=this.store.output(id);
      const row=this.store.queueOutput(actor,id,old?this.compatible(old,input):{format:'mate.effect.v2',...input},encode(conversationTargetSchema.parse(input.target)));
      const routing=this.store.db.prepare('SELECT target FROM outbox WHERE id=?').get(id) as {target:string};
      const target=this.target(JSON.parse(routing.target));
      if(target.conversationId!==input.target.conversationId||target.threadId!==input.target.threadId)throw new Error('Output routing target mismatch');return row;
    });
  }
  enqueue(actor:string,dedupe:string,payload:unknown,priority=0,now=Date.now()):string {
    return this.store.atomic(()=>{
      this.assertFormat();const id=this.store.enqueue(actor,dedupe,payload,priority,now);
      const row=this.store.delivery(id),body=JSON.parse(row.payload);
      if(body.target)this.target(body.target);
      return id;
    });
  }
  prepareAction(run:RunToken,id:string,request:Record<string,unknown>):Effect {
    return this.store.atomic(()=>{
      this.assertFormat();if(Object.hasOwn(request,'format'))throw new Error('Effect format is controlled by persistence');
      const old=this.store.action(id);
      const row=this.store.prepareAction(run,id,old?this.compatible(old,request):{format:'mate.effect.v2',...request});
      const target=(request.args as Record<string,unknown>|undefined)?.target??request.target;
      if(target)this.target(target);
      return row;
    });
  }
}
