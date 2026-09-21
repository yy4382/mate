import {z} from 'zod';
import type {Collaboration} from '../collaboration/service.js';
import {InternalMessages} from '../conversations/internal.js';
import {conversationTargetSchema,type ConversationTarget} from '../domain/conversations.js';
import {hash,encode} from '../storage/store.js';

/** Trusted local host boundary. Never expose an arbitrary claimed human identity to a worker. */
export class LocalAdapter {
  private readonly humans:Set<string>;
  constructor(readonly collaboration:Collaboration,humans:readonly string[]){this.humans=new Set(humans);}
  createRoom(id:string,agents:readonly string[],humans:readonly string[]):ConversationTarget {
    const c=this.collaboration,s=c.store;
    return s.atomic(()=>{
      if(!agents.length||!humans.length)throw new Error('Local room needs Agent and human members');
      for(const actor of agents)c.agents.get(actor);
      for(const human of humans)if(!this.humans.has(human))throw new Error('Unknown local human');
      if(s.db.prepare('SELECT 1 FROM conversation_identities WHERE id=?').get(id))throw new Error('Local room already exists');
      c.messages.references.createConversation('channel','internal',id);
      for(const actor of new Set(agents)){s.db.prepare("INSERT INTO internal_members VALUES(?,'agent',?)").run(id,actor);c.messages.membership(actor,id,true);}
      for(const human of new Set(humans))s.db.prepare("INSERT INTO internal_members VALUES(?,'human',?)").run(id,human);
      return{conversationId:id};
    });
  }
  receive(human:string,eventId:string,target:ConversationTarget,text:string):{messageId:string}{
    const c=this.collaboration,s=c.store;
    if(!this.humans.has(human))throw new Error('Unknown local human');
    z.string().min(1).max(1000).parse(eventId);z.string().min(1).max(35000).parse(text);target=conversationTargetSchema.parse(target);
    return s.atomic(()=>{
      const internal=new InternalMessages(c.messages);internal.requireSupported(target);
      if(!s.db.prepare("SELECT 1 FROM internal_members WHERE conversation_id=? AND kind='human' AND principal_id=?").get(target.conversationId,human))throw new Error('Local input access denied');
      const requestHash=hash(encode({human,target,text}));
      const old=s.db.prepare('SELECT request_hash,message_id FROM local_inputs WHERE id=?').get(eventId) as {request_hash:string;message_id:string}|undefined;
      if(old){if(old.request_hash!==requestHash)throw new Error('Local event identity conflict');return{messageId:old.message_id};}
      const parent=target.threadId?s.db.prepare('SELECT work_id FROM message_work WHERE message_key=?').get(target.threadId) as {work_id:string}|undefined:undefined;
      const work=parent?.work_id??c.createWork(`local:${eventId}`,target);
      const message=internal.ingest(target,{kind:'human',id:human},text,work);
      s.db.prepare('INSERT INTO local_inputs VALUES(?,?,?)').run(eventId,requestHash,message.id);
      return{messageId:message.id};
    });
  }
}
