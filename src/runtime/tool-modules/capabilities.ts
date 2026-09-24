import {z} from 'zod';
import {operationSchema} from '../../execution/backend.js';
import {ProcessStopRejectedError} from '../../execution/linux-processes.js';
import {systemCommandSchema} from '../../policy/system-operations.js';
import {conversationTargetSchema as targetSchema} from '../../domain/conversations.js';
import {authorizeReferences,fence,id,spec,text,type ToolModule,type ToolSpec} from '../tool-contract.js';

export const fileSchemas=Object.fromEntries(operationSchema.options.filter(schema=>schema.shape.kind.value!=='exec').map(schema=>[`file.${schema.shape.kind.value}`,(schema as z.ZodObject).omit({kind:true})])) as Record<string,z.ZodType>;
const descriptions:Record<string,string>={
  'file.read_bytes':'Read up to 32 KiB binary bytes at an offset, returning base64, file size and full SHA256. Files up to 1 MB.',
  'file.write_bytes':'Atomically write canonical base64 bytes, decoded size up to 1 MB, using the Agent Linux user.',
  'file.list':'List up to 200 directory entries (48 KB); truncated indicates remaining entries.',
  'file.search':'Recursively find literal text in UTF-8 files up to 1 MB; at most 1000 visited paths, 100 matches and 45 KB.',
  'file.stat':'Inspect file type, size and SHA256 for regular files up to 1 MB.',
  'file.read':'Read up to 64 KiB UTF-8 text. Use search or exec for larger files.',
  'file.write':'Atomically write up to 1 MB UTF-8 text and preserve five previous versions.',
  'file.edit':'Edit only if expectedHash matches and oldText occurs exactly once.',
  'file.move':'Move or rename a file; destination must not exist.',
  'file.remove':'Remove a regular file or empty directory, optionally checking expectedHash.',
  'file.mkdir':'Create a directory and missing parents using the Agent Linux user.'
};
const files=Object.entries(fileSchemas).map(([name,schema])=>spec({name,schema,description:descriptions[name]??`Execute ${name} as the Agent Linux user.`,workPolicy:'broker-managed',seatPolicy:'clean-workspace',effectPolicy:'broker-recorded',replayPolicy:'boundary-owned',authorize:authorizeReferences,postAwait:fence,handler:async({broker,run,workId,actionId,signal},args)=>({value:await broker.execute(run,workId,actionId,operationSchema.parse({...args,kind:name.slice(5)}),signal)})}));

