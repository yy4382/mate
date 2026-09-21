import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {encode,hash} from '../storage/store.js';
import type {ExternalConversation,ExternalMessage} from '../domain/conversations.js';
import type {Principal} from '../domain/messages.js';
import type {Conversations} from './messages.js';
import type {DispatchFailure} from './output.js';

export interface ProjectionBinding extends ExternalConversation {id:string;conversationId:string;publisher:string;enabled:boolean;imports:Principal[]}
export interface ProjectionWire {text:string;target:ExternalConversation;thread?:string}
export interface ProjectionDispatch {id:string;publisher:string;wire:ProjectionWire;requestHash:string}
export interface ProjectionEvidence {publisher:string;locator:ExternalMessage;root:string;text:string}
export interface ProjectionTransport {
  prepare(binding:ProjectionBinding,text:string,thread?:string):ProjectionWire;
  authorized(binding:ProjectionBinding):Promise<boolean>;
  post(request:ProjectionDispatch):Promise<ProjectionEvidence>;
  classify(error:unknown):DispatchFailure;
  matchesText?(expected:string,observed:string):boolean;
}
export interface Projection {id:string;binding_id:string;message_id:string;source_revision:string;text:string;anchor:number;state:string;reason:string|null;wire:string|null;request_hash:string|null;receipt:string|null;retry_at:number;drift:string|null}

