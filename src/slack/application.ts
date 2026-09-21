import {slackTextMatches} from './text.js';
import type {MateConfig} from '../config.js';
import type {Store} from '../storage/store.js';
import {ConfiguredAgents} from '../agents/directory.js';
import {Conversations} from '../conversations/messages.js';
import {References} from '../conversations/references.js';
import {ConversationRecords} from '../storage/conversations.js';
import {CanonicalWrites} from '../storage/conversation-writes.js';
import {LegacyConversationCodec} from './legacy-codec.js';
import {LegacyArguments} from './legacy-arguments.js';
import {SlackMapper} from './mapper.js';

/** Composition only: core depends on ports, never on this adapter bootstrap. */
export function slackApplication(store:Store,config:MateConfig){
 const references=new References(store),legacy=new LegacyConversationCodec(references,config),argumentsCodec=new LegacyArguments(references,config),mapper=new SlackMapper(references,config);
 const records=new ConversationRecords(store,references,legacy),writes=new CanonicalWrites(store,references,value=>argumentsCodec.effect(value));
 const messages=new Conversations(store,new ConfiguredAgents(config.agents),references,records,writes,mapper,slackTextMatches);
 return{messages,mapper,argumentsCodec};
}
