import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { encode, type RunToken } from '../storage/store.js';
import { messageKey, targetSchema, type Messages, type NormalMessage, type Target } from './messages.js';
function revisionNumber(value:string):bigint{const [whole,fraction]=value.split('.');return BigInt(whole!)*1000000n+BigInt(fraction!.padEnd(6,'0'));}
interface Publication {kind:'artifact';fileId:string;caption:string;title:string;target:Target;sender:string;revision:number}
interface ViewPage {messages:NormalMessage[];publications:Publication[]}
interface View {id:string;agent_id:string;session_id:string;epoch:number;target:string;revision:number;pages:string;complete:number}
export class Attention {
  constructor(readonly messages:Messages) {}
  private epoch(session:string):number { return (this.messages.store.db.prepare('SELECT context_epoch FROM sessions WHERE id=?').get(session) as {context_epoch:number}).context_epoch; }
  revision(target:Target,actor?:string):number {
    targetSchema.parse(target);
    return (this.messages.store.db.prepare('SELECT COALESCE(MAX(seq),0) revision FROM conversation_events WHERE channel=? AND (? IS NULL OR thread=?) AND (audience IS NULL OR audience=?)').get(target.channel,target.thread??null,target.thread??null,actor??null) as {revision:number}).revision;
  }
  private publications(actor:string,target?:Target):Publication[]{
    const rows=this.messages.store.db.prepare(`SELECT o.agent_id,o.request,o.receipt,e.seq FROM outbox o
      JOIN channel_access a ON a.agent_id=? AND a.channel=json_extract(o.request,'$.target.channel') AND a.active=1
      JOIN conversation_events e ON e.message_key='artifact:'||json_extract(o.receipt,'$.fileId') AND e.channel=a.channel AND e.kind='artifact'
      WHERE o.state='sent' AND json_extract(o.request,'$.artifact') IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM messages m JOIN message_visibility v ON v.key=m.key AND v.agent_id=a.agent_id JOIN json_each(m.body,'$.files') f
        WHERE m.channel=a.channel AND m.deleted=0 AND json_extract(m.body,'$.user')=(SELECT value FROM json_each(?) WHERE key=o.agent_id) AND json_extract(f.value,'$.id')=json_extract(o.receipt,'$.fileId')
        AND json_extract(m.body,'$.text')=json_extract(o.request,'$.text')
        AND (json_extract(o.request,'$.target.thread')=m.thread OR (json_extract(o.request,'$.target.thread') IS NULL AND m.thread=m.ts)))
      AND (? IS NULL OR a.channel=?) AND (? IS NULL OR json_extract(o.request,'$.target.thread')=?)
      ORDER BY e.seq DESC LIMIT 101`).all(actor,encode(Object.fromEntries(this.messages.config.agents.map(agent=>[agent.id,agent.slackUserId]))),target?.channel??null,target?.channel??null,target?.thread??null,target?.thread??null) as {agent_id:string;request:string;receipt:string;seq:number}[];
    return rows.reverse().map(row=>{const request=JSON.parse(row.request);return{kind:'artifact',fileId:JSON.parse(row.receipt).fileId,caption:request.text,title:request.artifact.title,target:request.target,sender:row.agent_id,revision:row.seq};});
  }
  peek(actor:string,now=Date.now()):unknown[] {
    if(this.messages.isolated(actor))return[{isolated:true,notice:'Independent review seat; discussion inputs are withheld.'}];
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
    for(const publication of this.publications(actor)){
      if(publication.sender===actor)continue;const target=publication.target,key=encode(target);
      const states=s.db.prepare('SELECT resolved,deferred_until,muted FROM attention_state WHERE agent_id=? AND target IN (?,?)').all(actor,key,encode({channel:target.channel})) as {resolved:number;deferred_until:number;muted:number}[];
      if(states.some(st=>st.muted||st.deferred_until>now||st.resolved>=publication.revision))continue;
      const seen=s.db.prepare('SELECT 1 FROM attention_seen WHERE agent_id=? AND key=? AND revision=?').get(actor,`artifact:${publication.fileId}`,String(publication.revision));
      const group=groups.get(key)??{target,revision:0,unseen:0};group.revision=Math.max(group.revision,publication.revision);group.unseen+=Number(!seen);groups.set(key,group);
    }
    return [...groups.values()].sort((a,b)=>b.revision-a.revision).slice(0,50);
  }
  read(run:RunToken,target:Target,cursor?:string):unknown {
    this.messages.requireReadable(run.agentId);
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
      const published=this.publications(run.agentId,target),snapshots:ViewPage[]=pages.map(messages=>({messages,publications:[]}));
      if(published.length>100)complete=false;
      let publicationBytes=0;
      for(const publication of published.slice(-100)){
        const size=Buffer.byteLength(encode(publication));
        if(!snapshots.at(-1)!.publications.length||publicationBytes+size>140000){snapshots.push({messages:[],publications:[]});publicationBytes=0;}
        snapshots.at(-1)!.publications.push(publication);publicationBytes+=size;
      }
      view={id:randomUUID(),agent_id:run.agentId,session_id:run.sessionId,epoch:this.epoch(run.sessionId),target:encode(target),revision:this.revision(target,run.agentId),pages:encode(snapshots),complete:Number(complete)};
      s.db.prepare('INSERT INTO attention_views VALUES(?,?,?,?,?,?,?,?)').run(view.id,view.agent_id,view.session_id,view.epoch,view.target,view.revision,view.pages,view.complete);
    }
    return this.response(view,page);
  }
  private response(view:View,page:number):unknown {
    const pages=JSON.parse(view.pages) as (NormalMessage[]|ViewPage)[];if(!Number.isSafeInteger(page)||page<0||page>=pages.length)throw new Error('Invalid view page');
    const current=pages[page]!;const contents=Array.isArray(current)?{messages:current}:{messages:current.messages,publications:current.publications};
    return {viewToken:view.id,page,target:JSON.parse(view.target),...contents,coverage:{revision:view.revision,pageCount:pages.length,complete:!!view.complete,scope:'locally observed and visible messages'},nextCursor:page+1<pages.length?`${view.id}:${page+1}`:null};
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
    if(view.complete)for(const publication of (result.publications??[]) as Publication[]){
      s.db.prepare('INSERT INTO attention_seen VALUES(?,?,?) ON CONFLICT(agent_id,key) DO UPDATE SET revision=excluded.revision').run(run.agentId,`artifact:${publication.fileId}`,String(publication.revision));
      // Echo can arrive either before or after the publication's journal ACK.
      const echoed=s.db.prepare(`SELECT m.key,m.revision FROM messages m JOIN message_visibility v ON v.key=m.key AND v.agent_id=?
        WHERE m.deleted=0 AND m.channel=? AND (m.thread=? OR (? IS NULL AND m.thread=m.ts))
        AND json_extract(m.body,'$.user')=? AND json_extract(m.body,'$.text')=?
        AND json_array_length(m.body,'$.files')=1 AND json_extract(m.body,'$.files[0].id')=?`).all(run.agentId,publication.target.channel,publication.target.thread??null,publication.target.thread??null,this.messages.agent(publication.sender).slackUserId,publication.caption,publication.fileId) as {key:string;revision:string}[];
      for(const echo of echoed)s.db.prepare('INSERT INTO attention_seen VALUES(?,?,?) ON CONFLICT(agent_id,key) DO UPDATE SET revision=excluded.revision').run(run.agentId,echo.key,echo.revision);
    }
    if(view.complete) for(const msg of result.messages as NormalMessage[]) {
      const key=messageKey(msg),current=s.db.prepare('SELECT body FROM messages WHERE key=?').get(key) as {body:string}|undefined;
      if(current&&encode((JSON.parse(current.body) as NormalMessage).files??[])!==encode(msg.files??[]))continue;
      const old=s.db.prepare('SELECT revision FROM attention_seen WHERE agent_id=? AND key=?').get(run.agentId,key) as {revision:string}|undefined;
      if(!old||revisionNumber(msg.revision)>revisionNumber(old.revision))s.db.prepare('INSERT INTO attention_seen VALUES(?,?,?) ON CONFLICT(agent_id,key) DO UPDATE SET revision=excluded.revision').run(run.agentId,key,msg.revision);
    }
  }
  valid(run:RunToken,target:Target,token?:string):boolean {
    if(this.messages.isolated(run.agentId))return false;
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
