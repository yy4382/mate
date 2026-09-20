import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { encode, type RunToken } from '../storage/store.js';
import { messageKey, targetSchema, type Messages, type NormalMessage, type Target } from './messages.js';
function revisionNumber(value:string):bigint{const [whole,fraction]=value.split('.');return BigInt(whole!)*1000000n+BigInt(fraction!.padEnd(6,'0'));}
interface View {id:string;agent_id:string;session_id:string;epoch:number;target:string;revision:number;pages:string;complete:number}
export class Attention {
  constructor(readonly messages:Messages) {}
  private epoch(session:string):number { return (this.messages.store.db.prepare('SELECT context_epoch FROM sessions WHERE id=?').get(session) as {context_epoch:number}).context_epoch; }
  revision(target:Target,actor?:string):number {
    targetSchema.parse(target);
    return (this.messages.store.db.prepare('SELECT COALESCE(MAX(seq),0) revision FROM conversation_events WHERE channel=? AND (? IS NULL OR thread=?) AND (audience IS NULL OR audience=?)').get(target.channel,target.thread??null,target.thread??null,actor??null) as {revision:number}).revision;
  }
  peek(actor:string,now=Date.now()):unknown[] {
    const s=this.messages.store, agent=this.messages.agent(actor);
    const rows=s.db.prepare(`SELECT m.channel,m.thread,m.key,m.revision,MAX(e.seq) seq,seen.revision seen FROM messages m
      JOIN message_visibility v ON v.key=m.key AND v.agent_id=? JOIN channel_access a ON a.agent_id=v.agent_id AND a.channel=m.channel AND a.active=1
      JOIN conversation_events e ON e.message_key=m.key AND (e.audience IS NULL OR e.audience=v.agent_id) LEFT JOIN attention_seen seen ON seen.agent_id=v.agent_id AND seen.key=m.key
      WHERE COALESCE(json_extract(m.body,'$.user'),'')!=? AND COALESCE(json_extract(m.body,'$.bot'),'')!=? GROUP BY m.key`).all(actor,agent.slackUserId,agent.slackBotId) as {channel:string;thread:string;key:string;revision:string;seq:number;seen:string|null}[];
    const groups=new Map<string,{target:Target;revision:number;unseen:number}>();
    for(const row of rows){
      const target={channel:row.channel,thread:row.thread},key=encode(target);
      const states=s.db.prepare('SELECT resolved,deferred_until,muted FROM attention_state WHERE agent_id=? AND target IN (?,?)').all(actor,key,encode({channel:row.channel})) as {resolved:number;deferred_until:number;muted:number}[];
      if(states.some(st=>st.muted||st.deferred_until>now||st.resolved>=row.seq))continue;
      const group=groups.get(key)??{target,revision:0,unseen:0};group.revision=Math.max(group.revision,row.seq);group.unseen+=Number(row.seen!==row.revision);groups.set(key,group);
    }
    return [...groups.values()].sort((a,b)=>b.revision-a.revision).slice(0,50);
  }
  read(run:RunToken,target:Target,cursor?:string):unknown {
    const s=this.messages.store;s.assertRun(run);targetSchema.parse(target);this.messages.requireAccess(run.agentId,target.channel);
    let view:View,page=0;
    if(cursor){
      const split=cursor.split(':');if(split.length!==2||!/^\d+$/.test(split[1]!))throw new Error('Invalid view cursor');
      const found=s.db.prepare('SELECT * FROM attention_views WHERE id=?').get(split[0]) as View|undefined;
      if(!found||found.agent_id!==run.agentId||found.session_id!==run.sessionId||found.epoch!==this.epoch(run.sessionId)||found.target!==encode(target))throw new Error('Expired or foreign view');
      view=found;page=Number(split[1]);
    }else{
      const rows=s.db.prepare('SELECT m.body FROM messages m JOIN message_visibility v ON v.key=m.key WHERE v.agent_id=? AND m.channel=? AND (? IS NULL OR m.thread=?) ORDER BY length(m.ts),m.ts LIMIT 10001').all(run.agentId,target.channel,target.thread??null,target.thread??null) as {body:string}[];
      const pages:NormalMessage[][]=[[]];let bytes=0,complete=rows.length<=10000;
      for(const row of rows.slice(0,10000)){
        const message=JSON.parse(row.body) as NormalMessage;
        if(message.deleted)message.text='';
        if(Buffer.byteLength(encode(message))>120000){message.text=message.text.slice(0,25000);complete=false;}
        const size=Buffer.byteLength(encode(message));
        if(pages.at(-1)!.length && (bytes+size>150000||pages.at(-1)!.length>=20)){pages.push([]);bytes=0;}
        pages.at(-1)!.push(message);bytes+=size;
      }
      view={id:randomUUID(),agent_id:run.agentId,session_id:run.sessionId,epoch:this.epoch(run.sessionId),target:encode(target),revision:this.revision(target,run.agentId),pages:encode(pages),complete:Number(complete)};
      s.db.prepare('INSERT INTO attention_views VALUES(?,?,?,?,?,?,?,?)').run(view.id,view.agent_id,view.session_id,view.epoch,view.target,view.revision,view.pages,view.complete);
    }
    return this.response(view,page);
  }
  private response(view:View,page:number):unknown {
    const pages=JSON.parse(view.pages) as NormalMessage[][];if(!Number.isSafeInteger(page)||page<0||page>=pages.length)throw new Error('Invalid view page');
    return {viewToken:view.id,page,target:JSON.parse(view.target),messages:pages[page],coverage:{revision:view.revision,pageCount:pages.length,complete:!!view.complete,scope:'locally observed and visible messages'},nextCursor:page+1<pages.length?`${view.id}:${page+1}`:null};
  }
  /** Called atomically with journal commit, never when the tool merely returns over IPC. */
  presented(run:RunToken,message:AgentMessage):void {
    if(message.role!=='toolResult'||message.isError)return;
    const content=message.content;if(content.length!==1||content[0]?.type!=='text')return;
    let result:any;try{result=JSON.parse(content[0].text);}catch{return;}
    if(typeof result?.viewToken!=='string')return;
    const s=this.messages.store,view=s.db.prepare('SELECT * FROM attention_views WHERE id=?').get(result.viewToken) as View|undefined;
    if(!view||view.agent_id!==run.agentId||view.session_id!==run.sessionId||view.epoch!==this.epoch(run.sessionId))return;
    this.messages.requireAccess(run.agentId,JSON.parse(view.target).channel);
    if(encode(this.response(view,result.page))!==content[0].text)return;
    s.db.prepare('INSERT INTO attention_presented VALUES(?,?) ON CONFLICT DO NOTHING').run(view.id,result.page);
    // A bounded/truncated response cannot establish full message presentation.
    if(view.complete) for(const msg of result.messages as NormalMessage[]) {
      const key=messageKey(msg),old=s.db.prepare('SELECT revision FROM attention_seen WHERE agent_id=? AND key=?').get(run.agentId,key) as {revision:string}|undefined;
      if(!old||revisionNumber(msg.revision)>revisionNumber(old.revision))s.db.prepare('INSERT INTO attention_seen VALUES(?,?,?) ON CONFLICT(agent_id,key) DO UPDATE SET revision=excluded.revision').run(run.agentId,key,msg.revision);
    }
  }
  valid(run:RunToken,target:Target,token?:string):boolean {
    if(!token||!this.messages.access(run.agentId,target.channel))return false;
    const s=this.messages.store,v=s.db.prepare('SELECT * FROM attention_views WHERE id=?').get(token) as View|undefined;
    if(!v||v.agent_id!==run.agentId||v.session_id!==run.sessionId||v.epoch!==this.epoch(run.sessionId)||v.target!==encode(target)||!v.complete||v.revision!==this.revision(target,run.agentId))return false;
    const count=(s.db.prepare('SELECT COUNT(*) n FROM attention_presented WHERE view_id=?').get(token) as {n:number}).n;
    return count===(JSON.parse(v.pages) as unknown[]).length;
  }
  invalidate(session:string):void {this.messages.store.db.prepare('UPDATE sessions SET context_epoch=context_epoch+1 WHERE id=?').run(session);}
  state(actor:string,target:Target,operation:'resolve'|'defer'|'mute',value:number):void {
    targetSchema.parse(target);this.messages.requireAccess(actor,target.channel);
    if(!Number.isSafeInteger(value)||value<0||operation==='resolve'&&value>this.revision(target,actor)||operation==='mute'&&value>1)throw new Error('Invalid attention state');
    const s=this.messages.store,key=encode(target);s.db.prepare('INSERT INTO attention_state(agent_id,target) VALUES(?,?) ON CONFLICT DO NOTHING').run(actor,key);
    const column=operation==='resolve'?'resolved':operation==='defer'?'deferred_until':'muted';
    s.db.prepare(`UPDATE attention_state SET ${column}=? WHERE agent_id=? AND target=?`).run(value,actor,key);
  }
}
