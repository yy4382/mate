import {migrateInternalConversations} from '../storage/internal-schema.js';
import { slackApplication } from '../slack/application.js';
import { migrateCanonicalConversations } from '../slack/canonical-migration.js';
import { CanonicalOutput as Output } from '../conversations/output.js';
import {existsSync,lstatSync,realpathSync}from 'node:fs';
import {join,resolve}from 'node:path';
import type {AgentMessage}from '@earendil-works/pi-agent-core';
import {sameConfiguration,type DaemonConfig}from './config.js';
import {Store,encode,hash}from '../storage/store.js';
import {acquireLock}from './lock.js';
import {backup}from './backup.js';
import {executionScope}from './paths.js';
import {ContainerBackend}from '../execution/container.js';
import {canonicalRoot}from '../execution/paths.js';
import {buildBaseline}from '../runtime/prompt.js';
import {operationDocumentation}from '../runtime/tools.js';
import {repairTranscript}from '../runtime/context.js';
import {SessionLifecycle}from '../runtime/sessions.js';

import {Collaboration}from '../collaboration/service.js';

export function storedConfiguration(store:Store):DaemonConfig|undefined{
 const row=store.db.prepare("SELECT value FROM runtime_meta WHERE key='configuration'").get() as {value:string}|undefined;return row?JSON.parse(row.value):undefined;
}
export function saveConfiguration(store:Store,config:DaemonConfig):void{
 store.db.prepare("INSERT INTO runtime_meta VALUES('configuration',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(encode(config));
 store.db.prepare("INSERT INTO runtime_meta VALUES('policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(hash(encode(config.runtime)));
}
/** Explicit local owner operation. No Slack or model credentials required. */
export async function migrateConfiguration(previous:DaemonConfig,next:DaemonConfig,destination:string,acceptLegacyIdentity=false,projectRoot=resolve('.')):Promise<{backup:string;agents:string[];legacyIdentityAttested:boolean}>{
 const data=previous.runtime.dataDir,state=join(data,'state');
 for(const path of [data,state,join(data,'agents')])if(lstatSync(path).isSymbolicLink())throw new Error('Migration paths must not be symlinks');
 if(resolve(data)!==resolve(next.runtime.dataDir)||lstatSync(data).isSymbolicLink()||lstatSync(state).isSymbolicLink())throw new Error('Migration requires the same non-symlink data directory');
 if(!existsSync(join(state,'mate.sqlite')))throw new Error('Migration requires an existing database');
 const release=acquireLock(join(state,'daemon.lock'));let store:Store|undefined;
 try{
  store=new Store(join(state,'mate.sqlite'));const s=store,recorded=storedConfiguration(s);
  if(recorded&&!sameConfiguration(recorded,previous))throw new Error('Previous configuration does not match persisted configuration');
  if(!recorded&&!acceptLegacyIdentity)throw new Error('Legacy identity snapshot unavailable; supply trusted OLD_CONFIG and --accept-legacy-identity explicitly');
  const policy=s.db.prepare("SELECT value FROM runtime_meta WHERE key='policy'").get() as {value:string}|undefined;
  if(!policy||policy.value!==hash(encode(previous.runtime)))throw new Error('Previous runtime policy does not match database');
  const oldIds=(s.db.prepare('SELECT id FROM agents ORDER BY id').all() as {id:string}[]).map(a=>a.id);
  if(encode(oldIds)!==encode(previous.mate.agents.map(a=>a.id).sort()))throw new Error('Previous Agent identities do not match database');
  if(previous.mate.teamId!==next.mate.teamId)throw new Error('Workspace identity cannot be rebound');
  for(const old of previous.mate.agents){
   const agent=next.mate.agents.find(a=>a.id===old.id);
   if(!agent||['slackAppId','slackUserId','slackBotId'].some(key=>agent[key as keyof typeof agent]!==old[key as keyof typeof old]))throw new Error('Existing Agent identities cannot be removed or rebound');
  }
  const roots=new Map<string,Map<string,string[]>>();
  for(const agent of next.mate.agents){
   const own=join(data,'agents',agent.id);
   if(existsSync(own)&&lstatSync(own).isSymbolicLink())throw new Error('Agent memory must not be a symlink');
   // New Agent private directories are created by normal daemon startup.
   const desired=new Map<string,string[]>([[existsSync(own)?canonicalRoot(own,[projectRoot,state]):resolve(own),next.runtime.docker?['read','write','exec']:['read','write']]]);
   for(const grant of next.runtime.workspaceGrants.filter(g=>g.agentId===agent.id)){
    const root=canonicalRoot(grant.root,[projectRoot,state,join(data,'agents')]);
    desired.set(root,[...new Set([...(desired.get(root)??[]),...grant.operations])]);
   }roots.set(agent.id,desired);
  }
  if(previous.runtime.docker)await new ContainerBackend({...previous.runtime.docker,scope:executionScope(data)}).recover();
  s.recover();
  await backup(s,data,resolve(destination));
  s.atomic(()=>{
   migrateCanonicalConversations(s,previous.mate);
   migrateInternalConversations(s);
   const {messages}=slackApplication(s,next.mate),c=new Collaboration(s,messages,new Output(messages,{post:async()=>{throw new Error('Offline migration cannot publish');},pendingInput:()=>false,classify:()=>({kind:'unknown'})}),next.mate);
   const baseline=(agent:import('../domain/agents.js').AgentDefinition)=>buildBaseline(agent,operationDocumentation);
   const lifecycle=new SessionLifecycle(c,baseline);
   for(const agent of next.mate.agents){
    const initial=baseline(agent),row=s.db.prepare('SELECT session_id FROM agents WHERE id=?').get(agent.id) as {session_id:string}|undefined;
    if(!row){s.register(agent.id,initial.configVersion,initial.messages);continue;}
    if(lifecycle.apply(agent.id))continue;
    const history=repairTranscript(s.context(row.session_id) as AgentMessage[],id=>{
     const action=s.action(`${row.session_id}:${id}`);return action?encode({recoveredAction:action.id,state:action.state,receipt:action.receipt?JSON.parse(action.receipt):null}):undefined;
    });
    s.rotateSession(agent.id,initial.configVersion,[...initial.messages,...history.filter(message=>message.role!=='system')],'configuration_migration');
   }
   for(const grant of s.db.prepare('SELECT id,agent_id,root,revoked,expires FROM grants').all() as {id:string;agent_id:string;root:string;revoked:number;expires:number}[]){
    const allowed=roots.get(grant.agent_id)?.get(grant.root);
    if(!allowed)s.db.prepare('UPDATE grants SET revoked=1 WHERE id=?').run(grant.id);
    else if(!grant.revoked&&grant.expires>Date.now())s.db.prepare('UPDATE grants SET operations=? WHERE id=?').run(encode(allowed),grant.id);
   }
   saveConfiguration(s,next);
   s.audit('configuration_migration',{backup:resolve(destination),oldHash:hash(encode(previous)),newHash:hash(encode(next)),legacyIdentityAttested:!recorded,grantPolicy:'removed roots revoked; active grants match new policy; revoked/expired grants preserved; budgets unchanged'});
  });
  return{backup:resolve(destination),agents:next.mate.agents.map(a=>a.id),legacyIdentityAttested:!recorded};
 }finally{store?.close();release();}
}
