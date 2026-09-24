import {z} from 'zod';
import {createHash} from 'node:crypto';
import {ConversationHistory,type HistorySource} from '../conversations/history.js';
import {SessionLifecycle} from './sessions.js';
import {buildBaseline} from './prompt.js';
import {MessageTasks} from '../coordination/messages.js';
import {CanonicalFreshnessGate as FreshnessGate} from '../conversations/freshness.js';
import type {RunToken} from '../storage/store.js';
import type {Collaboration} from '../collaboration/service.js';
import type {Broker} from '../policy/broker.js';
import type {ConversationDirectory} from '../conversations/directory.js';
import type {ToolReply} from './engine.js';
import {conversationHistoryModule} from './tool-modules/conversation-history.js';
import {coordinationRemindersModule} from './tool-modules/coordination-reminders.js';
import {sessionStatusModule} from './tool-modules/session-status.js';
import {capabilitiesModule} from './tool-modules/capabilities.js';
import {id,type AdditionalTools,type ToolExecutionContext,type ToolHandlerResult,type ToolModule,type ToolSpec} from './tool-contract.js';
export type {AdditionalTools,EffectPolicy,ReplayPolicy,SeatPolicy,ToolModule,ToolSpec,WorkPolicy} from './tool-contract.js';

const discoverySchemas={
  'tools.list':z.object({}).strict(),
  'tools.describe':z.object({name:id}).strict(),
  'tools.call':z.object({name:id,input:z.unknown()}).strict()
};
export const builtInToolModules:readonly ToolModule[]=Object.freeze([conversationHistoryModule,coordinationRemindersModule,sessionStatusModule,capabilitiesModule]);

function buildRegistry(modules:readonly ToolModule[]):Map<string,ToolSpec>{
  const registry=new Map<string,ToolSpec>(),domains=new Set<string>();
  const work=new Set(['none','current','task','reminder','select','broker-managed']),seat=new Set(['deny','redacted-read','clean-workspace','held-send']),effect=new Set(['pure-read','atomic-recorded','broker-recorded','adapter-recorded']),replay=new Set(['immutable','refreshable','boundary-owned']);
  for(const module of modules){
    if(!module.domain||!module.specs?.length||domains.has(module.domain))throw new Error('Invalid or duplicate tool module');domains.add(module.domain);
    for(const entry of module.specs){
      if(!/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(entry.name)||entry.name.startsWith('tools.')||registry.has(entry.name))throw new Error('Invalid, reserved or duplicate tool spec');
      if(typeof entry.schema?.parse!=='function'||!entry.description.trim()||!work.has(entry.workPolicy)||!seat.has(entry.seatPolicy)||!effect.has(entry.effectPolicy)||!replay.has(entry.replayPolicy)||typeof entry.authorize!=='function'||typeof entry.postAwait!=='function'||typeof entry.handler!=='function')throw new Error('Incomplete or unknown tool spec policy');
      if((entry.effectPolicy==='atomic-recorded')!==(entry.replayPolicy!=='boundary-owned'))throw new Error('Invalid effect and replay policy combination');
      if(entry.seatPolicy==='clean-workspace'&&(entry.workPolicy!=='broker-managed'||entry.effectPolicy!=='broker-recorded'))throw new Error('Invalid clean-workspace policy combination');
      if(entry.seatPolicy==='held-send'&&(entry.workPolicy!=='current'||entry.effectPolicy!=='atomic-recorded'))throw new Error('Invalid held-send policy combination');
      if(entry.seatPolicy==='redacted-read'&&(entry.effectPolicy==='broker-recorded'||entry.effectPolicy==='adapter-recorded'))throw new Error('Invalid redacted-read policy combination');
      registry.set(entry.name,Object.freeze({...entry}));
    }
  }
  return registry;
}

