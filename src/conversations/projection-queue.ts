import {randomUUID} from 'node:crypto';
import type {MessageDTO} from '../domain/messages.js';
import type {Conversations} from './messages.js';

/** Enqueued by the internal message transaction, never a second message fact source. */
export function queueProjections(messages:Conversations,message:MessageDTO,sourceBinding?:string):void {
  const s=messages.store;if(s.db.pragma('user_version',{simple:true})!==19)return;
  if(!s.db.inTransaction)throw new Error('Projection queue requires message transaction');
  const author=message.author.kind==='agent'?messages.agent(message.author.id).name:message.author.kind==='unknown'?'Unknown':`${message.author.kind}: ${message.author.id}`;
  for(const binding of s.db.prepare("SELECT p.id FROM projection_bindings p JOIN conversation_bindings b ON b.provider=p.provider AND b.workspace=p.workspace AND b.external_id=p.external_id WHERE b.conversation_id=? AND p.enabled=1 AND p.id IS NOT ?").all(message.conversationId,sourceBinding??null) as {id:string}[]){
    s.db.prepare("INSERT INTO projection_outbox(id,binding_id,message_id,source_revision,text,state) VALUES(?,?,?,?,?,'pending') ON CONFLICT(binding_id,message_id) DO NOTHING").run(randomUUID(),binding.id,message.id,message.revision,`${author}\n${message.text}`);
  }
}
