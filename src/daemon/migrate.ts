import {configureLocalRooms} from '../local/rooms.js';
import {localApplication} from '../local/application.js';
import {initializeCanonicalStore} from '../storage/internal-schema.js';
import {migrateProjections} from '../storage/projection-schema.js';
import {migrateProjectionImports} from '../storage/projection-import-schema.js';
import {migrateInternalConversations} from '../storage/internal-schema.js';
import {migrateHistoryIndexes} from '../storage/history-schema.js';
import {migrateCoordinationRecovery} from '../storage/coordination-schema.js';
import {migrateOperationsView} from '../storage/operations-schema.js';
import { slackApplication } from '../slack/application.js';
import { migrateCanonicalConversations } from '../slack/canonical-migration.js';
import { CanonicalOutput as Output } from '../conversations/output.js';
import {existsSync,lstatSync,realpathSync}from 'node:fs';
import {join,resolve}from 'node:path';
import type {AgentMessage}from '@earendil-works/pi-agent-core';
import {sameConfiguration,daemonConfigSchema,slackRuntimeConfig,assertConfigurationEvolution,type DaemonConfig}from './config.js';
import {Store,encode,hash}from '../storage/store.js';
import {acquireLock}from './lock.js';
import {backup}from './backup.js';
import {assertDockerControlIsolation,executionProtectedPaths,executionScope,pathVariants}from './paths.js';
import {ContainerBackend}from '../execution/container.js';
import {canonicalRoot,within}from '../execution/paths.js';
import {buildBaseline}from '../runtime/prompt.js';
import {operationDocumentation}from '../runtime/tools.js';
import {repairTranscript}from '../runtime/context.js';
import {SessionLifecycle}from '../runtime/sessions.js';
import {normalizeConfiguredWorkspaces}from '../capabilities/workspaces.js';
import {nodeDeploymentEnvironment,verifyDeploymentWorkspaces,type DeploymentEnvironment}from '../deployment/runtime.js';

import {Collaboration}from '../collaboration/service.js';

