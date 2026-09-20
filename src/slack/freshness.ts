import {randomUUID} from 'node:crypto';
import type {RunToken} from '../storage/store.js';
import {encode} from '../storage/store.js';
import type {Attention} from './attention.js';
import {targetSchema,type Target,type Messages} from './messages.js';
export interface SendBasis {run:RunToken;viewToken?:string|undefined;systemProjection?:boolean}
interface Draft{id:string;agent_id:string;outbox_id:string;revision:number;hold_id:string|null;reason:string|null;accepted_revision:number|null;continue_until:number}
/** Freshness never evaluates message quality or command execution. */
export class FreshnessGate{
 constructor(readonly messages:Messages,readonly attention:Attention,readonly clock:()=>number=Date.now){}
 private draft(actor:string,id:string):Draft{
  const d=this.messages.store.db.prepare('SELECT * FROM drafts WHERE id=?').get(id) as Draft|undefined;
  if(!d||d.agent_id!==actor)throw new Error('Unknown owned draft');
  this.messages.requireAccess(actor,this.request(d).target.channel);return d;
 }
 private request(d:Draft):{target:Target;text:string}{return JSON.parse(this.messages.store.output(d.outbox_id)!.request);}
 describe(actor:string,id:string):unknown{const d=this.draft(actor,id);return{draftId:d.id,revision:d.revision,status:this.messages.store.output(d.outbox_id)!.state,holdId:d.hold_id,reason:d.reason,...this.request(d),choices:['retry_with_view','revise','discard','continue_once']};}
 list(actor:string):unknown[]{return(this.messages.store.db.prepare("SELECT d.id FROM drafts d JOIN outbox o ON o.id=d.outbox_id JOIN channel_access a ON a.agent_id=d.agent_id AND a.channel=json_extract(o.request,'$.target.channel') WHERE d.agent_id=? AND a.active=1 AND o.state IN ('held','pending','unknown') ORDER BY d.rowid DESC LIMIT 50").all(actor) as {id:string}[]).map(d=>this.describe(actor,d.id));}
 queued(actor:string,id:string,basis?:SendBasis):void{
  const s=this.messages.store;if(s.db.prepare('SELECT 1 FROM drafts WHERE outbox_id=?').get(id))return;
  if(basis)s.assertRun(basis.run);
  const output=s.output(id)!,request=JSON.parse(output.request) as {target:Target};
  const valid=!!basis&&basis.run.agentId===actor&&(basis.systemProjection===true||this.attention.valid(basis.run,request.target,basis.viewToken));
  s.db.prepare('INSERT INTO drafts(id,agent_id,outbox_id,accepted_revision) VALUES(?,?,?,?)').run(id,actor,id,valid?this.attention.revision(request.target,actor):null);
  if(!valid)this.hold(this.draft(actor,id),basis?.viewToken?'view_missing_or_changed':'baseline_unknown');
 }
 private hold(d:Draft,reason:string):void{
  const s=this.messages.store,state=s.output(d.outbox_id)!.state;
  if(state==='pending')s.transitionOutput(d.outbox_id,'pending','held');
  else if(state!=='held')throw new Error('Draft cannot be held');
  s.db.prepare('UPDATE drafts SET hold_id=?,reason=?,continue_until=0 WHERE id=?').run(randomUUID(),reason,d.id);
 }
 private editable(run:RunToken,id:string,revision:number,requireActive=true):Draft{
  const s=this.messages.store;s.assertRun(run);const d=this.draft(run.agentId,id);
  if(d.revision!==revision||s.output(d.outbox_id)?.state!=='held')throw new Error('Draft version or state conflict');
  const work=s.db.prepare('SELECT w.state FROM output_work ow JOIN works w ON w.id=ow.work_id WHERE ow.output_id=?').get(d.outbox_id) as {state:string}|undefined;
  if(requireActive&&work&&work.state!=='active')throw new Error('Draft work paused or cancelled');return d;
 }
 retry(run:RunToken,id:string,revision:number,viewToken?:string):unknown{
  const s=this.messages.store;return s.atomic(()=>{const d=this.editable(run,id,revision),request=this.request(d);
   if(!this.attention.valid(run,request.target,viewToken))this.hold(d,'view_missing_or_changed');
   else{s.transitionOutput(d.outbox_id,'held','pending');s.db.prepare('UPDATE drafts SET accepted_revision=?,hold_id=NULL,reason=NULL,continue_until=0 WHERE id=?').run(this.attention.revision(request.target,run.agentId),id);}
   return this.describe(run.agentId,id);
  });
 }
 continueOnce(run:RunToken,id:string,revision:number,holdId:string):unknown{
  const s=this.messages.store;return s.atomic(()=>{const d=this.editable(run,id,revision);if(d.hold_id!==holdId)throw new Error('Hold receipt changed');
   s.transitionOutput(d.outbox_id,'held','pending');s.db.prepare('UPDATE drafts SET accepted_revision=?,continue_until=?,hold_id=NULL,reason=NULL WHERE id=?').run(null,this.clock()+60000,id);
   s.audit('freshness_continue_once',{actor:run.agentId,draftId:id,revision,holdId,expiresAt:this.clock()+60000});return this.describe(run.agentId,id);
  });
 }
 revise(run:RunToken,id:string,revision:number,text:string,target?:Target):unknown{
  const s=this.messages.store;return s.atomic(()=>{const d=this.editable(run,id,revision,false),request=this.request(d);target=target??request.target;targetSchema.parse(target);this.messages.requireAccess(run.agentId,target.channel);
   if(!text.trim()||text.length>35000)throw new Error('Invalid message text');
   s.transitionOutput(d.outbox_id,'held','failed',{reason:'draft_revised'});const next=`${id}:revision:${revision+1}`;s.queueOutput(run.agentId,next,{target,text});
   s.db.prepare('INSERT INTO output_work SELECT ?,work_id FROM output_work WHERE output_id=?').run(next,d.outbox_id);
   const linked=s.db.prepare("SELECT assigned_to FROM tasks WHERE outbox_id=? AND status='draft'").all(d.outbox_id) as {assigned_to:string|null}[];
   for(const task of linked)if(task.assigned_to)this.messages.requireAccess(task.assigned_to,target.channel);
   s.db.prepare("UPDATE tasks SET outbox_id=?,target=?,version=version+1 WHERE outbox_id=? AND status='draft'").run(next,encode(target),d.outbox_id);
   s.db.prepare('UPDATE drafts SET revision=revision+1,outbox_id=?,accepted_revision=NULL WHERE id=?').run(next,id);this.hold(this.draft(run.agentId,id),'draft_revised');return this.describe(run.agentId,id);
  });
 }
 discard(run:RunToken,id:string,revision:number):unknown{const d=this.editable(run,id,revision,false);this.messages.store.transitionOutput(d.outbox_id,'held','failed',{reason:'draft_discarded'});return this.describe(run.agentId,id);}
 /** Called immediately before Slack dispatch, under Output's serialization queue. */
 dispatch(id:string):boolean{
  const s=this.messages.store,d=s.db.prepare('SELECT * FROM drafts WHERE outbox_id=?').get(id) as Draft|undefined;
  if(!d)throw new Error('Output lacks freshness basis');
  const target=this.request(d).target;this.messages.requireAccess(d.agent_id,target.channel);
  if(s.db.prepare('SELECT 1 FROM task_projections WHERE output_id=?').get(id))return true;
  if(d.continue_until>this.clock()||d.accepted_revision===this.attention.revision(target,d.agent_id))return true;
  s.atomic(()=>{this.hold(d,'discussion_changed_before_dispatch');
   const delivery=s.enqueue(d.agent_id,`draft-held:${id}:${this.attention.revision(target,d.agent_id)}`,{kind:'draft_held',draftId:d.id,target},50);
   s.db.prepare('INSERT INTO delivery_work SELECT ?,work_id FROM output_work WHERE output_id=? ON CONFLICT DO NOTHING').run(delivery,id);
  });return false;
 }
 // Used for legacy queued output on startup: never silently grant a fresh baseline.
 adoptPending():void{const s=this.messages.store;for(const row of s.db.prepare("SELECT id,agent_id FROM outbox WHERE state='pending' AND id NOT IN(SELECT outbox_id FROM drafts)").all() as {id:string;agent_id:string}[]){if(this.messages.access(row.agent_id,JSON.parse(s.output(row.id)!.request).target.channel))this.queued(row.agent_id,row.id);}}
}
