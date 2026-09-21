import type {Store} from '../storage/store.js';
import {ConfiguredAgents} from '../agents/directory.js';
import type {TeamSettings} from '../domain/agents.js';
import {initializeCanonicalStore,migrateInternalConversations} from '../storage/internal-schema.js';
import {References} from '../conversations/references.js';
import {ConversationRecords} from '../storage/conversations.js';
import {CanonicalWrites} from '../storage/conversation-writes.js';
import {Conversations} from '../conversations/messages.js';
import {CanonicalOutput} from '../conversations/output.js';
import {CanonicalFreshnessGate} from '../conversations/freshness.js';
import {Collaboration} from '../collaboration/service.js';
import {TeamDirectory} from '../conversations/team-directory.js';
import {LocalAdapter} from './input.js';
import {migrateProjections}from '../storage/projection-schema.js';
import {migrateProjectionImports}from '../storage/projection-import-schema.js';
import {migrateHistoryIndexes}from '../storage/history-schema.js';
import {migrateCoordinationRecovery}from '../storage/coordination-schema.js';

/** A real local composition: no Slack config, fake locator or alternate business model. */
export function localApplication(store:Store,settings:TeamSettings){
  initializeCanonicalStore(store);migrateInternalConversations(store);migrateProjections(store);migrateProjectionImports(store);migrateHistoryIndexes(store);migrateCoordinationRecovery(store);
  const messages=localConversations(store,settings);
  const output=new CanonicalOutput(messages,{post:async()=>{throw new Error('External transport unavailable');},pendingInput:()=>false,classify:()=>({kind:'rejected',reason:'External transport unavailable'})});
  const collaboration=new Collaboration(store,messages,output,settings);
  output.gate=new CanonicalFreshnessGate(messages,collaboration.attention);
  const directory=new TeamDirectory(messages),input=new LocalAdapter(collaboration,settings.ownerUserIds);
  return{messages,output,collaboration,directory,input};
}

/** Application composition shared by the local-only daemon and small embedded harnesses. */
export function localConversations(store:Store,settings:TeamSettings):Conversations {
  const agents=new ConfiguredAgents(settings.agents),references=new References(store);
  const records=new ConversationRecords(store,references),writes=new CanonicalWrites(store,references);
  const messages=new Conversations(store,agents,references,records,writes,{participates:()=>true},undefined,()=>{throw new Error('External publication unavailable');});
  return messages;
}
