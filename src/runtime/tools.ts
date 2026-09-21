import {ConversationHistory,historySchemas,type HistorySource} from '../conversations/history.js';
import { SessionLifecycle } from './sessions.js';
import { buildBaseline } from './prompt.js';
import { ToolEnvironment } from './environment.js';
import { operationSchema } from '../execution/backend.js';
import { MessageTasks } from '../coordination/messages.js';
import { CanonicalFreshnessGate as FreshnessGate } from '../conversations/freshness.js';
import { z } from 'zod';
import type { RunToken } from '../storage/store.js';
import type { Collaboration } from '../collaboration/service.js';
import type { Broker } from '../policy/broker.js';
import type { ConversationDirectory } from '../conversations/directory.js';
import { conversationTargetSchema as targetSchema } from '../domain/conversations.js';
import type { ToolReply } from './engine.js';
const id = z.string().min(1).max(500), text = z.string().max(35000);
const messageRef=z.object({messageId:id}).strict();
const reminderInput={target:targetSchema,content:z.string().min(1).max(12000),nextAt:z.number().int().nonnegative(),timezone:id,cron:id.optional(),taskId:id.optional(),anchor:messageRef.optional()};
const fileSchemas = Object.fromEntries(operationSchema.options.filter(schema=>schema.shape.kind.value!=='exec').map(schema=>[`file.${schema.shape.kind.value}`,(schema as z.ZodObject).omit({kind:true}).extend({grantId:id})]));
const schemas: Record<string,z.ZodType> = {
  ...fileSchemas,
  ...historySchemas,
  'actions.list':z.object({before:z.number().int().positive().optional()}).strict(),
  'actions.read':z.object({actionId:id}).strict(),
  'sessions.status':z.object({}).strict(),
  'sessions.checkpoint':z.object({text:z.string().min(1).max(20000)}).strict(),
  'sessions.reset':z.object({text:z.string().min(1).max(20000)}).strict(),
  'reminders.list':z.object({before:z.number().int().positive().optional()}).strict(),
  'reminders.read':z.object({reminderId:id}).strict(),
  'reminders.log':z.object({reminderId:id,before:z.number().int().positive().optional()}).strict(),
  'reminders.create':z.object(reminderInput).strict(),
  'reminders.edit':z.object({...reminderInput,reminderId:id,expectedVersion:z.number().int().positive()}).strict(),
  'reminders.cancel':z.object({reminderId:id,expectedVersion:z.number().int().positive(),cancelPending:z.boolean().optional()}).strict(),
  'environment.info':z.object({}).strict(),
  'attachments.save':z.object({message:messageRef,fileId:id,grantId:id,path:id}).strict(),
  'tasks.byMessage':z.object({message:messageRef}).strict(),
  'tasks.intents':z.object({}).strict(),
  'tasks.retry':z.object({intentId:id,viewToken:id.optional()}).strict(),
  'tasks.continue':z.object({intentId:id,holdId:id,acknowledge:z.literal('apply_despite_unread_or_changes')}).strict(),
  'tasks.discard':z.object({intentId:id}).strict(),
  'tasks.unclaim':z.object({taskId:id,expectedVersion:z.number().int().nonnegative(),viewToken:id.optional()}).strict(),
  'tasks.transfer':z.object({taskId:id,peerId:id,expectedVersion:z.number().int().nonnegative(),viewToken:id.optional()}).strict(),
  'drafts.list':z.object({}).strict(),
  'drafts.read':z.object({draftId:id}).strict(),
  'drafts.retry':z.object({draftId:id,revision:z.number().int().positive(),viewToken:id.optional()}).strict(),
  'drafts.continue':z.object({draftId:id,revision:z.number().int().positive(),holdId:id,acknowledge:z.literal('send_despite_unread_or_changes')}).strict(),
  'drafts.revise':z.object({draftId:id,revision:z.number().int().positive(),text,target:targetSchema.optional()}).strict(),
  'drafts.discard':z.object({draftId:id,revision:z.number().int().positive()}).strict(),
  'attention.peek': z.object({}).strict(),
  'attention.read': z.object({target:targetSchema,cursor:id.optional()}).strict(),
  'attention.resolve': z.object({target:targetSchema,throughRevision:z.number().int().nonnegative()}).strict(),
  'attention.defer': z.object({target:targetSchema,until:z.number().int().nonnegative()}).strict(),
  'attention.mute': z.object({target:targetSchema,active:z.boolean()}).strict(),
  'works.list': z.object({}).strict(),
  'works.select': z.object({ workId: id }).strict(),
  'budget.read': z.object({}).strict(),
  'conversations.capabilities':z.object({conversationId:id.optional()}).strict(),
  'conversations.discover':z.object({cursor:z.string().min(1).max(10000).optional()}).strict(),
  'conversations.join':z.union([z.object({conversationId:id}).strict(),z.object({candidateId:id}).strict()]),
  'conversations.leave':z.object({conversationId:id}).strict(),
  'conversations.refresh':z.object({conversationId:id}).strict(),
  'conversations.list': z.object({}).strict(),
  'conversations.members': z.object({ conversationId: id }).strict(),
  'conversations.openDM': z.object({ principal: z.object({kind:z.enum(['human','agent','external']),id}).strict() }).strict(),
  'research.read': z.object({ url: z.string().url().max(4000) }).strict(),
  'artifact.publish': z.object({ grantId: id, path: id, title: z.string().min(1).max(200), target: targetSchema,format:z.enum(['text','binary']).optional(),text:text.optional(),viewToken:id.optional() }).strict(),
  'artifact.revise':z.object({draftId:id,revision:z.number().int().positive(),grantId:id,path:id,title:z.string().min(1).max(200),target:targetSchema,format:z.enum(['text','binary']).optional(),text:text.optional()}).strict(),
  'messages.recent': z.object({ conversationId: id }).strict(),
  'tasks.read': z.object({ taskId: id }).strict(),
  agents: z.object({}).strict(), 'messages.read': z.object({ target: targetSchema }).strict(),
  'messages.search': z.object({ query: text }).strict(), 'messages.send': z.object({ target: targetSchema, text,viewToken:id.optional() }).strict(),
  'messages.watch': z.object({ target: targetSchema, active: z.boolean() }).strict(),
  'tasks.list': z.object({}).strict(), 'tasks.create': z.object({ target: targetSchema, title: text, viewToken:id.optional() }).strict(),
  'tasks.claim': z.union([z.object({taskId:id,expectedVersion:z.number().int().nonnegative(),viewToken:id.optional()}).strict(),z.object({message:messageRef,expectedVersion:z.number().int().nonnegative(),viewToken:id.optional()}).strict()]), 'tasks.delegate': z.object({ taskId: id, peerId: id, title: text, viewToken:id.optional() }).strict(),
  'tasks.wait': z.object({ taskId: id, dependencyId: id,expectedVersion:z.number().int().nonnegative(),viewToken:id.optional() }).strict(),
  'tasks.update': z.object({ taskId: id, status: z.enum(['doing','review','done','cancelled','failed']), result: text.optional(),expectedVersion:z.number().int().nonnegative(),viewToken:id.optional() }).strict(),
  'schedules.list': z.object({}).strict(), 'schedules.cancel': z.object({ scheduleId: id,expectedVersion:z.number().int().positive(),cancelPending:z.boolean().optional() }).strict(),
  'schedules.create': z.object({ target: targetSchema, nextAt: z.number().int().positive(), timezone: id, cron: id.optional(), taskId: id.optional() }).strict(),
  'inbox.list': z.object({}).strict(), 'inbox.read': z.object({ deliveryId: id }).strict(), 'inbox.ack': z.object({ deliveryId: id }).strict(),
  exec: z.object({ grantId: id, command: z.string().max(16000), cwd: id }).strict()
};
const discoverySchemas={
 'tools.list':z.object({}).strict(),
 'tools.describe':z.object({name:id}).strict(),
 'tools.call':z.object({name:id,input:z.unknown()}).strict()
};
export const operationDocumentation = `Use tools.list to discover capabilities and tools.describe with {name} for exact schemas. Call the named operation directly, or tools.call with {name,input}. Available: ${Object.keys(schemas).join(', ')}.\n` + Object.entries(discoverySchemas).map(([name, schema]) => `${name}: ${JSON.stringify(z.toJSONSchema(schema))}`).join('\n');
export interface AdditionalTools {
  environment?(actor:string):unknown;
  attachment?(run:RunToken,workId:string,actionId:string,args:import('../capabilities/artifacts.js').AttachmentArgs,signal:AbortSignal):Promise<unknown>;
  research(url: string, signal: AbortSignal): Promise<unknown>;
  publish(run: RunToken, workId: string, actionId: string, args: import('../capabilities/artifacts.js').PublishArgs, signal: AbortSignal): Promise<unknown>;
}
type ToolContext={run:RunToken;workId:string;callId:string;signal:AbortSignal};
const seatOperations=['actions.list','actions.read','sessions.status','sessions.checkpoint','sessions.reset','environment.info','agents','budget.read','attention.peek','messages.send','drafts.list','drafts.read','drafts.retry','drafts.continue','drafts.revise','drafts.discard',...Object.keys(fileSchemas),'exec'];
const capabilityDescriptions:Record<string,string>={
 'history.page':'Page current authorized local history, with precise canonical before/after anchors and opaque cursor. Current internal room members may read earlier room history. Coverage is local/live, not full platform history; no viewToken.',
 'history.search':'Bounded text/author search over current authorized local history. Follow nextCursor even when a scan batch has no hits. No platform search or reading acknowledgment.',
 'history.around':'Retrieve nearby authorized context around a canonical message anchor. Replies use thread context; top-level anchors use conversation context. Reports side counts/truncation; no full-view proof.',
 'history.fetch':'Fetch one bounded page from the acting installation under current access and run fencing. Canonical before/after anchors and query-bound cursor. Quiet acquisition creates no new work or read acknowledgment; inspect gaps/coverage. Use page/search afterward.',

 'conversations.capabilities':'Inspect implemented participation operations and platform conditions, optionally for a conversation. Unsupported is explicit; capability availability does not grant access.',
 'conversations.discover':'Page public space metadata through the configured adapter. Discovery never grants message access. Follow nextCursor; does not enumerate private rooms.',
 'conversations.join':'Request joining a discovered public external channel; receipt may be succeeded, failed, unknown or unsupported. Unknown is not retried blindly.',
 'conversations.leave':'Leave an external channel with a durable receipt; successful completion removes local access. Internal rooms and DMs use attention controls instead.',
 'conversations.refresh':'Read current external membership and reconcile unknown join/leave when the desired state is observed. A negative observation alone does not settle a timed-out request.',
 'attention.mute':'Suppress ordinary target activity; direct personal mentions and DMs still surface. Does not mark input read or stop an already active run.',
 'attention.defer':'Explicitly postpone a target, including direct requests, until a timestamp. New input stays unread; expiry produces a durable wakeup if permitted. Does not cancel existing work.',

 'file.read_bytes':'Read up to 32 KiB binary bytes at an offset, returning base64, file size and full SHA256. Files up to 1 MB.',
 'file.write_bytes':'Atomically write canonical base64 bytes, decoded size up to 1 MB, in the granted workspace.',
 'attachments.save':'Download a file attached to a visible message into a granted workspace path (up to 1 MB). File ID must occur on that message; uses the acting Agent credential.',
 'artifact.publish':'Freeze own artifacts/ file and create a gated publication draft. format=text supports 64 KiB UTF-8, format=binary supports 1 MB. Read returned status; queued/held does not mean published.',
 'environment.info':'Inspect the configured container image, network policy and research hosts; use exec to inspect installed tool versions.',
 'file.list':'List up to 200 directory entries (48 KB); truncated indicates remaining entries.',
 'file.search':'Recursively find literal text in UTF-8 files up to 1 MB; at most 1000 visited paths/100 matches/45 KB. Skips symlinks/binary files; truncated reports limits.',
 'file.stat':'Inspect file type/size and SHA256 for regular files up to 1 MB.',
 'file.read':'Read up to 64 KiB UTF-8 text. Use search or exec for larger files.',
 'file.write':'Atomically write up to 1 MB UTF-8 text; preserve five previous versions in <path>.history.',
 'file.edit':'Edit a file only if expectedHash matches and oldText occurs exactly once. Inspect with file.stat first.',
 'file.move':'Move/rename within the granted workspace; destination must not exist.',
 'file.remove':'Remove a regular file or empty directory, optionally checking expectedHash. Does not recursively delete directories.',
 'file.mkdir':'Create a directory and missing parents within the granted workspace.',
 exec:'Run a shell command in the configured container and granted workspace. No host credentials; image determines installed tools; unavailable without a configured exec grant.'
};
export class ToolRouter {
  readonly environment=new ToolEnvironment<ToolContext,ToolReply>();
  readonly gate:FreshnessGate;
  readonly coordination:MessageTasks;
  readonly history:ConversationHistory;
  readonly sessions:SessionLifecycle;
  constructor(readonly collaboration: Collaboration, readonly broker: Broker, readonly additional?: AdditionalTools, readonly directory?: ConversationDirectory, readonly provision?: (actor:string,workId:string)=>void,readonly normalizeInput:(value:unknown)=>unknown=value=>value,historySource?:HistorySource) {this.history=new ConversationHistory(collaboration.messages,historySource);this.sessions=new SessionLifecycle(collaboration,agent=>buildBaseline(agent,operationDocumentation));this.coordination=new MessageTasks(collaboration);this.gate=new FreshnessGate(collaboration.messages,collaboration.attention);collaboration.output.gate=this.gate;
    for(const [name,schema]of Object.entries(schemas))this.environment.register({name,schema,description:capabilityDescriptions[name]??`Mate ${name} capability; current actor, work, grants and submission gates apply.`,execute:(context,input)=>this.dispatch(context.run,context.workId,context.callId,name,input,context.signal)});
  }
  async call(run: RunToken, workId: string, callId: string, operation: string, input: unknown, signal: AbortSignal): Promise<ToolReply> {
    this.collaboration.store.assertRun(run);signal.throwIfAborted();
    if(operation==='tools.call'){const request=discoverySchemas['tools.call'].parse(input);operation=request.name;input=request.input;if(operation.startsWith('tools.'))throw new Error('Unknown operation');}
    if(!operation.startsWith('tools.') && this.collaboration.seats.active(run.agentId) && !seatOperations.includes(operation))throw new Error('Independent review seat isolates this input path');
    // Extensions are trusted host code, but inherit the common active-work boundary.
    if(!Object.hasOwn(schemas,operation) && !operation.startsWith('tools.')){workId=this.collaboration.currentWork(run,workId);this.collaboration.assertActionWork(run,workId);}
    if(operation==='tools.list'){discoverySchemas['tools.list'].parse(input);return {value:this.environment.list().filter(item=>!this.collaboration.seats.active(run.agentId)||seatOperations.includes(item.name))};}
    if(operation==='tools.describe'){const request=discoverySchemas['tools.describe'].parse(input);if(this.collaboration.seats.active(run.agentId)&&!seatOperations.includes(request.name))throw new Error('Independent review seat isolates this input path');return {value:this.environment.describe(request.name)};}
    return this.environment.execute({run,workId,callId,signal},operation,this.normalizeInput(input));
  }
  private async dispatch(run: RunToken, workId: string, callId: string, operation: string, input: unknown, signal: AbortSignal): Promise<ToolReply> {
    const c = this.collaboration, s = c.store, actor = run.agentId;
    s.assertRun(run); signal.throwIfAborted();
    if(c.seats.active(actor) && !seatOperations.includes(operation))throw new Error('Independent review seat isolates this input path');
    workId = c.currentWork(run, workId);
    if (!Object.hasOwn(schemas,operation)) throw new Error('Unknown operation');
    // Parsing is deliberately repeated in the daemon, independently of model-side tool validation.
    const args = schemas[operation]!.parse(input) as Record<string, any>;
    const readOnly = ['actions.list','actions.read','sessions.status','reminders.list','reminders.read','reminders.log','environment.info','tasks.byMessage','tasks.intents','drafts.list','drafts.read','attention.peek','attention.read','attention.resolve','attention.defer','attention.mute','agents','works.list','budget.read','tasks.read','tasks.list','messages.read','messages.recent','messages.search','schedules.list','inbox.list','inbox.read','conversations.list','conversations.members','conversations.capabilities','conversations.discover','conversations.refresh'];
    if (!readOnly.includes(operation) && !operation.startsWith('history.') && operation !== 'works.select') c.assertActionWork(run, args.taskId ? c.task(args.taskId).work_id : workId);
    if(args.message)c.messages.message(actor,args.message.messageId);
    if(args.anchor)c.messages.message(actor,args.anchor.messageId);
    if(args.reminderId)c.reminders.read(actor,args.reminderId);
    if(args.scheduleId)c.reminders.read(actor,args.scheduleId);
    if(args.target)c.messages.requireAccess(actor,args.target.conversationId);
    if(args.conversationId&&!['conversations.capabilities','conversations.join','conversations.leave','conversations.refresh'].includes(operation))c.messages.requireAccess(actor,args.conversationId);
    if(args.taskId)c.messages.requireAccess(actor,JSON.parse(c.task(args.taskId).target).conversationId);
    if(args.deliveryId){const delivery=s.delivery(args.deliveryId);if(delivery.agent_id!==actor)throw new Error('Private inbox');const target=JSON.parse(delivery.payload).target;if(target)c.messages.requireAccess(actor,target.conversationId);}
    const actionId = `${run.sessionId}:${callId}`;
    if (operation.startsWith('conversations.')) {
      if (!this.directory) throw new Error('Directory unavailable');
      let value:unknown;
      switch(operation){
        case 'conversations.openDM':value=await this.directory.openDM(run,actionId,args.principal,signal);break;
        case 'conversations.members':value=await this.directory.members(actor,args.conversationId);break;
        case 'conversations.capabilities':value=this.directory.capabilities?.(actor,args.conversationId)??{discover:false,join:false,leave:false,refresh:false,notes:['Adapter does not implement participation controls']};break;
        case 'conversations.discover':value=await this.directory.discover?.(actor,args.cursor)??{supported:false,reason:'Discovery unavailable'};break;
        case 'conversations.join':if(args.candidateId){value=await this.directory.joinCandidate?.(run,actionId,args.candidateId,signal)??{status:'unsupported',reason:'Candidate joining unavailable'};break;}
        case 'conversations.leave':value=await this.directory.membership?.(run,actionId,args.conversationId,operation==='conversations.join'?'join':'leave',signal)??{status:'unsupported',reason:'Membership control unavailable'};break;
        case 'conversations.refresh':value=await this.directory.refresh?.(actor,args.conversationId,signal)??{status:'unsupported',reason:'Membership source unavailable'};break;
        default:value=await this.directory.spaces(actor);
      }
      s.assertRun(run); signal.throwIfAborted(); return { value };
    }
    if(operation.startsWith('history.')){
      const value=operation==='history.fetch'?await this.history.fetch(run,args,signal):operation==='history.page'?this.history.page(run,args):operation==='history.search'?this.history.search(run,args):this.history.around(run,args);
      s.assertRun(run);signal.throwIfAborted();return{value};
    }
    if(operation==='environment.info')return{value:this.additional?.environment?.(actor)??{configured:false}};
    if(operation==='attachments.save'){if(!this.additional?.attachment)throw new Error('Attachment adapter unavailable');return{value:await this.additional.attachment(run,workId,actionId,args as any,signal)};}
    if (operation === 'research.read') { if (!this.additional) throw new Error('Research unavailable'); return { value: await this.additional.research(args.url, signal) }; }
    if (operation === 'artifact.publish'||operation==='artifact.revise') { if (!this.additional) throw new Error('Publication unavailable'); return { value: await this.additional.publish(run, workId, actionId, args as any, signal) }; }
    if (operation.startsWith('file.') || operation==='exec') {
      const value = await this.broker.execute(run, workId, actionId, args.grantId, operationSchema.parse({...Object.fromEntries(Object.entries(args).filter(([key])=>key!=='grantId')),kind:operation==='exec'?'exec':operation.slice(5)}), signal);
      return { value };
    }
    // All local effects and their receipts commit together. Crash replay returns the recorded value.
    return s.atomic(() => {
      const existing = c.messages.writes.prepareAction(run, actionId, operation === 'works.select' ? { operation, args } : { workId, operation, args });
      if(args.intentId)this.coordination.describe(actor,args.intentId);
      if(args.draftId)this.gate.describe(actor,args.draftId);
      const refresh = ['actions.list','actions.read','sessions.status','reminders.list','reminders.read','reminders.log','tasks.byMessage','tasks.intents','drafts.list','drafts.read','attention.peek','budget.read','works.list','tasks.list','messages.search','schedules.list','inbox.list'].includes(operation);
      if (existing.state === 'succeeded' && !refresh) return JSON.parse(existing.receipt!) as ToolReply;
      if(existing.state==='succeeded' && refresh){s.db.prepare("UPDATE actions SET state='prepared',run_id=? WHERE id=?").run(run.id,actionId);existing.state='prepared';}
      if (existing.state !== 'prepared') throw new Error('Uncertain tool action');
      s.startAction(run, actionId);
      if (args.taskId) c.messages.requireAccess(actor, JSON.parse(c.task(args.taskId).target).conversationId);
      let value: unknown = null, wait = false;
      switch (operation) {
        case 'actions.list':{
          const items=s.db.prepare("SELECT rowid cursor,id,state,CASE WHEN json_type(request,'$.operation')='object' THEN json_extract(request,'$.operation.kind') ELSE json_extract(request,'$.operation') END operation FROM actions WHERE agent_id=? AND rowid<? ORDER BY rowid DESC LIMIT 100").all(actor,args.before??Number.MAX_SAFE_INTEGER);
          value={items,nextCursor:items.length===100?(items.at(-1) as any).cursor:null};break;
        }
        case 'actions.read':{
          const row=s.db.prepare('SELECT * FROM actions WHERE id=? AND agent_id=?').get(args.actionId,actor) as {request:string;receipt:string|null}|undefined;
          if(!row)throw new Error('Unknown own action');const request=JSON.parse(row.request);
          // Old read results may contain subsequently revoked conversation bodies.
          // Re-read those through their current ACL-aware capability instead.
          if(typeof request.operation!=='object'||request.operation===null){
            value={id:args.actionId,state:(row as any).state,operation:request.operation,receiptUnavailable:'Use the current read capability; historical read bodies are not replayed.'};break;
          }
          const target=request.args?.target??request.target;
          if(target?.conversationId)c.messages.requireAccess(actor,target.conversationId);
          if(request.args?.taskId)c.messages.requireAccess(actor,JSON.parse(c.task(request.args.taskId).target).conversationId);
          if(request.workId)c.messages.requireAccess(actor,JSON.parse(c.work(request.workId).target).conversationId);
          value={...row,request,receipt:row.receipt?JSON.parse(row.receipt):null};break;
        }
        case 'sessions.status':value=this.sessions.status(actor);break;
        case 'sessions.checkpoint':value=this.sessions.checkpoint(actor,args.text);break;
        case 'sessions.reset':value=this.sessions.request(run,workId,actionId,args.text);wait=true;break;
        case 'reminders.list':{const items=c.reminders.list(actor,args.before);value={items,nextCursor:items.length===100?items.at(-1)!.cursor:null};break;}
        case 'reminders.read':value=c.reminders.read(actor,args.reminderId);break;
        case 'reminders.log':value=c.reminders.log(actor,args.reminderId,args.before);break;
        case 'reminders.create':value=c.reminders.create(actor,workId,args as any);break;
        case 'reminders.edit':value=c.reminders.edit(actor,args.reminderId,args.expectedVersion,args as any);break;
        case 'reminders.cancel':value=c.reminders.cancel(actor,args.reminderId,args.expectedVersion,args.cancelPending);break;
        case 'tasks.byMessage':value=this.coordination.find(actor,args.message)??null;break;
        case 'tasks.intents':value=(s.db.prepare("SELECT i.id FROM task_intents i JOIN channel_access a ON a.agent_id=i.agent_id AND a.channel=json_extract(i.target,'$.conversationId') WHERE i.agent_id=? AND a.active=1 AND i.state='held'").all(actor) as {id:string}[]).map(i=>this.coordination.describe(actor,i.id));break;
        case 'tasks.retry':value=this.coordination.retry(run,args.intentId,args.viewToken);break;
        case 'tasks.continue':value=this.coordination.continue(run,args.intentId,args.holdId);break;
        case 'tasks.discard':value=this.coordination.discard(run,args.intentId);break;
        case 'tasks.unclaim':case 'tasks.transfer':value=this.coordination.submit(run,workId,actionId,operation,args,args.viewToken);break;
        case 'drafts.list':value=this.gate.list(actor);break;
        case 'drafts.read':value=this.gate.describe(actor,args.draftId);break;
        case 'drafts.retry':value=this.gate.retry(run,args.draftId,args.revision,args.viewToken);break;
        case 'drafts.continue':value=this.gate.continueOnce(run,args.draftId,args.revision,args.holdId);break;
        case 'drafts.revise':value=this.gate.revise(run,args.draftId,args.revision,args.text,args.target);break;
        case 'drafts.discard':value=this.gate.discard(run,args.draftId,args.revision);break;
        case 'attention.peek': value=c.attention.peek(actor);break;
        case 'attention.read': value=c.attention.read(run,args.target,args.cursor);break;
        case 'attention.resolve': c.attention.state(actor,args.target,'resolve',args.throughRevision);break;
        case 'attention.defer': c.attention.state(actor,args.target,'defer',args.until);break;
        case 'attention.mute': c.attention.state(actor,args.target,'mute',Number(args.active));break;
        case 'budget.read': value=c.ledger.account(actor); break;
        case 'works.list': value=s.db.prepare("SELECT w.* FROM works w JOIN channel_access a ON a.channel=json_extract(w.target,'$.conversationId') WHERE a.agent_id=? AND a.active=1 ORDER BY w.rowid DESC LIMIT 100").all(actor); for(const row of value as {id:string}[])c.messages.records.mutableTarget('works',row.id); break;
        case 'works.select': c.selectWork(run,args.workId); this.provision?.(actor,args.workId); value={work:c.work(args.workId),grants:s.db.prepare('SELECT id,operations FROM grants WHERE agent_id=? AND work_id=? AND revoked=0 AND expires>?').all(actor,args.workId,Date.now())}; break;
        case 'agents': value = c.agents.list().map(a => ({ id: a.id, name: a.name, role: a.role })); break;
        case 'tasks.read': { const task = c.task(args.taskId); c.messages.requireAccess(actor, JSON.parse(task.target).conversationId); value = task; break; }
        case 'messages.recent': value = c.messages.recent(actor, args.conversationId); break;
        case 'messages.read': value = c.messages.read(actor, args.target); break;
        case 'messages.search': value = c.messages.search(actor, args.query); break;
        case 'messages.send': c.send(actor, workId, args.target, args.text, actionId,{run,viewToken:args.viewToken});value=this.gate.describe(actor,actionId);break;
        case 'messages.watch': c.messages.watch(actor, args.target, args.active); break;
        case 'tasks.list': value = c.list(actor); break;
        case 'tasks.create': {const task=this.coordination.create(run,workId,args.target,args.title,args.viewToken);value={task,messageDraft:this.gate.describe(actor,task.outbox_id!)};break;}
        case 'tasks.claim':value=this.coordination.submit(run,workId,actionId,operation,args,args.viewToken);break;
        case 'tasks.delegate': value = c.delegate(actor, args.taskId, args.peerId, args.title,{run,viewToken:args.viewToken}); break;
        case 'tasks.wait':value=this.coordination.submit(run,workId,actionId,operation,args,args.viewToken);break;
        case 'tasks.update':value=this.coordination.submit(run,workId,actionId,operation,args,args.viewToken);break;
        case 'schedules.list': value = c.schedules(actor); break;
        case 'schedules.create': value = c.schedule(actor, workId, args.target, args.nextAt, args.timezone, args.cron, args.taskId); break;
        case 'schedules.cancel': value=c.reminders.cancel(actor,args.scheduleId,args.expectedVersion,args.cancelPending);break;
        case 'inbox.read': case 'inbox.ack': {
          const delivery = s.delivery(args.deliveryId);
          if (delivery.agent_id !== actor) throw new Error('Private inbox');
          const payload = JSON.parse(delivery.payload);
          if (payload.target?.conversationId) c.messages.requireAccess(actor, payload.target.conversationId);
          if (operation === 'inbox.ack') s.db.prepare('INSERT INTO inbox_reads VALUES(?,?,?) ON CONFLICT DO NOTHING').run(delivery.id, actor, Date.now());
          value = { ...delivery, payload }; break;
        }
        case 'inbox.list': value = (s.db.prepare("SELECT id,payload,status FROM deliveries WHERE agent_id=? AND status!='handled' ORDER BY created_at LIMIT 50").all(actor) as { id: string; payload: string; status: string }[]).filter(d => { const target = JSON.parse(d.payload).target; if (!target?.conversationId) return true; try { c.messages.requireAccess(actor, target.conversationId); return true; } catch { return false; } }).map(d => ({ id: d.id, status: d.status, kind: JSON.parse(d.payload).kind })); break;
      }
      if(['tasks.wait','tasks.retry','tasks.continue'].includes(operation))wait=(value as any)?.result?.status==='waiting';
      const result = { value, wait }; s.settleAction(run, actionId, 'succeeded', result); return result;
    });
  }
}
