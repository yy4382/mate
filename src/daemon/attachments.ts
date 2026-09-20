import type {WebClient}from '@slack/web-api';
import type {Collaboration}from '../collaboration/service.js';
import type {Broker}from '../policy/broker.js';
import type {RunToken}from '../storage/store.js';
import {messageKey,type NormalMessage}from '../slack/messages.js';
export interface AttachmentArgs{message:{channel:string;ts:string};fileId:string;grantId:string;path:string}
/** Only file IDs on an observed, currently visible message are accepted; URLs/credentials are never model arguments. */
export class Attachments{
 constructor(readonly c:Collaboration,readonly broker:Broker,readonly clients:Map<string,WebClient>){}
 private visible(run:RunToken,args:AttachmentArgs):void{
  const m=this.c.messages;m.store.assertRun(run);m.requireReadable(run.agentId);m.requireAccess(run.agentId,args.message.channel);
  const row=m.store.db.prepare('SELECT m.body FROM messages m JOIN message_visibility v ON v.key=m.key WHERE v.agent_id=? AND m.key=? AND m.deleted=0').get(run.agentId,messageKey({team:this.c.config.teamId,...args.message})) as {body:string}|undefined;
  if(!row||!(JSON.parse(row.body) as NormalMessage).files?.some(file=>file.id===args.fileId))throw new Error('Attachment is not on a visible message');
 }
 async save(run:RunToken,workId:string,actionId:string,args:AttachmentArgs,signal:AbortSignal):Promise<unknown>{
  this.visible(run,args);this.c.assertActionWork(run,workId);signal=AbortSignal.any([signal,AbortSignal.timeout(30000)]);
  const client=this.clients.get(run.agentId);if(!client?.token)throw new Error('Missing attachment client');
  const info=await client.files.info({file:args.fileId});this.visible(run,args);signal.throwIfAborted();
  if(!info.file||info.file.id!==args.fileId||!info.file.url_private||!Number.isFinite(info.file.size)||info.file.size!>1000000)throw new Error('Attachment unavailable or exceeds 1 MB');
  const url=new URL(info.file.url_private);
  if(url.protocol!=='https:'||url.port||url.username||url.password||!['files.slack.com','slack.com'].includes(url.hostname)||!url.pathname.startsWith('/files-pri/'))throw new Error('Unsupported Slack download URL');
  const response=await fetch(url,{headers:{Authorization:`Bearer ${client.token}`},redirect:'error',signal});
  if(!response.ok||!response.body)throw new Error('Attachment download failed');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1000000)throw new Error('Attachment exceeds 1 MB');chunks.push(part.value);}}finally{await reader.cancel();}
  const bytes=Buffer.concat(chunks);if(bytes.length!==info.file.size)throw new Error('Incomplete attachment download');
  this.visible(run,args);signal.throwIfAborted();this.c.assertActionWork(run,workId);
  const receipt=await this.broker.execute(run,workId,actionId,args.grantId,{kind:'write_bytes',path:args.path,base64:bytes.toString('base64')},signal);
  return{fileId:args.fileId,path:args.path,bytes:bytes.length,receipt};
 }
}
