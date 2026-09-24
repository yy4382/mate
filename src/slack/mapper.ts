import type { MateConfig } from '../config.js';
import type { References } from '../conversations/references.js';
import type { ConversationTarget } from '../domain/conversations.js';
import { parseMessage, type MessageDTO } from '../domain/messages.js';
import { slackPrincipal } from './legacy-codec.js';
import { slackTs } from './protocol.js';

export interface SlackMessageInput {
  channel:string;ts:string;thread?:string|undefined;revision:string;text:string;deleted:boolean;
  user?:string|undefined;bot?:string|undefined;system?:boolean|undefined;
  files?:{id:string;name?:string|undefined;title?:string|undefined;mimetype?:string|undefined;size?:number|undefined}[]|undefined;
}
/** Provider identity mapping only. Callers still enforce current membership and action authorization. */
export class SlackMapper {
  constructor(readonly references:References,readonly config:MateConfig){}
  conversation(channel:string):string {
    if(!/^[CDG][A-Z0-9]+$/.test(channel))throw new Error('Invalid external conversation');
    const locator={provider:'slack',workspace:this.config.teamId,externalId:channel};
    const found=this.references.findConversation(locator);
    if(found){if(this.references.conversation(found).authority!=='external')throw new Error('Projection import is not installed');return found;}
    const identity=this.references.createConversation(channel.startsWith('D')?'dm':'channel','external');
    this.references.bindConversation(locator,identity.id,'primary');return identity.id;
  }
  messageId(channel:string,ts:string):string {
    slackTs.parse(ts);const conversationId=this.conversation(channel);
    const locator={provider:'slack',workspace:this.config.teamId,externalId:channel,messageId:ts};
    const existing=this.references.findMessage(locator);if(existing)return existing;
    const identity=this.references.reserveMessage(conversationId);this.references.bindMessage(locator,identity.id);return identity.id;
  }
  target(target:ConversationTarget):{channel:string;thread?:string} {
    this.references.validateTarget(target);
    const binding=this.references.primaryBinding(target.conversationId);
    if(binding.provider!=='slack'||binding.workspace!==this.config.teamId)throw new Error('Conversation does not belong to this adapter');
    if(!target.threadId)return{channel:binding.externalId};
    const root=this.references.messageBinding(target.threadId,'slack',this.config.teamId,binding.externalId);
    if(!root)throw new Error('External thread root is not bound');return{channel:binding.externalId,thread:root.messageId};
  }
  message(input:SlackMessageInput):MessageDTO {
    const id=this.messageId(input.channel,input.ts),identity=this.references.message(id);
    const rootId=input.thread?this.messageId(input.channel,input.thread):input.deleted?identity.rootId:identity.rootId??id;
    const integer=(value:string)=>{slackTs.parse(value);const[whole,fraction]=value.split('.');return(BigInt(whole!)*1000000n+BigInt(fraction!.padEnd(6,'0'))).toString();};
    return parseMessage({id,conversationId:identity.conversationId,rootId,author:slackPrincipal(this.config,input.user,input.bot),origin:input.system?'system':'participant',
      mentions:input.deleted?[]:[...new Set([...input.text.matchAll(/<@(U[A-Z0-9]+)>/g)].map(match=>match[1]!))].map(user=>slackPrincipal(this.config,user)),
      text:input.deleted?'':input.text,deleted:input.deleted,order:integer(input.ts),revision:integer(input.revision),attachments:input.files??[],
    });
  }
  participates(actor:string,conversationId:string):boolean {
    const agent=this.config.agents.find(a=>a.id===actor);if(!agent)return false;
    const binding=this.references.primaryBinding(conversationId);
    return binding.provider==='slack'&&binding.workspace===this.config.teamId&&agent.channels[binding.externalId]==='participate';
  }
}
