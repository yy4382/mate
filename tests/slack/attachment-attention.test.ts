import {it,expect} from 'vitest';
import {Store} from '../../src/storage/store.js';
import {Messages,Output} from '../../src/slack/messages.js';
import {Collaboration} from '../../src/collaboration/service.js';
import {configFixture} from '../helpers/config.js';
it('old view ACK cannot mark newly enriched file metadata seen',()=>{
 const s=new Store(':memory:');try{s.register('research','v1',[]);const m=new Messages(s,configFixture);m.membership('research','CTEST',true);const c=new Collaboration(s,m,new Output(m,{post:async()=>({ts:'200.000001'})}),configFixture);
 const target={channel:'CTEST',thread:'100.000001'},w=c.createWork('human',target);c.enqueue('research',w,'start',{});const run=s.beginRun('research')!;s.input(run,{});
 const msg={team:'TTEST',channel:'CTEST',thread:'100.000001',ts:'100.000001',revision:'100.000001',text:'old cache',user:'UOWNER',deleted:false};m.record(msg,['research']);
 const page=c.attention.read(run,target) as any;expect(page.messages[0].files).toBeUndefined();
 m.record({...msg,files:[{id:'FFILE'}]},['research']);expect((c.attention.peek('research')[0] as any).unseen).toBe(1);
 c.attention.presented(run,{role:'toolResult',toolCallId:'read',toolName:'mate',content:[{type:'text',text:JSON.stringify(page)}],isError:false,timestamp:0} as any);
 expect((c.attention.peek('research')[0] as any).unseen).toBe(1);
 }finally{s.close();}
});
it('publication ACK after Slack echo deduplicates unread',()=>{
 const config={...configFixture,agents:[...configFixture.agents,{...configFixture.agents[0]!,id:'writer',name:'Writer',slackUserId:'UTWO',slackAppId:'ATWO',slackBotId:'BTWO'}]};
 const s=new Store(':memory:');try{s.register('research','v1',[]);s.register('writer','v1',[]);const m=new Messages(s,config);m.membership('writer','CTEST',true);const c=new Collaboration(s,m,new Output(m,{post:async()=>({ts:'200.000001'})}),config);const target={channel:'CTEST',thread:'100.000001'},w=c.createWork('human',target);c.enqueue('writer',w,'start',{});const run=s.beginRun('writer')!;s.input(run,{});
 m.persistence.writes.queueOutput('research','pub',{target,text:'caption',artifact:{title:'title',content:'body',contentHash:'hash'}});s.transitionOutput('pub','pending','sending');s.transitionOutput('pub','sending','sent',{fileId:'FFILE'});s.db.prepare('INSERT INTO conversation_events(channel,thread,message_key,revision,kind) VALUES(?,?,?,?,?)').run(target.channel,target.thread,'artifact:FFILE','FFILE','artifact');
 let page=c.attention.read(run,target) as any;page=c.attention.read(run,target,page.nextCursor) as any;expect(page.publications).toHaveLength(1);
 m.record({team:'TTEST',channel:'CTEST',thread:target.thread,ts:'200.000001',revision:'200.000001',text:'caption',user:'UONE',deleted:false,files:[{id:'FFILE',title:'title'}]},['writer']);
 c.attention.presented(run,{role:'toolResult',toolCallId:'read',toolName:'mate',content:[{type:'text',text:JSON.stringify(page)}],isError:false,timestamp:0} as any);
 expect((c.attention.peek('writer')[0] as any).unseen).toBe(0);
 }finally{s.close();}
});