const builtInRegistry=buildRegistry(builtInToolModules);
export const builtInToolSpecs:readonly ToolSpec[]=Object.freeze([...builtInRegistry.values()]);
export function validateToolModules(modules:readonly ToolModule[]):readonly ToolSpec[]{return Object.freeze([...buildRegistry(modules).values()]);}
export function fingerprintToolSpecs(specs:readonly ToolSpec[]):string{return createHash('sha256').update(JSON.stringify({format:'mate.tool-contract.v1',operations:specs.map(({name,description,workPolicy,seatPolicy,effectPolicy,replayPolicy,schema})=>({name,description,workPolicy,seatPolicy,effectPolicy,replayPolicy,inputSchema:z.toJSONSchema(schema)})),discovery:Object.entries(discoverySchemas).map(([name,schema])=>({name,inputSchema:z.toJSONSchema(schema)}))})).digest('hex');}
export const operationContractFingerprint=fingerprintToolSpecs(builtInToolSpecs);
export const operationDocumentation=`Use tools.list to discover capabilities and tools.describe with {name} for exact schemas. Call the named operation directly, or tools.call with {name,input}. Tool contract: ${operationContractFingerprint}. Available: ${builtInToolSpecs.map(entry=>entry.name).join(', ')}.\n`+Object.entries(discoverySchemas).map(([name,schema])=>`${name}: ${JSON.stringify(z.toJSONSchema(schema))}`).join('\n');

function isPromise(value:unknown):value is Promise<unknown>{return !!value&&typeof (value as Promise<unknown>).then==='function';}

