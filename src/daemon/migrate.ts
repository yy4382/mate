import {configureLocalRooms} from '../local/rooms.js';
import {localApplication} from '../local/application.js';
import {initializeCanonicalStore} from '../storage/internal-schema.js';
import {migrateProjections} from '../storage/projection-schema.js';
import {migrateProjectionImports} from '../storage/projection-import-schema.js';
import {migrateInternalConversations} from '../storage/internal-schema.js';
import {migrateHistoryIndexes} from '../storage/history-schema.js';
import {migrateCoordinationRecovery} from '../storage/coordination-schema.js';
import {migrateOperationsView} from '../storage/operations-schema.js';
import {migrateSystemOperations} from '../storage/system-operations-schema.js';
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
import {buildBaseline}from '../runtime/prompt.js';
import {operationDocumentation}from '../runtime/tools.js';
import {repairTranscript}from '../runtime/context.js';
import {SessionLifecycle}from '../runtime/sessions.js';

import {Collaboration}from '../collaboration/service.js';

export function storedConfiguration(store:Store):DaemonConfig|undefined{
 const row=store.db.prepare("SELECT value FROM runtime_meta WHERE key='configuration'").get() as {value:string}|undefined;return row?daemonConfigSchema.parse(JSON.parse(row.value)):undefined;
}
export function saveConfiguration(store:Store,config:DaemonConfig):void{
 store.db.prepare("INSERT INTO runtime_meta VALUES('configuration',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(encode(daemonConfigSchema.parse(config)));
 store.db.prepare("INSERT INTO runtime_meta VALUES('policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(hash(encode(config.runtime)));
}
export interface OfflineMigrationOptions{
 auditSource:string;
}
export interface OfflineMigrationResult{agents:string[]}

function assertMigrationIdentity(s:Store,previous:DaemonConfig,next:DaemonConfig):void{
 const recorded=storedConfiguration(s);
 if(!recorded)throw new Error('Migration requires a stored configuration');
 if(!sameConfiguration(recorded,previous))throw new Error('Previous configuration does not match persisted configuration');
 const policy=s.db.prepare("SELECT value FROM runtime_meta WHERE key='policy'").get() as {value:string}|undefined;
 if(!policy||policy.value!==hash(encode(previous.runtime)))throw new Error('Previous runtime policy does not match database');
 const oldIds=(s.db.prepare('SELECT id FROM agents ORDER BY id').all() as {id:string}[]).map(agent=>agent.id);
 if(encode(oldIds)!==encode(previous.mate.agents.map(agent=>agent.id).sort()))throw new Error('Previous Agent identities do not match database');
 assertConfigurationEvolution(previous,next);
}

function prepareMigrationBoundary(s:Store,previous:DaemonConfig,next:DaemonConfig):void{
 assertMigrationIdentity(s,previous,next);
 if(resolve(previous.runtime.dataDir)!==resolve(next.runtime.dataDir))throw new Error('Migration requires the same data directory');
 for(const agent of next.mate.agents){const home=next.runtime.linuxUsers?.[agent.id]?.home;if(home&&(!existsSync(home)||lstatSync(home).isSymbolicLink()))throw new Error(`Provision the Linux Agent home before migration: ${agent.id}`);}
}

/** The only database-changing part of configuration migration. Callers own locking, backup/checkpoint and workspace verification. */
export function applyOfflineConfigurationMigration(s:Store,previous:DaemonConfig,next:DaemonConfig,options:OfflineMigrationOptions):OfflineMigrationResult{
 const oldConfigurationHash=hash(encode(previous)),newConfigurationHash=hash(encode(next));
 prepareMigrationBoundary(s,previous,next);
 s.atomic(()=>{
  const oldSlack=slackRuntimeConfig(previous),newSlack=slackRuntimeConfig(next);
  if(oldSlack)migrateCanonicalConversations(s,oldSlack);else initializeCanonicalStore(s);
  migrateInternalConversations(s);migrateProjections(s);migrateProjectionImports(s);migrateHistoryIndexes(s);migrateCoordinationRecovery(s);migrateOperationsView(s);migrateSystemOperations(s);
  const {messages}=(newSlack?slackApplication(s,newSlack,next.mate):localApplication(s,next.mate)),c=new Collaboration(s,messages,new Output(messages,{post:async()=>{throw new Error('Offline migration cannot publish');},pendingInput:()=>false,classify:()=>({kind:'unknown'})}),next.mate);
  const baseline=(agent:import('../domain/agents.js').AgentDefinition)=>buildBaseline(agent,operationDocumentation),lifecycle=new SessionLifecycle(c,baseline);
  for(const agent of next.mate.agents){
   const initial=baseline(agent),row=s.db.prepare('SELECT session_id FROM agents WHERE id=?').get(agent.id) as {session_id:string}|undefined;
   if(!row){s.register(agent.id,initial.configVersion,initial.messages);continue;}
   if(lifecycle.apply(agent.id))continue;
   const history=repairTranscript(s.context(row.session_id) as AgentMessage[],id=>{const action=s.action(`${row.session_id}:${id}`);return action?encode({recoveredAction:action.id,state:action.state,receipt:action.receipt?JSON.parse(action.receipt):null}):undefined;});
   s.rotateSession(agent.id,initial.configVersion,[...initial.messages,...history.filter(message=>message.role!=='system')],'configuration_migration');
  }
  configureLocalRooms(c,previous.adapters.local,next.adapters.local);saveConfiguration(s,next);
  s.audit('configuration_migration',{source:options.auditSource,oldHash:oldConfigurationHash,newHash:newConfigurationHash,budgets:'unchanged'});
 });
 return{agents:next.mate.agents.map(agent=>agent.id)};
}
/** Explicit local owner operation. No Slack or model credentials required. */
export async function migrateConfiguration(previous:DaemonConfig,next:DaemonConfig,destination:string):Promise<{backup:string;agents:string[]}>{
 const data=previous.runtime.dataDir,state=join(data,'state');
 for(const path of [data,state,...(previous.runtime.linuxUsers?Object.values(previous.runtime.linuxUsers).map(user=>user.home):[join(data,'agents')])])if(lstatSync(path).isSymbolicLink())throw new Error('Migration paths must not be symlinks');
 if(resolve(data)!==resolve(next.runtime.dataDir)||lstatSync(data).isSymbolicLink()||lstatSync(state).isSymbolicLink())throw new Error('Migration requires the same non-symlink data directory');
 if(!existsSync(join(state,'mate.sqlite')))throw new Error('Migration requires an existing database');
 const release=acquireLock(join(state,'daemon.lock'));let store:Store|undefined;
 try{
  store=new Store(join(state,'mate.sqlite'));const s=store,migrationOptions={auditSource:resolve(destination)};prepareMigrationBoundary(s,previous,next);s.recover();
  await backup(s,data,resolve(destination),previous);
  const result=applyOfflineConfigurationMigration(s,previous,next,migrationOptions);
  return{backup:resolve(destination),agents:result.agents};
 }finally{store?.close();release();}
}
