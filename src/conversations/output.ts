import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MessageDTO } from '../domain/messages.js';
import { conversationTargetSchema, type ConversationTarget } from '../domain/conversations.js';
import type { Effect } from '../storage/store.js';
import type { Conversations } from './messages.js';
import type { CanonicalFreshnessGate, SendBasis } from './freshness.js';
import type { ArtifactPayload } from '../capabilities/artifacts.js';

export interface DispatchEnvelope {
  id:string; actor:string; target:ConversationTarget; text:string; requestHash:string; originalRequest:string;
}
export interface MessageConfirmation { message:MessageDTO; receipt:Record<string,unknown> }
export type DispatchFailure = {kind:'retry';afterMs:number}|{kind:'rejected';reason:string}|{kind:'unknown'};
export interface ExternalMessageTransport {
  post(request:DispatchEnvelope):Promise<MessageConfirmation>;
  pendingInput(target:ConversationTarget):boolean;
  classify(error:unknown):DispatchFailure;
  matchesText?(expected:string,observed:string):boolean;
}
export interface CanonicalArtifactTransport {
  upload(request:DispatchEnvelope,artifact:ArtifactPayload,prepared:(fileId:string)=>void,beforeShare:()=>boolean):Promise<{fileId:string}>;
}

/** Core owns intent, gating, confirmation and delivery. External identity belongs to adapters. */
export class CanonicalOutput {
  gate?:CanonicalFreshnessGate;
  artifacts?:CanonicalArtifactTransport;
  private dispatchQueue:Promise<unknown>=Promise.resolve();
  constructor(readonly messages:Conversations,readonly transport:ExternalMessageTransport,readonly clock:()=>number=Date.now){}
  matchesText(expected:string,observed:string):boolean{return this.transport.matchesText?.(expected,observed)??expected===observed;}
  queue(actor:string,target:ConversationTarget,text:string,id:string=randomUUID(),basis?:SendBasis):string {
    this.validate(actor,target,text);
    this.messages.store.atomic(()=>{this.messages.writes.queueOutput(actor,id,{target,text});this.gate?.queued(actor,id,basis);});return id;
  }
  queueArtifact(actor:string,target:ConversationTarget,text:string,artifact:ArtifactPayload,id:string,basis:SendBasis):string {
    this.validate(actor,target,text);
    this.messages.store.atomic(()=>{this.messages.writes.queueOutput(actor,id,{target,text,artifact});this.gate?.queued(actor,id,basis);});return id;
  }
  private validate(actor:string,target:ConversationTarget,text:string):void {
    this.messages.references.validateTarget(conversationTargetSchema.parse(target));this.messages.requireAccess(actor,target.conversationId);
    z.string().min(1).max(35000).parse(text);
    if(this.messages.references.conversation(target.conversationId).authority!=='external')throw new Error('Internal delivery is not installed');
  }
  private envelope(row:Effect):DispatchEnvelope {
    const effect=this.messages.records.targetedEffect('outbox',row.id),body=JSON.parse(row.request);
    return{id:row.id,actor:row.agent_id,target:effect.target,text:body.text,requestHash:row.request_hash,originalRequest:row.request};
  }
  private eligible(row:Effect,request:DispatchEnvelope):boolean {
    const s=this.messages.store;
    if(s.db.prepare('SELECT 1 FROM agents WHERE id=? AND paused=1').get(row.agent_id))return false;
    const work=s.db.prepare('SELECT w.state FROM works w JOIN output_work ow ON ow.work_id=w.id WHERE ow.output_id=?').get(row.id) as {state:string}|undefined;
    if(work?.state==='cancelled')return true;
    if(work&&work.state!=='active')return false;
    if((JSON.parse(row.receipt??'null')?.retryAt??0)>this.clock())return false;
    if(this.gate&&(this.transport.pendingInput(request.target)||s.db.prepare(`SELECT 1 FROM outbox o
      WHERE o.id!=? AND o.state IN ('sending','unknown') AND json_extract(o.target,'$.conversationId')=? AND (json_extract(o.target,'$.threadId') IS NULL OR ? IS NULL OR json_extract(o.target,'$.threadId')=?)`)
      .get(row.id,request.target.conversationId,request.target.threadId??null,request.target.threadId??null)))return false;
    const artifact=JSON.parse(row.request).artifact;
    if(artifact&&s.db.prepare("SELECT 1 FROM outbox WHERE id!=? AND agent_id=? AND state IN ('sending','unknown') AND json_extract(request,'$.artifact.contentHash')=?").get(row.id,row.agent_id,artifact.contentHash))return false;
    return true;
  }
  ready(limit=20):{id:string}[]{
    z.number().int().min(1).max(1000).parse(limit);
    const ready:{id:string}[]=[];
    // Apply all dispatch eligibility before LIMIT, preserving independent room progress.
    for(const row of this.messages.store.db.prepare("SELECT * FROM outbox WHERE state='pending' ORDER BY rowid").iterate() as IterableIterator<Effect>){
      if(this.eligible(row,this.envelope(row)))ready.push({id:row.id});
      if(ready.length===limit)break;
    }
    return ready;
  }
  /** Only authenticated adapters may provide evidence. A matching metadata string alone is insufficient. */
  confirm(id:string,requestHash:string,confirmation:MessageConfirmation):void {
    const s=this.messages.store;s.atomic(()=>{
      const row=s.output(id);if(!row||!['sending','unknown','sent'].includes(row.state))throw new Error('Output was not dispatched');
      const request=this.envelope(row),message=confirmation.message;
      if(row.request_hash!==requestHash||message.author.kind!=='agent'||message.author.id!==row.agent_id||message.deleted||message.conversationId!==request.target.conversationId||!this.matchesText(request.text,message.text)||message.rootId!==(request.target.threadId??message.id))throw new Error('Confirmation evidence mismatch');
      if(JSON.parse(row.request).artifact)throw new Error('Artifact requires publication evidence');
      if(row.state==='sent'){
        if(JSON.parse(row.receipt??'null')?.messageId!==message.id)throw new Error('Confirmation identity conflict');
        return;
      }
      const system=!!s.db.prepare('SELECT 1 FROM system_projections WHERE output_id=? UNION ALL SELECT 1 FROM task_projections WHERE output_id=?').get(id,id);
      this.messages.record({...message,origin:system?'system':'participant'},[]);
      const work=s.db.prepare('SELECT work_id FROM output_work WHERE output_id=?').get(id) as {work_id:string}|undefined;
      if(work)s.db.prepare('INSERT INTO message_work VALUES(?,?) ON CONFLICT DO NOTHING').run(message.id,work.work_id);
      const recipients=(s.db.prepare('SELECT agent_id FROM channel_access WHERE channel=? AND active=1').all(message.conversationId) as {agent_id:string}[]).map(r=>r.agent_id);
      this.messages.record({...message,origin:system?'system':'participant'},recipients);
      s.transitionOutput(id,row.state as 'sending'|'unknown','sent',{...confirmation.receipt,messageId:message.id});
      if(work)s.db.prepare("INSERT INTO delivery_work SELECT d.id,? FROM deliveries d WHERE json_extract(d.payload,'$.messageKey')=? ON CONFLICT DO NOTHING").run(work.work_id,message.id);
    });
  }
  reconcileArtifact(id:string,fileId:string,message:MessageDTO):void {
    const s=this.messages.store,row=s.output(id);
    if(!row||row.state!=='unknown')throw new Error('Output does not require reconciliation');
    const request=this.envelope(row),body=JSON.parse(row.request),receipt=JSON.parse(row.receipt??'{}');
    if(!body.artifact||receipt.fileId!==fileId||message.author.kind!=='agent'||message.author.id!==row.agent_id||message.conversationId!==request.target.conversationId||message.rootId!==(request.target.threadId??message.id)||message.deleted||!message.attachments.some(file=>file.id===fileId))throw new Error('Artifact receipt evidence mismatch');
    s.atomic(()=>{
      s.transitionOutput(id,'unknown','sent',{fileId});
      s.db.prepare('INSERT INTO conversation_events(channel,thread,message_key,revision,kind) VALUES(?,?,?,?,?)').run(request.target.conversationId,request.target.threadId??null,`artifact:${fileId}`,fileId,'artifact');
      s.audit('artifact_published',{outputId:id,actor:row.agent_id,target:request.target,fileId});
    });
  }
  send(id:string):Promise<void>{const next=this.dispatchQueue.then(()=>this.sendNow(id));this.dispatchQueue=next.catch(()=>{});return next;}
  private async sendNow(id:string):Promise<void>{
    const s=this.messages.store,row=s.output(id);if(!row||row.state!=='pending')return;
    const request=this.envelope(row);
    const work=s.db.prepare('SELECT w.state FROM works w JOIN output_work ow ON ow.work_id=w.id WHERE ow.output_id=?').get(id) as {state:string}|undefined;
    if(work?.state==='cancelled'){s.transitionOutput(id,'pending','failed',{reason:'work_cancelled'});return;}
    if(!this.eligible(row,request))return;
    if(!this.messages.access(row.agent_id,request.target.conversationId)){s.transitionOutput(id,'pending','failed',{reason:'access_revoked'});return;}
    if(this.gate&&!this.gate.dispatch(id))return;
    const artifact=JSON.parse(row.request).artifact as ArtifactPayload|undefined;
    s.transitionOutput(id,'pending','sending',artifact?{phase:'staging'}:undefined);
    if(artifact){await this.publish(row,request,artifact);return;}
    let confirmation:MessageConfirmation;
    try{confirmation=await this.transport.post(request);}catch(error){
      if(s.output(id)?.state==='sent')return; // An authenticated echo already confirmed the dispatch.
      const failure=this.transport.classify(error);
      if(failure.kind==='retry'&&Number.isFinite(failure.afterMs))s.transitionOutput(id,'sending','pending',{retryAt:this.clock()+Math.max(1,failure.afterMs)});
      else if(failure.kind==='rejected')s.transitionOutput(id,'sending','failed',{reason:failure.reason});
      else s.transitionOutput(id,'sending','unknown',{reason:'request_outcome_unknown'});
      return;
    }
    this.confirm(id,row.request_hash,confirmation);
  }
  private async publish(row:Effect,request:DispatchEnvelope,artifact:ArtifactPayload):Promise<void>{
    const s=this.messages.store;let fileId:string|undefined,sharing=false;
    try{
      if(!this.artifacts)throw new Error('Artifact transport unavailable');
      const receipt=await this.artifacts.upload(request,artifact,id=>{fileId=id;s.db.prepare("UPDATE outbox SET receipt=? WHERE id=? AND state='sending'").run(JSON.stringify({fileId:id,phase:'staging'}),row.id);},()=>{
        if(s.output(row.id)?.state!=='sending')return false;
        s.transitionOutput(row.id,'sending','pending',{fileId,phase:'staging'});
        if(!this.eligible(s.output(row.id)!,request)||!this.messages.access(row.agent_id,request.target.conversationId))return false;
        if(this.gate&&!this.gate.dispatch(row.id))return false;
        s.transitionOutput(row.id,'pending','sending',{fileId,phase:'sharing'});sharing=true;return true;
      });
      if(!sharing||!fileId||receipt.fileId!==fileId)throw new Error('Artifact receipt mismatch');
      s.atomic(()=>{s.transitionOutput(row.id,'sending','sent',receipt);s.db.prepare('INSERT INTO conversation_events(channel,thread,message_key,revision,kind) VALUES(?,?,?,?,?)').run(request.target.conversationId,request.target.threadId??null,`artifact:${fileId}`,fileId,'artifact');});
    }catch{if(s.output(row.id)?.state==='sending')s.transitionOutput(row.id,'sending',sharing?'unknown':'failed',{reason:sharing?'artifact_outcome_unknown':'artifact_not_shared',...(fileId?{fileId}:{})});}
  }
}