export function storedConfiguration(store:Store):DaemonConfig|undefined{
 const row=store.db.prepare("SELECT value FROM runtime_meta WHERE key='configuration'").get() as {value:string}|undefined;return row?daemonConfigSchema.parse(JSON.parse(row.value)):undefined;
}
export function saveConfiguration(store:Store,config:DaemonConfig):void{
 store.db.prepare("INSERT INTO runtime_meta VALUES('configuration',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(encode(daemonConfigSchema.parse(config)));
 store.db.prepare("INSERT INTO runtime_meta VALUES('policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(hash(encode(config.runtime)));
}
function matchesRecordedRuntimePolicy(store:Store,previous:DaemonConfig,policy:string):boolean{
 if(policy===hash(encode(previous.runtime)))return true;
 const row=store.db.prepare("SELECT value FROM runtime_meta WHERE key='configuration'").get() as {value:string}|undefined;
 if(row){
  const raw=JSON.parse(row.value) as {runtime?:unknown};
  if(raw.runtime&&sameConfiguration(daemonConfigSchema.parse(raw),previous)&&policy===hash(encode(raw.runtime)))return true;
 }
 const defaults={maxActiveRuns:1,maxBackendOperations:1,workerIdleMs:300000};
 if(encode(previous.runtime.limits)===encode(defaults)){
  const {limits:_,...preLimitsRuntime}=previous.runtime;
  if(policy===hash(encode(preLimitsRuntime)))return true;
 }
 return false;
}
/** Explicit local owner operation. No Slack or model credentials required. */
export async function migrateConfiguration(previous:DaemonConfig,next:DaemonConfig,destination:string,acceptLegacyIdentity=false,projectRoot=resolve('.'),environment:DeploymentEnvironment=nodeDeploymentEnvironment()):Promise<{backup:string;agents:string[];legacyIdentityAttested:boolean}>{
 if(previous.runtime.workspaceManifest||next.runtime.workspaceManifest)throw new Error('Managed deployment migration requires the sealed checkpoint upgrade workflow');
 const data=previous.runtime.dataDir,state=join(data,'state');
 for(const path of [data,state,join(data,'agents')])if(lstatSync(path).isSymbolicLink())throw new Error('Migration paths must not be symlinks');
 if(resolve(data)!==resolve(next.runtime.dataDir)||lstatSync(data).isSymbolicLink()||lstatSync(state).isSymbolicLink())throw new Error('Migration requires the same non-symlink data directory');
 if(!existsSync(join(state,'mate.sqlite')))throw new Error('Migration requires an existing database');
 const release=acquireLock(join(state,'daemon.lock'));let store:Store|undefined;
 try{
  const agentsDir=join(data,'agents');
  assertDockerControlIsolation(projectRoot,state,agentsDir,previous.runtime.workspaceGrants,previous.runtime.docker,previous.runtime.workspaceManifest?[previous.runtime.workspaceManifest]:[]);
  assertDockerControlIsolation(projectRoot,state,agentsDir,next.runtime.workspaceGrants,next.runtime.docker,next.runtime.workspaceManifest?[next.runtime.workspaceManifest]:[]);
  if(previous.runtime.docker)await new ContainerBackend({...previous.runtime.docker,scope:executionScope(data)}).recover();
  const verifiedWorkspaces=verifyDeploymentWorkspaces(next,environment);
  store=new Store(join(state,'mate.sqlite'));const s=store,recorded=storedConfiguration(s);
  if(recorded&&!sameConfiguration(recorded,previous))throw new Error('Previous configuration does not match persisted configuration');
  if(!recorded&&!acceptLegacyIdentity)throw new Error('Legacy identity snapshot unavailable; supply trusted OLD_CONFIG and --accept-legacy-identity explicitly');
  const policy=s.db.prepare("SELECT value FROM runtime_meta WHERE key='policy'").get() as {value:string}|undefined;
  if(!policy||!matchesRecordedRuntimePolicy(s,previous,policy.value))throw new Error('Previous runtime policy does not match database');
  const oldIds=(s.db.prepare('SELECT id FROM agents ORDER BY id').all() as {id:string}[]).map(a=>a.id);
  if(encode(oldIds)!==encode(previous.mate.agents.map(a=>a.id).sort()))throw new Error('Previous Agent identities do not match database');
  assertConfigurationEvolution(previous,next);
  const protectedRoots=[...executionProtectedPaths(projectRoot,state,agentsDir,next.runtime.docker),...(verifiedWorkspaces?.protectedPaths??[])];
  const configured=normalizeConfiguredWorkspaces(next.runtime.workspaceGrants,protectedRoots);
  const privateBase=new Set(pathVariants(agentsDir)),privateForbidden=protectedRoots.filter(root=>!privateBase.has(root));
  const roots=new Map<string,Map<string,string[]>>();
  for(const agent of next.mate.agents){
   const own=join(agentsDir,agent.id);
   if(existsSync(own)&&lstatSync(own).isSymbolicLink())throw new Error('Agent memory must not be a symlink');
   if(existsSync(own))canonicalRoot(own,privateForbidden);else if(privateForbidden.some(path=>within(resolve(own),path)||within(path,resolve(own))))throw new Error('Protected root overlap');
   // New Agent private directories are created by normal daemon startup.
   const desired=new Map<string,string[]>([[existsSync(own)?canonicalRoot(own,[projectRoot,state]):resolve(own),next.runtime.docker?['read','write','exec']:['read','write']]]);
   for(const grant of configured.filter(g=>g.agentId===agent.id)){
    desired.set(grant.root,[...new Set([...(desired.get(grant.root)??[]),...grant.operations])]);
   }roots.set(agent.id,desired);
  }
  s.recover();
  await backup(s,data,resolve(destination),previous);
  s.atomic(()=>{
   const oldSlack=slackRuntimeConfig(previous),newSlack=slackRuntimeConfig(next);
   if(oldSlack)migrateCanonicalConversations(s,oldSlack);else initializeCanonicalStore(s);
   migrateInternalConversations(s);migrateProjections(s);migrateProjectionImports(s);migrateHistoryIndexes(s);migrateCoordinationRecovery(s);migrateOperationsView(s);
   const {messages}=(newSlack?slackApplication(s,newSlack,next.mate):localApplication(s,next.mate)),c=new Collaboration(s,messages,new Output(messages,{post:async()=>{throw new Error('Offline migration cannot publish');},pendingInput:()=>false,classify:()=>({kind:'unknown'})}),next.mate);
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
   configureLocalRooms(c,previous.adapters.local,next.adapters.local);
   saveConfiguration(s,next);
   s.audit('configuration_migration',{backup:resolve(destination),oldHash:hash(encode(previous)),newHash:hash(encode(next)),legacyIdentityAttested:!recorded,grantPolicy:'removed roots revoked; active grants match new policy; revoked/expired grants preserved; budgets unchanged'});
  });
  return{backup:resolve(destination),agents:next.mate.agents.map(a=>a.id),legacyIdentityAttested:!recorded};
 }finally{store?.close();release();}
}