/** Canonical commit never waits on this independent presentation outbox. */
export class Projections {
  private scanAfter=0;
  private serial:Promise<unknown>=Promise.resolve();
  constructor(readonly messages:Conversations,readonly transports:ReadonlyMap<string,ProjectionTransport>,readonly clock:()=>number=Date.now){}
  binding(id:string):ProjectionBinding {
    const row=this.messages.store.db.prepare('SELECT p.*,b.conversation_id FROM projection_bindings p JOIN conversation_bindings b USING(provider,workspace,external_id) WHERE p.id=?').get(id) as {id:string;provider:string;workspace:string;external_id:string;conversation_id:string;publisher:string;enabled:number;imports:string}|undefined;
    if(!row)throw new Error('Unknown projection binding');return{id:row.id,provider:row.provider,workspace:row.workspace,externalId:row.external_id,conversationId:row.conversation_id,publisher:row.publisher,enabled:!!row.enabled,imports:JSON.parse(row.imports)};
  }
  /** Trusted owner configuration only; never exposed as a model tool. */
  configure(conversationId:string,locator:ExternalConversation,publisher:string,imports:Principal[],disclose:boolean):string {
    const m=this.messages,s=m.store;if(disclose!==true)throw new Error('Explicit projection disclosure authorization required');
    if(!this.transports.has(locator.provider))throw new Error('Projection adapter unavailable');
    if(m.references.conversation(conversationId).authority!=='internal')throw new Error('Projection requires internal authority');
    m.requireAccess(publisher,conversationId);
    for(const principal of imports){
      if(principal.kind!=='human'&&principal.kind!=='agent')throw new Error('Unsupported import principal');
      if(!s.db.prepare('SELECT 1 FROM internal_members WHERE conversation_id=? AND kind=? AND principal_id=?').get(conversationId,principal.kind,principal.id))throw new Error('Import principal is not an internal member');
    }
    return s.atomic(()=>{
      m.references.bindConversation(locator,conversationId,'projection');
      const id=randomUUID();s.db.prepare('INSERT INTO projection_bindings VALUES(?,?,?,?,?,1,?)').run(id,locator.provider,locator.workspace,locator.externalId,publisher,encode(imports));
      s.audit('projection_disclosure_authorized',{bindingId:id,conversationId,locator,publisher,imports});return id;
    });
  }
  setEnabled(id:string,enabled:boolean):void {
    this.binding(id);this.messages.store.atomic(()=>{
      this.messages.store.db.prepare('UPDATE projection_bindings SET enabled=? WHERE id=?').run(Number(enabled),id);
      this.messages.store.audit('projection_enabled',{bindingId:id,enabled});
    });
  }
  get(id:string):Projection {
    const row=this.messages.store.db.prepare('SELECT * FROM projection_outbox WHERE id=?').get(id) as Projection|undefined;
    if(!row)throw new Error('Unknown projection');return row;
  }
  list(actor:string,conversationId:string):Projection[] {
    this.messages.requireReadable(actor);this.messages.requireAccess(actor,conversationId);
    return this.messages.store.db.prepare('SELECT p.* FROM projection_outbox p JOIN message_identities m ON m.id=p.message_id JOIN message_visibility v ON v.key=m.id WHERE m.conversation_id=? AND v.agent_id=? ORDER BY p.rowid DESC LIMIT 100').all(conversationId,actor) as Projection[];
  }
  /** Only owner authorization may disclose that an old root exists; never includes old text. */
  anchor(bindingId:string,rootId:string):string {
    const b=this.binding(bindingId),m=this.messages,s=m.store,root=m.references.message(rootId);
    if(!b.enabled||root.conversationId!==b.conversationId||root.rootId!==root.id)throw new Error('Invalid projection anchor');
    m.requireAccess(b.publisher,b.conversationId);
    return s.atomic(()=>{
      const old=s.db.prepare('SELECT id FROM projection_outbox WHERE binding_id=? AND message_id=?').get(bindingId,rootId) as {id:string}|undefined;
      if(old)return old.id;
      const id=randomUUID();s.db.prepare("INSERT INTO projection_outbox(id,binding_id,message_id,source_revision,text,anchor,state) VALUES(?,?,?,'0','Earlier conversation; content not shared.',1,'pending')").run(id,bindingId,rootId);
      s.audit('projection_anchor_authorized',{bindingId,rootId});return id;
    });
  }
  recover():void {this.messages.store.db.prepare("UPDATE projection_outbox SET state='unknown',reason='restart_during_dispatch' WHERE state='sending'").run();}
  private held(row:Projection,reason:string):void {this.messages.store.db.prepare("UPDATE projection_outbox SET state='held',reason=? WHERE id=? AND state IN ('pending','held')").run(reason,row.id);}
  private target(row:Projection,b:ProjectionBinding):{thread?:string;reason?:string} {
    const m=this.messages,identity=m.references.message(row.message_id);
    if(identity.rootId===identity.id)return{};
    if(!identity.rootId)return{reason:'root_identity_missing'};
    const root=m.references.messageBinding(identity.rootId,b.provider,b.workspace,b.externalId);
    if(root)return{thread:root.messageId};
    const parent=m.store.db.prepare('SELECT state FROM projection_outbox WHERE binding_id=? AND message_id=?').get(b.id,identity.rootId) as {state:string}|undefined;
    return{reason:!parent?'missing_historical_root':parent.state==='failed'?'root_failed':parent.state==='unknown'?'root_unknown':'waiting_root_receipt'};
  }
  private valid(row:Projection,b:ProjectionBinding):boolean {
    if(!b.enabled){this.held(row,'binding_disabled');return false;}
    if(!this.messages.access(b.publisher,b.conversationId)){this.held(row,'publisher_access_revoked');return false;}
    const message=this.messages.records.message(row.message_id);
    if(!row.anchor&&(!message||message.deleted||message.revision!==row.source_revision)){
      this.messages.store.db.prepare("UPDATE projection_outbox SET state='failed',reason='source_changed_before_publication' WHERE id=? AND state IN ('pending','held')").run(row.id);return false;
    }
    return true;
  }
  async flush(limit=20):Promise<void>{
    z.number().int().min(1).max(1000).parse(limit);
    // Bounded round-robin scan: held dependencies cannot starve unrelated bindings.
    const rows=this.messages.store.db.prepare("SELECT rowid seq,id FROM projection_outbox WHERE state IN ('pending','held') AND retry_at<=? AND rowid>? ORDER BY rowid LIMIT 100").all(this.clock(),this.scanAfter) as {seq:number;id:string}[];
    if(!rows.length){this.scanAfter=0;return;}
    let sent=0;for(const row of rows){this.scanAfter=row.seq;await this.send(row.id);if(['sending','sent','unknown'].includes(this.get(row.id).state))sent++;if(sent>=limit)break;}
  }
  send(id:string):Promise<void>{const next=this.serial.then(()=>this.sendNow(id));this.serial=next.catch(()=>{});return next;}
  private async sendNow(id:string):Promise<void>{
    const s=this.messages.store,row=this.get(id);if(!['pending','held'].includes(row.state)||row.retry_at>this.clock())return;
    const b=this.binding(row.binding_id);if(!this.valid(row,b))return;
    const location=this.target(row,b);if(location.reason){this.held(row,location.reason);return;}
    if(s.db.prepare("SELECT 1 FROM projection_outbox WHERE binding_id=? AND id!=? AND state IN ('sending','unknown')").get(b.id,id)){this.held(row,'prior_outcome_unknown');return;}
    const transport=this.transports.get(b.provider);if(!transport){this.held(row,'adapter_unavailable');return;}
    let authorized:boolean;try{authorized=await transport.authorized(b);}catch{this.held(row,'publisher_permission_unavailable');return;}
    if(!this.valid(row,this.binding(b.id)))return;
    if(!authorized){this.held(row,'publisher_external_access_denied');return;}
    const current=this.get(id);if(!['pending','held'].includes(current.state))return;
    const wire:ProjectionWire=current.wire?JSON.parse(current.wire):transport.prepare(b,row.text,location.thread);
    if(wire.text!==row.text||wire.target.provider!==b.provider||wire.target.workspace!==b.workspace||wire.target.externalId!==b.externalId||wire.thread!==location.thread)throw new Error('Projection wire mismatch');
    const requestHash=current.request_hash??hash(encode({id,publisher:b.publisher,wire}));
    s.db.prepare("UPDATE projection_outbox SET wire=?,request_hash=?,state='sending',reason=NULL WHERE id=?").run(encode(wire),requestHash,id);
    try{const evidence=await transport.post({id,publisher:b.publisher,wire,requestHash});this.confirm(id,requestHash,evidence);}
    catch(error){
      if(this.get(id).state==='sent')return;
      const failure=transport.classify(error);
      if(failure.kind==='retry'&&Number.isFinite(failure.afterMs))s.db.prepare("UPDATE projection_outbox SET state='pending',retry_at=?,reason='retry' WHERE id=?").run(this.clock()+Math.max(1,failure.afterMs),id);
      else if(failure.kind==='rejected')s.db.prepare("UPDATE projection_outbox SET state='failed',reason=? WHERE id=?").run(failure.reason,id);
      else s.db.prepare("UPDATE projection_outbox SET state='unknown',reason='publication_outcome_unknown' WHERE id=?").run(id);
    }
  }
  confirm(id:string,requestHash:string,evidence:ProjectionEvidence):void {
    const m=this.messages,s=m.store;s.atomic(()=>{
      const row=this.get(id),b=this.binding(row.binding_id),wire=row.wire?JSON.parse(row.wire) as ProjectionWire:undefined;
      if(!['sending','unknown','sent'].includes(row.state)||!wire||!row.request_hash||row.request_hash!==requestHash)throw new Error('Projection was not dispatched with this hash');
      const equal=this.transports.get(b.provider)?.matchesText??((a:string,c:string)=>a===c),l=evidence.locator;
      if(evidence.publisher!==b.publisher||l.provider!==b.provider||l.workspace!==b.workspace||l.externalId!==b.externalId||!equal(wire.text,evidence.text)||evidence.root!==(wire.thread??l.messageId))throw new Error('Projection confirmation mismatch');
      if(row.state==='sent'&&JSON.parse(row.receipt!).messageId!==l.messageId)throw new Error('Projection receipt conflict');
      m.references.bindMessage(l,row.message_id);
      s.db.prepare("UPDATE projection_outbox SET state='sent',reason=NULL,receipt=? WHERE id=?").run(encode({messageId:l.messageId,root:evidence.root}),id);
    });
  }
}
