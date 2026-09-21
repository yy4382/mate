import {z} from 'zod';
import {operationSchema} from '../../execution/backend.js';
import {conversationTargetSchema as targetSchema} from '../../domain/conversations.js';
import {authorizeReferences,fence,id,spec,text,type ToolModule,type ToolSpec} from '../tool-contract.js';

export const fileSchemas=Object.fromEntries(operationSchema.options.filter(schema=>schema.shape.kind.value!=='exec').map(schema=>[`file.${schema.shape.kind.value}`,(schema as z.ZodObject).omit({kind:true}).extend({grantId:id})])) as Record<string,z.ZodType>;
const descriptions:Record<string,string>={
  'file.read_bytes':'Read up to 32 KiB binary bytes at an offset, returning base64, file size and full SHA256. Files up to 1 MB.',
  'file.write_bytes':'Atomically write canonical base64 bytes, decoded size up to 1 MB, in the granted workspace.',
  'file.list':'List up to 200 directory entries (48 KB); truncated indicates remaining entries.',
  'file.search':'Recursively find literal text in UTF-8 files up to 1 MB; at most 1000 visited paths, 100 matches and 45 KB.',
  'file.stat':'Inspect file type, size and SHA256 for regular files up to 1 MB.',
  'file.read':'Read up to 64 KiB UTF-8 text. Use search or exec for larger files.',
  'file.write':'Atomically write up to 1 MB UTF-8 text and preserve five previous versions.',
  'file.edit':'Edit only if expectedHash matches and oldText occurs exactly once.',
  'file.move':'Move or rename within the granted workspace; destination must not exist.',
  'file.remove':'Remove a regular file or empty directory, optionally checking expectedHash.',
  'file.mkdir':'Create a directory and missing parents within the granted workspace.'
};
const files=Object.entries(fileSchemas).map(([name,schema])=>spec({name,schema,description:descriptions[name]??`Execute ${name} in a granted workspace.`,workPolicy:'broker-managed',seatPolicy:'clean-workspace',effectPolicy:'broker-recorded',replayPolicy:'boundary-owned',authorize:authorizeReferences,postAwait:fence,handler:async({broker,run,workId,actionId,signal},args)=>({value:await broker.execute(run,workId,actionId,args.grantId,operationSchema.parse({...Object.fromEntries(Object.entries(args).filter(([key])=>key!=='grantId')),kind:name.slice(5)}),signal)})}));

const definitions:ToolSpec[]=[...files,
  spec({name:'exec',schema:z.object({grantId:id,command:z.string().max(16000),cwd:id}).strict(),description:'Run a shell command in the configured container and granted workspace.',workPolicy:'broker-managed',seatPolicy:'clean-workspace',effectPolicy:'broker-recorded',replayPolicy:'boundary-owned',authorize:authorizeReferences,postAwait:fence,handler:async({broker,run,workId,actionId,signal},args)=>({value:await broker.execute(run,workId,actionId,args.grantId,operationSchema.parse({command:args.command,cwd:args.cwd,kind:'exec'}),signal)})}),
  spec({name:'attachments.save',schema:z.object({message:z.object({messageId:id}).strict(),fileId:id,grantId:id,path:id}).strict(),description:'Download a file attached to a visible message into a granted workspace path, up to 1 MB.',workPolicy:'broker-managed',seatPolicy:'deny',effectPolicy:'adapter-recorded',replayPolicy:'boundary-owned',authorize:authorizeReferences,postAwait:fence,handler:async({additional,run,workId,actionId,signal},args)=>{if(!additional?.attachment)throw new Error('Attachment adapter unavailable');return{value:await additional.attachment(run,workId,actionId,args,signal)};}}),
  spec({name:'research.read',schema:z.object({url:z.string().url().max(4000)}).strict(),description:'Read one allowed research URL through the configured network boundary.',workPolicy:'current',seatPolicy:'deny',effectPolicy:'pure-read',replayPolicy:'boundary-owned',authorize:authorizeReferences,postAwait:fence,handler:async({additional,signal},args)=>{if(!additional)throw new Error('Research unavailable');return{value:await additional.research(args.url,signal)};}}),
  spec({name:'artifact.publish',schema:z.object({grantId:id,path:id,title:z.string().min(1).max(200),target:targetSchema,format:z.enum(['text','binary']).optional(),text:text.optional(),viewToken:id.optional()}).strict(),description:'Freeze an own artifact and create a gated publication draft.',workPolicy:'broker-managed',seatPolicy:'deny',effectPolicy:'adapter-recorded',replayPolicy:'boundary-owned',authorize:authorizeReferences,postAwait:fence,handler:async({additional,run,workId,actionId,signal},args)=>{if(!additional)throw new Error('Publication unavailable');return{value:await additional.publish(run,workId,actionId,args,signal)};}}),
  spec({name:'artifact.revise',schema:z.object({draftId:id,revision:z.number().int().positive(),grantId:id,path:id,title:z.string().min(1).max(200),target:targetSchema,format:z.enum(['text','binary']).optional(),text:text.optional()}).strict(),description:'Replace the frozen content for an existing publication draft.',workPolicy:'broker-managed',seatPolicy:'deny',effectPolicy:'adapter-recorded',replayPolicy:'boundary-owned',authorize:authorizeReferences,postAwait:fence,handler:async({additional,run,workId,actionId,signal},args)=>{if(!additional)throw new Error('Publication unavailable');return{value:await additional.publish(run,workId,actionId,args,signal)};}})
];

export const capabilitiesModule:ToolModule=Object.freeze({domain:'capabilities',specs:Object.freeze(definitions)});
