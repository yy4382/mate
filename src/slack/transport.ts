import {slackTextMatches} from './text.js';
import { WebClient } from '@slack/web-api';
import type { ExternalMessageTransport, DispatchEnvelope, DispatchFailure, MessageConfirmation } from '../conversations/output.js';
import type { ConversationTarget } from '../domain/conversations.js';
import type { Store } from '../storage/store.js';
import type { SlackMapper } from './mapper.js';

/** No automatic write retries. Immutable outbox identity crosses this boundary unchanged. */
export class CanonicalSlackTransport implements ExternalMessageTransport {
  readonly clients=new Map<string,WebClient>();
  constructor(readonly store:Store,readonly mapper:SlackMapper,tokens:Record<string,string>){
    for(const [actor,token]of Object.entries(tokens))this.clients.set(actor,new WebClient(token,{retryConfig:{retries:0},rejectRateLimitedCalls:true,timeout:15000}));
  }
  pendingInput(target:ConversationTarget):boolean {
    const external=this.mapper.target(target);
    return !!this.store.db.prepare("SELECT 1 FROM ingress WHERE normalized=0 AND (json_extract(body,'$.event.channel')=? OR json_extract(body,'$.command') IS NOT NULL)").get(external.channel);
  }
  async post(request:DispatchEnvelope):Promise<MessageConfirmation>{
    const client=this.clients.get(request.actor);if(!client)throw new Error('Missing Slack client');
    const target=this.mapper.target(request.target),agent=this.mapper.config.agents.find(a=>a.id===request.actor);if(!agent)throw new Error('Missing Slack identity');
    const result=await client.chat.postMessage({channel:target.channel,...(target.thread?{thread_ts:target.thread}:{}),text:request.text,
      metadata:{event_type:'mate_outbox',event_payload:{id:request.id,request_hash:request.requestHash}},unfurl_links:false,unfurl_media:false});
    if(!result.ts || (result.channel&&result.channel!==target.channel))throw new Error('Invalid Slack receipt');
    return{message:this.mapper.message({...target,ts:result.ts,revision:result.ts,text:request.text,deleted:false,user:agent.slackUserId,bot:agent.slackBotId}),receipt:{ts:result.ts}};
  }
  matchesText(expected:string,observed:string):boolean{return slackTextMatches(expected,observed);}
  classify(error:unknown):DispatchFailure{
    const e=error as {code?:string;retryAfter?:number;data?:{error?:string}};
    if(e?.code==='slack_webapi_rate_limited_error'&&Number.isFinite(e.retryAfter))return{kind:'retry',afterMs:Math.max(1,e.retryAfter!)*1000};
    if(e?.code==='slack_webapi_platform_error'&&['not_authed','invalid_auth','token_revoked','account_inactive','channel_not_found','not_in_channel','is_archived','msg_too_long','no_text','restricted_action','cannot_reply_to_message'].includes(e.data?.error??''))return{kind:'rejected',reason:e.data!.error!};
    return{kind:'unknown'};
  }
}
