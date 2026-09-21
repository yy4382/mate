import type {CanonicalSlackTransport} from './transport.js';
import {slackTextMatches} from './text.js';
import {rawMessage,slackTs} from './protocol.js';
import {slackPrincipal} from './legacy-codec.js';
import type {ProjectionBinding,ProjectionDispatch,ProjectionEvidence,ProjectionTransport,Projections} from '../conversations/projections.js';
import type {ProjectionImports} from '../conversations/projection-imports.js';

/** Slack protocol only. Canonical permission, dependency and confirmation state are application-owned. */
export class SlackProjectionTransport implements ProjectionTransport {
  constructor(readonly slack:CanonicalSlackTransport){}
  private client(binding:{publisher:string;workspace:string;provider:string;externalId:string}){
    if(binding.provider!=='slack'||binding.workspace!==this.slack.mapper.config.teamId||!/^[CDG][A-Z0-9]+$/.test(binding.externalId))throw new Error('Invalid Slack projection binding');
    const client=this.slack.clients.get(binding.publisher);if(!client)throw new Error('Projection publisher has no Slack client');return client;
  }
  prepare(b:ProjectionBinding,text:string,thread?:string){
    this.client(b);if(thread)slackTs.parse(thread);
    return{text,target:{provider:b.provider,workspace:b.workspace,externalId:b.externalId},...(thread?{thread}:{})};
  }
  async authorized(b:ProjectionBinding):Promise<boolean>{
    const result=await this.client(b).conversations.info({channel:b.externalId});
    return !result.channel?.is_archived&&(result.channel?.is_member===true||b.externalId.startsWith('D')&&result.channel?.is_im===true);
  }
  async post(r:ProjectionDispatch):Promise<ProjectionEvidence>{
    const result=await this.client({...r.wire.target,publisher:r.publisher}).chat.postMessage({channel:r.wire.target.externalId,...(r.wire.thread?{thread_ts:r.wire.thread}:{}),text:r.wire.text,metadata:{event_type:'mate_projection',event_payload:{id:r.id,request_hash:r.requestHash}},unfurl_links:false,unfurl_media:false});
    if(!result.ts||result.channel&&result.channel!==r.wire.target.externalId)throw new Error('Invalid projection Slack receipt');slackTs.parse(result.ts);
    return{publisher:r.publisher,locator:{...r.wire.target,messageId:result.ts},root:r.wire.thread??result.ts,text:r.wire.text};
  }
  classify(error:unknown){return this.slack.classify(error);}
  matchesText(a:string,b:string){return slackTextMatches(a,b);}
}

/** Called only after normalizer authenticates installation and workspace. */
export class SlackProjectionInput {
  constructor(readonly projections:Projections,readonly imports:ProjectionImports,readonly transport:CanonicalSlackTransport){}
  handle(raw:unknown):boolean {
    const parsed=rawMessage.safeParse(raw);if(!parsed.success)return false;
    const e=parsed.data,config=this.transport.mapper.config,s=this.projections.messages.store;
    const binding=s.db.prepare("SELECT id FROM projection_bindings WHERE provider='slack' AND workspace=? AND external_id=?").get(config.teamId,e.channel) as {id:string}|undefined;
    if(!binding)return false;
    if(e.type!=='message'&&e.type!=='app_mention')return true; // Membership never grants internal access.
    const source=e.subtype==='message_changed'?e.message:e,ts=e.subtype==='message_deleted'?e.deleted_ts:source?.ts;
    if(!source||!ts)return true;
    const old=s.db.prepare('SELECT root_external FROM projection_imports WHERE binding_id=? AND external_id=?').get(binding.id,ts) as {root_external:string}|undefined;
    const root=source.thread_ts??e.previous_message?.thread_ts??old?.root_external??ts;
    const revision=e.subtype==='message_changed'?(source.edited?.ts??e.event_ts??ts):e.subtype==='message_deleted'?(e.event_ts??ts):(source.edited?.ts??ts);
    const author=slackPrincipal(config,source.user,source.bot_id),metadata=source.metadata;
    if(metadata?.event_type==='mate_projection'&&typeof metadata.event_payload?.id==='string'&&typeof metadata.event_payload?.request_hash==='string'&&author.kind==='agent'&&e.subtype!=='message_deleted'){
      try{
        this.projections.confirm(metadata.event_payload.id,metadata.event_payload.request_hash,{publisher:author.id,locator:{provider:'slack',workspace:config.teamId,externalId:e.channel,messageId:ts},root,text:source.text??''});
        return true;
      }catch{s.audit('projection_evidence_rejected',{bindingId:binding.id,eventMessage:ts});}
    }
    const integer=(value:string)=>{slackTs.parse(value);const [whole,fraction]=value.split('.');return(BigInt(whole!)*1000000n+BigInt(fraction!.padEnd(6,'0'))).toString();};
    this.imports.receive({bindingId:binding.id,externalId:ts,externalRoot:root,revision:integer(revision),order:integer(ts),occurredAt:Number(BigInt(integer(ts))/1000n),author,text:source.text??'',deleted:e.subtype==='message_deleted',mentions:[...new Set([...((source.text??'').matchAll(/<@(U[A-Z0-9]+)>/g))].map(match=>match[1]!))].map(user=>slackPrincipal(config,user)),attachments:(source.files??[]).map(file=>Object.fromEntries(Object.entries(file).filter(([,value])=>value!==undefined))) as {id:string}[]});
    return true;
  }
}
