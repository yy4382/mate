import {randomUUID}from 'node:crypto';
import {CronExpressionParser}from 'cron-parser';
import {z}from 'zod';
import type {Collaboration}from '../collaboration/service.js';
import {encode}from '../storage/store.js';
import {messageKey,targetSchema,type Target}from '../conversations/messages.js';
export interface Reminder{id:string;agent_id:string;work_id:string;task_id:string|null;target:string;next_at:number;cron:string|null;timezone:string;active:number;content:string;anchor:string|null;version:number;legacy:number}
export interface ReminderInput{target:Target;content:string;nextAt:number;timezone:string;cron?:string|undefined;taskId?:string|undefined;anchor?:{channel:string;ts:string}|undefined}
export class Reminders{
 constructor(readonly c:Collaboration){}
 private validate(actor:string,input:ReminderInput):void{
  targetSchema.parse(input.target);this.c.messages.requireAccess(actor,input.target.channel);z.string().min(1).max(12000).parse(input.content);if(!input.content.trim())throw new Error('Reminder purpose required');
  z.number().int().nonnegative().max(8640000000000000).parse(input.nextAt);new Intl.DateTimeFormat('en',{timeZone:input.timezone});if(input.cron)CronExpressionParser.parse(input.cron,{currentDate:input.nextAt,tz:input.timezone}).next();
  if(input.taskId)this.c.messages.requireAccess(actor,JSON.parse(this.c.task(input.taskId).target).channel);
  if(input.anchor){this.c.messages.requireAccess(actor,input.anchor.channel);if(!this.c.store.db.prepare('SELECT 1 FROM messages m JOIN message_visibility v ON v.key=m.key WHERE v.agent_id=? AND m.key=? AND m.deleted=0').get(actor,messageKey({team:this.c.config.teamId,...input.anchor})))throw new Error('Reminder anchor is not visible');}
 }
 private event(r:Reminder,kind:string,payload:unknown):void{this.c.store.db.prepare('INSERT INTO reminder_events(reminder_id,version,kind,at,payload) VALUES(?,?,?,?,?)').run(r.id,r.version,kind,Date.now(),encode(payload));}
 read(actor:string,id:string):Reminder{const r=this.c.store.db.prepare('SELECT * FROM schedules WHERE id=? AND agent_id=?').get(id,actor) as Reminder|undefined;if(!r)throw new Error('Unknown owned reminder');this.c.messages.persistence.records.mutableTarget('schedules',id);this.c.messages.requireAccess(actor,JSON.parse(r.target).channel);return r;}
 list(actor:string,before=Number.MAX_SAFE_INTEGER):(Reminder&{cursor:number})[]{const rows=this.c.store.db.prepare("SELECT r.*,r.rowid cursor FROM schedules r JOIN canonical_targets ct ON ct.object_type='schedules' AND ct.object_id=r.id JOIN channel_access a ON a.agent_id=r.agent_id AND a.channel=ct.conversation_id AND a.active=1 WHERE r.agent_id=? AND r.rowid<? ORDER BY r.rowid DESC LIMIT 100").all(actor,before) as (Reminder&{cursor:number})[];for(const row of rows)this.c.messages.persistence.records.mutableTarget('schedules',row.id);return rows;}
 create(actor:string,workId:string,input:ReminderInput):Reminder{
  this.c.active(workId);this.validate(actor,input);const s=this.c.store,id=randomUUID();return s.atomic(()=>{
   s.db.prepare('INSERT INTO schedules(id,agent_id,work_id,task_id,target,next_at,cron,timezone,content,anchor,legacy) VALUES(?,?,?,?,?,?,?,?,?,?,0)').run(id,actor,workId,input.taskId??null,encode(input.target),input.nextAt,input.cron??null,input.timezone,input.content,input.anchor?encode(input.anchor):null);
   this.c.messages.persistence.writes.mutable('schedules',id);
   const reminder=this.read(actor,id);this.event(reminder,'created',{budgetPolicy:'persistent_agent_account_and_bound_work_cap'});return reminder;
  });
 }
 edit(actor:string,id:string,expectedVersion:number,input:ReminderInput):unknown{
  return this.c.store.atomic(()=>{const r=this.read(actor,id);if(r.version!==expectedVersion)throw new Error('Reminder version conflict');this.c.active(r.work_id);this.validate(actor,input);
   this.c.store.db.prepare('UPDATE schedules SET target=?,content=?,next_at=?,timezone=?,cron=?,task_id=?,anchor=?,active=1,version=version+1,legacy=0 WHERE id=?').run(encode(input.target),input.content,input.nextAt,input.timezone,input.cron??null,input.taskId??null,input.anchor?encode(input.anchor):null,id);
   this.c.messages.persistence.writes.mutable('schedules',id);
   const updated=this.read(actor,id);this.event(updated,'edited',{previousVersion:r.version});return{reminder:updated,previousFirings:this.firings(id)};
  });
 }
 cancel(actor:string,id:string,expectedVersion:number,cancelPending=false):unknown{
  return this.c.store.atomic(()=>{const r=this.read(actor,id);if(r.version!==expectedVersion)throw new Error('Reminder version conflict');
   this.c.store.db.prepare('UPDATE schedules SET active=0,version=version+1 WHERE id=?').run(id);
   const withdrawn:string[]=[];
   let withdrawnCount=0;
   if(cancelPending){const pending=this.c.store.db.prepare("SELECT d.id FROM deliveries d JOIN reminder_firings f ON f.delivery_id=d.id WHERE f.reminder_id=? AND d.status='pending' AND NOT EXISTS(SELECT 1 FROM runs run WHERE run.delivery_id=d.id AND run.state='active') LIMIT 100").all(id) as {id:string}[];withdrawn.push(...pending.map(row=>row.id));withdrawnCount=this.c.store.db.prepare("UPDATE deliveries SET status='handled' WHERE status='pending' AND NOT EXISTS(SELECT 1 FROM runs run WHERE run.delivery_id=deliveries.id AND run.state='active') AND id IN(SELECT delivery_id FROM reminder_firings WHERE reminder_id=?)").run(id).changes;}
   const updated=this.read(actor,id);this.event(updated,'cancelled',{futureCancelled:true,withdrawn,withdrawnCount,inFlightNotCancelled:this.ongoing(id)});
   return{reminder:updated,futureCancelled:true,withdrawn,withdrawnCount,inFlightNotCancelled:this.ongoing(id),previousFirings:this.firings(id)};
  });
 }
 private ongoing(id:string):string[]{return(this.c.store.db.prepare("SELECT d.id FROM deliveries d JOIN reminder_firings f ON f.delivery_id=d.id WHERE f.reminder_id=? AND (d.status='injected' OR EXISTS(SELECT 1 FROM runs run WHERE run.delivery_id=d.id AND run.state='active'))").all(id) as {id:string}[]).map(row=>row.id);}
 private firings(id:string):{delivery_id:string;status:string;due_at:number;version:number;running:number}[]{return this.c.store.db.prepare("SELECT f.delivery_id,d.status,f.due_at,f.version,EXISTS(SELECT 1 FROM runs run WHERE run.delivery_id=d.id AND run.state='active') running FROM reminder_firings f JOIN deliveries d ON d.id=f.delivery_id WHERE f.reminder_id=? ORDER BY f.rowid DESC LIMIT 100").all(id) as any;}
 log(actor:string,id:string,before?:number):unknown{this.read(actor,id);return{events:this.c.store.db.prepare('SELECT * FROM reminder_events WHERE reminder_id=? AND seq<? ORDER BY seq DESC LIMIT 50').all(id,before??Number.MAX_SAFE_INTEGER),firings:this.firings(id)};}
 cancelWork(workId:string):void{for(const r of this.c.store.db.prepare('SELECT * FROM schedules WHERE work_id=? AND active=1').all(workId) as Reminder[]){this.c.store.db.prepare('UPDATE schedules SET active=0,version=version+1 WHERE id=?').run(r.id);this.event({...r,version:r.version+1},'owner_work_cancelled',{});}}
 tick(now:number):void{
  const c=this.c,s=c.store;for(const actor of c.config.agents)c.ledger.account(actor.id);
  const due=s.db.prepare("SELECT r.* FROM schedules r JOIN works w ON w.id=r.work_id JOIN agents a ON a.id=r.agent_id JOIN budget_accounts b ON b.agent_id=r.agent_id JOIN canonical_targets ct ON ct.object_type='schedules' AND ct.object_id=r.id JOIN channel_access acl ON acl.agent_id=r.agent_id AND acl.channel=ct.conversation_id AND acl.active=1 WHERE r.active=1 AND r.next_at<=? AND w.state='active' AND a.paused=0 AND b.runs<b.max_runs AND b.tokens<b.max_tokens AND b.cost<b.max_cost AND w.runs<w.max_runs AND w.tokens<w.max_tokens AND w.cost<w.max_cost ORDER BY r.next_at,r.id LIMIT 100").all(now) as Reminder[];
  for(const r of due){c.messages.persistence.records.mutableTarget('schedules',r.id);const target=JSON.parse(r.target) as Target;if(!c.messages.access(r.agent_id,target.channel))continue;
   const account=c.ledger.account(r.agent_id),work=c.work(r.work_id);if(account.runs>=account.max_runs||account.tokens>=account.max_tokens||account.cost>=account.max_cost||work.runs>=work.max_runs||work.tokens>=work.max_tokens||work.cost>=work.max_cost)continue;
   const firing=`reminder:${r.id}:${r.version}:${r.next_at}`;
   const delivery=c.enqueue(r.agent_id,r.work_id,firing,{kind:'reminder',reminderId:r.id,version:r.version,content:r.content,taskId:r.task_id,anchor:r.anchor?JSON.parse(r.anchor):null,target,dueAt:r.next_at,receivedAt:now,budgetPolicy:'persistent_agent_account_and_bound_work_cap'});
   // Fixed harness receipt only. The model-written reminder body stays in its author's inbox.
   const output=`${firing}:receipt`;c.messages.persistence.writes.queueOutput(r.agent_id,output,{target,text:`Reminder ${r.id} fired for ${r.agent_id} (version ${r.version}, due ${new Date(r.next_at).toISOString()}).`});s.db.prepare('INSERT INTO output_work VALUES(?,?)').run(output,r.work_id);s.db.prepare("INSERT INTO system_projections VALUES(?,'reminder',?,?)").run(output,r.id,r.version);c.output.gate?.queued(r.agent_id,output);
   s.db.prepare('INSERT INTO reminder_firings VALUES(?,?,?,?,?,?)').run(firing,r.id,r.next_at,r.version,delivery,output);
   if(r.cron)s.db.prepare('UPDATE schedules SET next_at=?,version=version+1 WHERE id=?').run(CronExpressionParser.parse(r.cron,{currentDate:now,tz:r.timezone}).next().getTime(),r.id);
   else s.db.prepare('UPDATE schedules SET active=0,version=version+1 WHERE id=?').run(r.id);
   this.event({...r,version:r.version+1},'fired',{dueAt:r.next_at,deliveryId:delivery,outputId:output,catchUp:'coalesce_to_one'});
  }
 }
}
