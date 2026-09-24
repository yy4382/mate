import {queueProjections} from './projection-queue.js';
import {randomUUID} from 'node:crypto';
import type {ConversationTarget} from '../domain/conversations.js';
import type {MessageDTO,Principal} from '../domain/messages.js';
import type {Conversations} from './messages.js';

interface InternalContent {mentions?:Principal[];attachments?:MessageDTO['attachments'];deleted?:boolean;sourceBinding?:string}

/** Internal authority: no transport acknowledgement participates in this transaction. */
export class InternalMessages {
  constructor(readonly messages:Conversations){}
  requireSupported(target:ConversationTarget):void {
    const m=this.messages;m.references.validateTarget(target);
    if(m.references.conversation(target.conversationId).authority!=='internal')throw new Error('Internal conversation required');
    if(![18,19,20,21,22,23,24,25].includes(Number(m.store.db.pragma('user_version',{simple:true}))))throw new Error('Internal conversation migration required');
    if(m.store.db.pragma('user_version',{simple:true})===18&&m.store.db.prepare("SELECT 1 FROM conversation_bindings WHERE conversation_id=? AND mode='projection'").get(target.conversationId))throw new Error('Internal projection delivery is not installed');
    if(Number(m.store.db.pragma('user_version',{simple:true}))>=19&&m.store.db.prepare("SELECT 1 FROM conversation_bindings b LEFT JOIN projection_bindings p USING(provider,workspace,external_id) WHERE b.conversation_id=? AND b.mode='projection' AND p.id IS NULL").get(target.conversationId))throw new Error('projection binding configuration missing');
  }
  /** Trusted callers supply author and active work; model tools cannot invoke this method directly. */
  commit(target:ConversationTarget,author:Principal,text:string,workId:string,origin:'participant'|'system'='participant'):MessageDTO {
    return this.write(target,author,text,workId,origin,{},false);
  }
  /** Authenticated input is stored even while its activity is paused. */
  ingest(target:ConversationTarget,author:Principal,text:string,workId:string,content:InternalContent={}):MessageDTO {
    return this.write(target,author,text,workId,'participant',content,true);
  }
  private write(target:ConversationTarget,author:Principal,text:string,workId:string,origin:'participant'|'system',content:InternalContent,input:boolean):MessageDTO {
    const m=this.messages,s=m.store;
    if(!s.db.inTransaction)throw new Error('Internal commit requires transaction');
    this.requireSupported(target);
    if(author.kind==='agent')m.requireAccess(author.id,target.conversationId);
    else if(author.kind!=='human'||!s.db.prepare("SELECT 1 FROM internal_members WHERE conversation_id=? AND kind='human' AND principal_id=?").get(target.conversationId,author.id))throw new Error('Internal author not a member');
    const work=s.db.prepare('SELECT state FROM works WHERE id=?').get(workId) as {state:string}|undefined;
    if(!work||!input&&author.kind==='agent'&&work.state!=='active')throw new Error('Internal message requires active work');
    // Human input is durable even while the activity is paused; scheduling remains blocked.
    const sequence=s.db.prepare('UPDATE internal_sequence SET value=value+1 WHERE id=1 RETURNING value').safeIntegers().get() as {value:bigint};
    const id=randomUUID(),message:MessageDTO={id,conversationId:target.conversationId,rootId:target.threadId??id,author,origin,text,mentions:content.mentions??[],attachments:content.attachments??[],deleted:content.deleted??false,order:String(sequence.value),revision:String(sequence.value)};
    m.record(message,[]);
    s.db.prepare('INSERT INTO message_work VALUES(?,?)').run(id,workId);
    const recipients=(s.db.prepare('SELECT agent_id FROM channel_access WHERE channel=? AND active=1').all(target.conversationId) as {agent_id:string}[]).map(r=>r.agent_id);
    m.record(message,recipients);
    if(!message.deleted)queueProjections(m,message,content.sourceBinding);
    return message;
  }
}
