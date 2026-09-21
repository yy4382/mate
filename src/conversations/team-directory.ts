import type {RunToken} from '../storage/store.js';
import {encode} from '../storage/store.js';
import type {Principal} from '../domain/messages.js';
import type {ConversationDirectory,MembersResult,OpenDMResult,SpacesResult} from './directory.js';
import type {Conversations} from './messages.js';

/** Internal team identity first; optional external directory handles its own identities. */
export class TeamDirectory implements ConversationDirectory {
  constructor(readonly messages:Conversations,readonly external?:ConversationDirectory){}
  async spaces(actor:string):Promise<SpacesResult>{
    const m=this.messages;m.agent(actor);m.requireReadable(actor);
    const external=this.external?await this.external.spaces(actor):{spaces:[],incomplete:false};
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
    if(![18,19].includes(Number(s.db.pragma('user_version',{simple:true}))))throw new Error('Internal conversation migration required');
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
