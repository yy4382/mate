import type {RunToken} from '../storage/store.js';
import {encode} from '../storage/store.js';
import type {Principal} from '../domain/messages.js';
import type {ConversationDirectory,MembersResult,OpenDMResult,SpacesResult} from './directory.js';
import type {Conversations} from './messages.js';

/** Internal team identity first; optional external directory handles its own identities. */
export class TeamDirectory implements ConversationDirectory {
  constructor(readonly messages:Conversations,readonly external?:ConversationDirectory){}
  capabilities(actor:string,conversationId?:string):import('./directory.js').DirectoryCapabilities {
    this.messages.agent(actor);this.messages.requireReadable(actor);
    if(conversationId&&this.messages.references.conversation(conversationId).authority==='internal')return{discover:false,join:false,leave:false,refresh:false,notes:['Internal room membership is host-managed. Use watch/mute/defer to choose attention; peer DMs use openDM.']};
    return this.external?.capabilities?.(actor,conversationId)??{discover:false,join:false,leave:false,refresh:false,notes:['No external directory binding; existing internal rooms and peer DMs remain available.']};
  }
  async discover(actor:string,cursor?:string):Promise<import('./directory.js').DiscoveryResult>{
    this.messages.agent(actor);this.messages.requireReadable(actor);
    if(!this.external?.discover)return{spaces:[],nextCursor:null,coverage:'public_metadata',supported:false,reason:'External discovery unavailable'};
    const result=await this.external.discover(actor,cursor);this.messages.requireReadable(actor);return result;
  }
  async joinCandidate(run:RunToken,actionId:string,candidateId:string,signal:AbortSignal):Promise<import('./directory.js').MembershipResult>{
    this.messages.store.assertRun(run);signal.throwIfAborted();this.messages.requireReadable(run.agentId);
    if(!this.external?.joinCandidate)throw new Error('External candidate joining unavailable');
    return this.external.joinCandidate(run,actionId,candidateId,signal);
  }
  async membership(run:RunToken,actionId:string,conversationId:string,operation:'join'|'leave',signal:AbortSignal):Promise<import('./directory.js').MembershipResult>{
    this.messages.store.assertRun(run);signal.throwIfAborted();this.messages.requireReadable(run.agentId);
    if(this.messages.references.conversation(conversationId).authority==='internal'||!this.external?.membership)return{status:'unsupported',conversationId,reason:'Internal room membership is host-managed; external adapter required for join/leave'};
    return this.external.membership(run,actionId,conversationId,operation,signal);
  }
  async refresh(actor:string,conversationId:string,signal:AbortSignal):Promise<import('./directory.js').MembershipResult>{
    this.messages.agent(actor);this.messages.requireReadable(actor);signal.throwIfAborted();
    if(this.messages.references.conversation(conversationId).authority==='internal'||!this.external?.refresh)return{status:'unsupported',conversationId,reason:'No external membership source'};
    return this.external.refresh(actor,conversationId,signal);
  }
  async spaces(actor:string):Promise<SpacesResult>{
    const m=this.messages;m.agent(actor);m.requireReadable(actor);
    let external:SpacesResult={spaces:[],incomplete:false};
    if(this.external)try{external=await this.external.spaces(actor);}catch{external={spaces:[],incomplete:true,retry:'External directory unavailable; internal spaces remain available'};}
    m.requireReadable(actor);
    const rows=m.store.db.prepare("SELECT c.id,c.kind FROM conversation_identities c JOIN channel_access a ON a.channel=c.id WHERE c.authority='internal' AND a.agent_id=? AND a.active=1").all(actor) as {id:string;kind:'channel'|'dm'}[];
    return{...external,spaces:[...external.spaces,...rows.map(row=>({conversationId:row.id,kind:row.kind,archived:false}))]};
  }
  async members(actor:string,conversationId:string):Promise<MembersResult>{
    const m=this.messages;m.requireReadable(actor);m.requireAccess(actor,conversationId);
    if(m.references.conversation(conversationId).authority==='external'){
      if(!this.external)throw new Error('External directory unavailable');return this.external.members(actor,conversationId);
    }
    const members=m.store.db.prepare("SELECT kind,principal_id id FROM internal_members im WHERE conversation_id=? AND (kind!='agent' OR EXISTS(SELECT 1 FROM channel_access a WHERE a.channel=im.conversation_id AND a.agent_id=im.principal_id AND a.active=1))").all(conversationId) as Principal[];
    return{members,incomplete:false};
  }
  async openDM(run:RunToken,actionId:string,principal:Exclude<Principal,{kind:'unknown'}>,signal:AbortSignal):Promise<OpenDMResult>{
    const m=this.messages,s=m.store;s.assertRun(run);signal.throwIfAborted();m.requireReadable(run.agentId);
    const old=s.action(actionId);
    // Historical actions keep their original external semantics, even for an Agent principal.
    if(principal.kind!=='agent'||old&&JSON.parse(old.request).route!=='internal'){
      if(!this.external)throw new Error('External directory unavailable');return this.external.openDM(run,actionId,principal,signal);
    }
    if(![18,19,20,21].includes(Number(s.db.pragma('user_version',{simple:true}))))throw new Error('Internal conversation migration required');
    m.agent(principal.id);
    if(principal.id===run.agentId)throw new Error('DM requires another Agent');
    return s.atomic(()=>{
      const action=m.writes.prepareAction(run,actionId,{operation:'conversations.openDM',route:'internal',principal});
      if(action.state==='succeeded'){
        const target=JSON.parse(action.receipt!);m.requireAccess(run.agentId,target.conversationId);m.requireAccess(principal.id,target.conversationId);return target;
      }
      if(action.state!=='prepared')throw new Error('Internal DM action is not executable');
      const pair=encode([run.agentId,principal.id].sort());
      let row=s.db.prepare('SELECT conversation_id FROM internal_dm_pairs WHERE pair=?').get(pair) as {conversation_id:string}|undefined;
      if(!row){
        const conversation=m.references.createConversation('dm','internal');row={conversation_id:conversation.id};
        s.db.prepare('INSERT INTO internal_dm_pairs VALUES(?,?)').run(pair,conversation.id);
        for(const actor of [run.agentId,principal.id]){
          s.db.prepare("INSERT INTO internal_members VALUES(?,'agent',?)").run(conversation.id,actor);m.membership(actor,conversation.id,true);
        }
      }
      // Existing pair identity does not grant permission again after revocation.
      m.requireAccess(run.agentId,row.conversation_id);m.requireAccess(principal.id,row.conversation_id);
      s.startAction(run,actionId);const target={conversationId:row.conversation_id};s.settleAction(run,actionId,'succeeded',target);return target;
    });
  }
}
