import {z} from 'zod';
import type {Conversations as Messages} from './messages.js';
import {conversationTargetSchema as targetSchema,type ConversationTarget as Target} from '../domain/conversations.js';
import {encode} from '../storage/store.js';
export interface ReviewSeat{agent_id:string;target:string;brief:string;workspace:string;active:number}
export class ReviewSeats{
 constructor(readonly messages:Messages,readonly owners:readonly string[]){}
 active(actor:string):ReviewSeat|undefined{return this.messages.store.db.prepare('SELECT * FROM review_seats WHERE agent_id=? AND active=1').get(actor) as ReviewSeat|undefined;}
 activate(owner:string,actor:string,target:Target,brief:string,verifyCleanWorkspace:(actor:string)=>string):void{
  const s=this.messages.store;if(!this.owners.includes(owner))throw new Error('Owner only');targetSchema.parse(target);z.string().min(1).max(20000).parse(brief);this.messages.requireAccess(actor,target.conversationId);
  s.atomic(()=>{
   if(s.db.prepare('SELECT 1 FROM outbox WHERE agent_id=?').get(actor)||s.db.prepare('SELECT 1 FROM runs WHERE agent_id=?').get(actor)||s.db.prepare("SELECT 1 FROM entries e JOIN sessions se ON se.id=e.session_id WHERE se.agent_id=? AND e.key NOT LIKE 'initial:%'").get(actor)||s.db.prepare('SELECT 1 FROM snapshots sp JOIN sessions se ON se.id=sp.session_id WHERE se.agent_id=?').get(actor))throw new Error('Review seat requires an unused identity with clean context');
   const workspace=verifyCleanWorkspace(actor);
   if(s.db.prepare('SELECT 1 FROM review_seats WHERE agent_id=?').get(actor))throw new Error('Use a new reviewer identity for another independent seat');
   s.db.prepare('INSERT INTO review_seats VALUES(?,?,?,?,1)').run(actor,encode(target),brief,workspace);
   this.messages.writes.mutable('review_seats',actor);
   s.audit('review_seat_activated',{owner,actor,target,workspace,baseline:'unused identity; daemon-verified empty private workspace; owner-provided role and brief'});
  });
 }
 release(owner:string,actor:string):void{
  if(!this.owners.includes(owner))throw new Error('Owner only');
  this.messages.store.db.prepare('UPDATE review_seats SET active=0 WHERE agent_id=?').run(actor);
  this.messages.store.audit('review_seat_released',{owner,actor});
 }
}
