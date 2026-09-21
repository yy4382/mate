import {z} from 'zod';
import type {ConversationHistory} from '../conversations/history.js';
import type {SessionLifecycle} from './sessions.js';
import type {MessageTasks} from '../coordination/messages.js';
import type {CanonicalFreshnessGate} from '../conversations/freshness.js';
import type {RunToken} from '../storage/store.js';
import type {Collaboration} from '../collaboration/service.js';
import type {Broker} from '../policy/broker.js';
import type {ConversationDirectory} from '../conversations/directory.js';

export type WorkPolicy='none'|'current'|'task'|'reminder'|'select'|'broker-managed';
export type SeatPolicy='deny'|'redacted-read'|'clean-workspace'|'held-send';
export type EffectPolicy='pure-read'|'atomic-recorded'|'broker-recorded'|'adapter-recorded';
export type ReplayPolicy='immutable'|'refreshable'|'boundary-owned';

export interface AdditionalTools {
  environment?(actor:string):unknown;
  attachment?(run:RunToken,workId:string,actionId:string,args:import('../capabilities/artifacts.js').AttachmentArgs,signal:AbortSignal):Promise<unknown>;
  research(url:string,signal:AbortSignal):Promise<unknown>;
  publish(run:RunToken,workId:string,actionId:string,args:import('../capabilities/artifacts.js').PublishArgs,signal:AbortSignal):Promise<unknown>;
}

export interface ToolExecutionContext{
  operation:string;run:RunToken;workId:string;requestWorkId:string;actionId:string;signal:AbortSignal;
  collaboration:Collaboration;broker:Broker;additional?:AdditionalTools;directory?:ConversationDirectory;
  history:ConversationHistory;sessions:SessionLifecycle;coordination:MessageTasks;gate:CanonicalFreshnessGate;
  provision?:(actor:string,workId:string)=>void;
}
export interface ToolHandlerResult{value:unknown;wait?:boolean}
interface ToolSpecBase{
  name:string;schema:z.ZodType;description:string;
  workPolicy:WorkPolicy;seatPolicy:SeatPolicy;effectPolicy:EffectPolicy;replayPolicy:ReplayPolicy;
  authorize:(context:ToolExecutionContext,args:any)=>void;
  postAwait:(context:ToolExecutionContext)=>void;
}
export interface AtomicToolSpec extends ToolSpecBase{effectPolicy:'atomic-recorded';replayPolicy:'immutable'|'refreshable';handler:(context:ToolExecutionContext,args:any)=>ToolHandlerResult}
export interface BoundaryToolSpec extends ToolSpecBase{effectPolicy:'pure-read'|'broker-recorded'|'adapter-recorded';replayPolicy:'boundary-owned';handler:(context:ToolExecutionContext,args:any)=>ToolHandlerResult|Promise<ToolHandlerResult>}
export type ToolSpec=AtomicToolSpec|BoundaryToolSpec;
export interface ToolModule{domain:string;specs:readonly ToolSpec[]}

export const id=z.string().min(1).max(500),text=z.string().max(35000);
export const messageRef=z.object({messageId:id}).strict();
export const noAuthorize=():void=>{};
export function fence(context:ToolExecutionContext):void{context.collaboration.store.assertRun(context.run);context.signal.throwIfAborted();}

/** Recheck all object references carried by an operation before replay or execution. */
export function authorizeReferences(context:ToolExecutionContext,args:Record<string,any>):void{
  const c=context.collaboration,actor=context.run.agentId,s=c.store;
  if(args.taskId)c.board.read(actor,args.taskId);
  if(args.message)c.messages.message(actor,args.message.messageId);
  if(args.anchor)c.messages.message(actor,args.anchor.messageId);
  if(args.reminderId)c.reminders.read(actor,args.reminderId);
  if(args.scheduleId)c.reminders.read(actor,args.scheduleId);
  if(args.target)c.messages.requireAccess(actor,args.target.conversationId);
  if(args.conversationId&&!['conversations.capabilities','conversations.join','conversations.leave','conversations.refresh'].includes(context.operation))c.messages.requireAccess(actor,args.conversationId);
  if(args.deliveryId){const delivery=s.delivery(args.deliveryId);if(delivery.agent_id!==actor)throw new Error('Private inbox');const target=JSON.parse(delivery.payload).target;if(target)c.messages.requireAccess(actor,target.conversationId);}
}

export function spec(input:ToolSpec):ToolSpec{return Object.freeze(input);}