const definitions:ToolSpec[]=[...files,
  spec({name:'exec',schema:z.object({command:z.string().max(16000),cwd:id}).strict(),description:'Run a shell command as the Agent Linux user. Use an absolute working directory or a path relative to the Agent home; background commands may keep running after this call.',workPolicy:'broker-managed',seatPolicy:'clean-workspace',effectPolicy:'broker-recorded',replayPolicy:'boundary-owned',authorize:authorizeReferences,postAwait:fence,handler:async({broker,run,workId,actionId,signal},args)=>({value:await broker.execute(run,workId,actionId,operationSchema.parse({command:args.command,cwd:args.cwd,kind:'exec'}),signal)})}),
  spec({name:'processes.list',schema:z.object({}).strict(),description:'List currently running Linux scopes for your Agent user; state comes from systemd and /proc.',workPolicy:'current',seatPolicy:'deny',effectPolicy:'pure-read',replayPolicy:'boundary-owned',authorize:authorizeReferences,postAwait:fence,handler:({additional,run})=>{if(!additional?.processes)throw new Error('Linux process control unavailable');return{value:additional.processes.list(run.agentId)};}}),
  spec({name:'processes.stop',schema:z.object({unit:id}).strict(),description:'Stop one of your Agent Linux scopes and its remaining processes.',workPolicy:'current',seatPolicy:'deny',effectPolicy:'adapter-recorded',replayPolicy:'boundary-owned',authorize:authorizeReferences,postAwait:fence,handler:({additional,run,workId,actionId,collaboration},args)=>{
    if(!additional?.processes)throw new Error('Linux process control unavailable');
    const store=collaboration.store,request={workId,operation:'processes.stop',unit:args.unit},action=store.prepareAction(run,actionId,request);
    if(action.state==='succeeded'||action.state==='failed')return{value:{status:action.state,receipt:action.receipt?JSON.parse(action.receipt):null}};
    if(action.state==='unknown'||action.state==='executing')return{value:{status:'action_unknown',actionId}};
    store.startAction(run,actionId);
    try{const result=additional.processes.stop(run.agentId,args.unit);store.settleAction(run,actionId,'succeeded',result);return{value:result};}
    catch(error){try{if(error instanceof ProcessStopRejectedError)store.settleAction(run,actionId,'failed',{reason:error.message});else store.settleAction(run,actionId,'unknown',{reason:'process_stop_outcome_unknown'});}catch{/* Recovery owns uncertain state. */}throw error;}
  }}),
  spec({name:'system.request',schema:systemCommandSchema,description:'Request one system-level command. It will not run unless a human owner confirms this exact request in Slack; scripts and dependencies may change before execution.',workPolicy:'current',seatPolicy:'deny',effectPolicy:'adapter-recorded',replayPolicy:'boundary-owned',authorize:authorizeReferences,postAwait:fence,handler:({additional,run,workId,actionId},args)=>{if(!additional?.system)throw new Error('System operation approval unavailable');return{value:additional.system.request(run,workId,actionId,args)};}}),
  spec({name:'system.status',schema:z.object({requestId:id}).strict(),description:'Read the current result of one of your system-level requests, including denial, expiry or uncertain execution.',workPolicy:'current',seatPolicy:'deny',effectPolicy:'pure-read',replayPolicy:'boundary-owned',authorize:authorizeReferences,postAwait:fence,handler:({additional,run},args)=>{if(!additional?.system)throw new Error('System operation approval unavailable');return{value:additional.system.status(run.agentId,args.requestId)};}}),
  spec({name:'attachments.save',schema:z.object({message:z.object({messageId:id}).strict(),fileId:id,path:id}).strict(),description:'Download a file attached to a visible message to an Agent-accessible path, up to 1 MB.',workPolicy:'broker-managed',seatPolicy:'deny',effectPolicy:'adapter-recorded',replayPolicy:'boundary-owned',authorize:authorizeReferences,postAwait:fence,handler:async({additional,run,workId,actionId,signal},args)=>{if(!additional?.attachment)throw new Error('Attachment adapter unavailable');return{value:await additional.attachment(run,workId,actionId,args,signal)};}}),
  spec({name:'research.read',schema:z.object({url:z.string().url().max(4000)}).strict(),description:'Read one allowed research URL through the configured network boundary.',workPolicy:'current',seatPolicy:'deny',effectPolicy:'pure-read',replayPolicy:'boundary-owned',authorize:authorizeReferences,postAwait:fence,handler:async({additional,signal},args)=>{if(!additional)throw new Error('Research unavailable');return{value:await additional.research(args.url,signal)};}}),
  spec({name:'artifact.publish',schema:z.object({path:id,title:z.string().min(1).max(200),target:targetSchema,format:z.enum(['text','binary']).optional(),text:text.optional(),viewToken:id.optional()}).strict(),description:'Freeze an Agent-readable file and create a gated publication draft.',workPolicy:'broker-managed',seatPolicy:'deny',effectPolicy:'adapter-recorded',replayPolicy:'boundary-owned',authorize:authorizeReferences,postAwait:fence,handler:async({additional,run,workId,actionId,signal},args)=>{if(!additional)throw new Error('Publication unavailable');return{value:await additional.publish(run,workId,actionId,args,signal)};}}),
  spec({name:'artifact.revise',schema:z.object({draftId:id,revision:z.number().int().positive(),path:id,title:z.string().min(1).max(200),target:targetSchema,format:z.enum(['text','binary']).optional(),text:text.optional()}).strict(),description:'Replace the frozen content for an existing publication draft.',workPolicy:'broker-managed',seatPolicy:'deny',effectPolicy:'adapter-recorded',replayPolicy:'boundary-owned',authorize:authorizeReferences,postAwait:fence,handler:async({additional,run,workId,actionId,signal},args)=>{if(!additional)throw new Error('Publication unavailable');return{value:await additional.publish(run,workId,actionId,args,signal)};}})
];

export const capabilitiesModule:ToolModule=Object.freeze({domain:'capabilities',specs:Object.freeze(definitions)});