export class ToolRouter{
  readonly gate:FreshnessGate;
  readonly coordination:MessageTasks;
  readonly history:ConversationHistory;
  readonly sessions:SessionLifecycle;
  private readonly specs:ReadonlyMap<string,ToolSpec>;
  constructor(readonly collaboration:Collaboration,readonly broker:Broker,readonly additional?:AdditionalTools,readonly directory?:ConversationDirectory,readonly normalizeInput:(value:unknown)=>unknown=value=>value,historySource?:HistorySource){
    this.specs=buildRegistry(builtInToolModules);this.history=new ConversationHistory(collaboration.messages,historySource);this.sessions=new SessionLifecycle(collaboration,agent=>buildBaseline(agent,operationDocumentation));this.coordination=new MessageTasks(collaboration);this.gate=new FreshnessGate(collaboration.messages,collaboration.attention);collaboration.output.gate=this.gate;
  }
  async call(run:RunToken,workId:string,callId:string,operation:string,input:unknown,signal:AbortSignal):Promise<ToolReply>{
    const c=this.collaboration;c.store.assertRun(run);signal.throwIfAborted();
    if(operation==='tools.call'){const request=discoverySchemas['tools.call'].parse(input);operation=request.name;input=request.input;if(operation.startsWith('tools.'))throw new Error('Unknown operation');}
    if(operation==='tools.list'){discoverySchemas['tools.list'].parse(input);const seat=c.seats.active(run.agentId);return{value:[...this.specs.values()].filter(entry=>!seat||entry.seatPolicy!=='deny').map(({name,description})=>({name,description}))};}
    if(operation==='tools.describe'){const request=discoverySchemas['tools.describe'].parse(input),entry=this.specs.get(request.name);if(!entry)throw new Error('Unknown operation');this.authorizeSeat(entry,run);return{value:{name:entry.name,description:entry.description,inputSchema:z.toJSONSchema(entry.schema)}};}
    const entry=this.specs.get(operation);
    if(!entry)throw new Error('Unknown operation');
    this.authorizeSeat(entry,run);
    const args=entry.schema.parse(this.normalizeInput(input)) as Record<string,any>,selected=c.currentWork(run,workId);
    entry.authorize(this.context(run,selected,callId,operation,signal,selected),args);
    const context=this.context(run,this.resolveWork(entry,run,selected,args),callId,operation,signal,selected);
    if(entry.effectPolicy==='atomic-recorded')return this.atomic(entry,context,args);
    const result=await entry.handler(context,args);entry.postAwait(context);entry.authorize(context,args);if(!['none','select','broker-managed'].includes(entry.workPolicy))c.assertActionWork(run,context.workId);this.authorizeSeat(entry,run);const safe=this.seatResult(entry,context,result);return{value:safe.value,...(safe.wait?{wait:true}:{})};
  }
  private context(run:RunToken,workId:string,callId:string,operation:string,signal:AbortSignal,requestWorkId:string):ToolExecutionContext{return{operation,run,workId,requestWorkId,actionId:`${run.sessionId}:${callId}`,signal,collaboration:this.collaboration,broker:this.broker,...(this.additional?{additional:this.additional}:{}),...(this.directory?{directory:this.directory}:{}),history:this.history,sessions:this.sessions,coordination:this.coordination,gate:this.gate};}
  private resolveWork(entry:ToolSpec,run:RunToken,selected:string,args:Record<string,any>):string{
    const c=this.collaboration;
    if(entry.workPolicy==='none'||entry.workPolicy==='select'||entry.workPolicy==='broker-managed')return selected;
    let bound=selected;
    if(entry.workPolicy==='task')bound=this.taskWork(run,args,selected);
    if(entry.workPolicy==='task'&&args.intentId){const row=c.store.db.prepare('SELECT work_id,args,target FROM task_intents WHERE id=? AND agent_id=?').get(args.intentId,run.agentId) as {work_id:string;args:string;target:string}|undefined;if(!row)throw new Error('Unknown task intent');c.messages.requireAccess(run.agentId,JSON.parse(row.target).conversationId);bound=this.taskWork(run,JSON.parse(row.args),row.work_id);}
    if(entry.workPolicy==='reminder'){
      if(args.reminderId)bound=c.reminders.read(run.agentId,args.reminderId).work_id;
      else if(args.scheduleId)bound=c.reminders.read(run.agentId,args.scheduleId).work_id;
      else if(args.firingId){const row=c.store.db.prepare('SELECT r.work_id FROM reminder_firings f JOIN schedules r ON r.id=f.reminder_id WHERE f.id=? AND r.agent_id=?').get(args.firingId,run.agentId) as {work_id:string}|undefined;if(!row)throw new Error('Unknown owned reminder firing');bound=row.work_id;}
    }
    c.assertActionWork(run,bound);return bound;
  }
  private taskWork(run:RunToken,args:Record<string,any>,fallback:string):string{
    const c=this.collaboration;if(args.taskId)return c.board.read(run.agentId,args.taskId).workId;
    if(!args.message)return fallback;
    const message=c.messages.message(run.agentId,args.message.messageId),row=c.store.db.prepare('SELECT work_id FROM tasks WHERE message_key=? UNION ALL SELECT work_id FROM message_work WHERE message_key=? LIMIT 1').get(message.id,message.id) as {work_id:string}|undefined;
    return row?.work_id??fallback;
  }
  private atomic(entry:ToolSpec,context:ToolExecutionContext,args:Record<string,any>):ToolReply{
    const c=this.collaboration,s=c.store,request=entry.workPolicy==='select'?{operation:entry.name,args}:{workId:context.requestWorkId,operation:entry.name,args};
    return s.atomic(()=>{
      const existing=c.messages.writes.prepareAction(context.run,context.actionId,request);
      if(args.intentId)context.coordination.describe(context.run.agentId,args.intentId);
      if(args.draftId)context.gate.describe(context.run.agentId,args.draftId);
      if(existing.state==='succeeded'&&entry.replayPolicy==='immutable')return JSON.parse(existing.receipt!) as ToolReply;
      if(existing.state==='succeeded'&&entry.replayPolicy==='refreshable'){s.db.prepare("UPDATE actions SET state='prepared',run_id=? WHERE id=?").run(context.run.id,context.actionId);existing.state='prepared';}
      if(existing.state!=='prepared')throw new Error('Uncertain tool action');
      s.startAction(context.run,context.actionId);const result=entry.handler(context,args);if(isPromise(result))throw new Error('Atomic tool handler returned a promise');entry.postAwait(context);
      const safe=this.seatResult(entry,context,result),reply={value:safe.value,wait:Boolean(safe.wait)};s.settleAction(context.run,context.actionId,'succeeded',reply);return reply;
    });
  }
  private authorizeSeat(entry:ToolSpec,run:RunToken):void{
    if(!this.collaboration.seats.active(run.agentId))return;
    switch(entry.seatPolicy){case'deny':throw new Error('Independent review seat isolates this input path');case'redacted-read':case'clean-workspace':case'held-send':return;}
  }
  private seatResult(entry:ToolSpec,context:ToolExecutionContext,result:ToolHandlerResult):ToolHandlerResult{
    if(!this.collaboration.seats.active(context.run.agentId)||entry.seatPolicy!=='held-send')return result;
    const draftId=(result.value as {draftId?:unknown}|null)?.draftId;if(typeof draftId!=='string')throw new Error('Review-seat submission lacks an owned draft');
    return{...result,value:context.gate.describe(context.run.agentId,draftId)};
  }
}
