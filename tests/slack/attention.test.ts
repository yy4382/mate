import { fixtureTarget, externalThread } from '../helpers/canonical-slack.js';
import {afterEach,expect,it} from 'vitest';
import type {AgentMessage} from '@earendil-works/pi-agent-core';
import {Store} from '../../src/storage/store.js';
import {Messages,Output} from '../helpers/canonical-slack.js';
import {Collaboration} from '../../src/collaboration/service.js';
import {configFixture} from '../helpers/config.js';
const stores:Store[]=[];afterEach(()=>stores.splice(0).forEach(s=>s.close()));
function setup(){const s=new Store(':memory:');stores.push(s);s.register('research','v1',[]);const m=new Messages(s,configFixture);m.membership('research','CTEST',true);const c=new Collaboration(s,m,new Output(m,{post:async()=>({ts:'200.000001'})}),configFixture);s.enqueue('research','start',{});const run=s.beginRun('research')!;s.input(run,{});return{s,m,c,a:c.attention,run};}
const target=fixtureTarget('CTEST','100.000001');
function message(n=0){return{team:'TTEST',channel:'CTEST',thread:externalThread(target),ts:`${100+n}.000001`,revision:`${100+n}.000001`,text:`synthetic ${n}`,user:'UOWNER',deleted:false};}
function result(value:unknown):AgentMessage{return{role:'toolResult',toolCallId:'read',toolName:'mate',content:[{type:'text',text:JSON.stringify(value)}],isError:false,timestamp:0};}
it('only journaled complete pages establish a current view; finish does not resolve attention',()=>{
 const{s,m,a,run}=setup();for(let n=0;n<22;n++)m.record(message(n),['research']);
 const first=a.read(run,target) as any;expect(first.nextCursor).toBeTruthy();expect(a.valid(run,target,first.viewToken)).toBe(false);
 a.presented(run,result(first));expect(a.valid(run,target,first.viewToken)).toBe(false);
 const second=a.read(run,target,first.nextCursor) as any;a.presented(run,result(second));expect(a.valid(run,target,first.viewToken)).toBe(true);
 expect(a.peek('research')).toMatchObject([{unseen:0}]);s.finish(run);expect(a.peek('research')).toHaveLength(1);
});
it('peek, partial or altered responses never acknowledge body presentation',()=>{
 const{m,a,run}=setup();m.record(message(),['research']);a.peek('research');const read=a.read(run,target) as any;
 a.presented(run,result({...read,messages:[]}));expect(a.valid(run,target,read.viewToken)).toBe(false);expect(a.peek('research')).toMatchObject([{unseen:1}]);
});
it('editing, late older messages and context replacement invalidate receipts, duplicate events do not',()=>{
 const{m,a,run}=setup();m.record(message(),['research']);const read=a.read(run,target) as any;a.presented(run,result(read));m.record(message(),['research']);expect(a.valid(run,target,read.viewToken)).toBe(true);
 m.record({...message(),revision:'200.000001',text:'edit'},['research']);expect(a.valid(run,target,read.viewToken)).toBe(false);
 const next=a.read(run,target) as any;a.presented(run,result(next));a.invalidate(run.sessionId);expect(a.valid(run,target,next.viewToken)).toBe(false);
});
it('defer and mute preserve unseen state; expired defer wakes once and resolve is explicit',()=>{
 const{s,m,c,a}=setup();m.record(message(),['research']);a.state('research',target,'defer',Date.now()+100000);expect(a.peek('research')).toEqual([]);
 c.tick(Date.now()+100001);c.tick(Date.now()+100001);expect(s.db.prepare("SELECT count(*) n FROM deliveries WHERE json_extract(payload,'$.kind')='attention_due'").get()).toEqual({n:1});
 expect(a.peek('research')).toMatchObject([{unseen:1}]);a.state('research',target,'mute',1);expect(a.peek('research')).toEqual([]);a.state('research',target,'mute',0);
 a.state('research',target,'resolve',a.revision(target));expect(a.peek('research')).toEqual([]);m.record(message(1),['research']);expect(a.peek('research')).toHaveLength(1);
});
it('view pages and notices obey current membership',()=>{
 const{m,a,run}=setup();for(let n=0;n<22;n++)m.record(message(n),['research']);const first=a.read(run,target) as any;m.membership('research','CTEST',false);
 expect(a.peek('research')).toEqual([]);expect(()=>a.read(run,target,first.nextCursor)).toThrow('access');expect(()=>a.presented(run,result(first))).toThrow('access');
});
it('new visibility of an already stored message invalidates the formerly empty view',()=>{
 const{m,a,run}=setup();m.record(message(),[]);const view=a.read(run,target) as any;a.presented(run,result(view));expect(a.valid(run,target,view.viewToken)).toBe(true);
 m.record(message(),['research']);expect(a.valid(run,target,view.viewToken)).toBe(false);expect(a.peek('research')).toMatchObject([{unseen:1}]);
});
it('channel mute suppresses a thread deferred wakeup',()=>{
 const{s,a,c}=setup();a.state('research',target,'defer',100);a.state('research',{conversationId:'CTEST'},'mute',1);c.tick(101);
 expect(s.db.prepare("SELECT count(*) n FROM deliveries WHERE json_extract(payload,'$.kind')='attention_due'").get()).toEqual({n:0});
});
it('late acknowledgment of an old snapshot never regresses the seen revision',()=>{
 const{m,a,run}=setup();m.record(message(),['research']);const old=a.read(run,target);m.record({...message(),revision:'200.000001',text:'edit'},['research']);const current=a.read(run,target);
 a.presented(run,result(current));a.presented(run,result(old));expect(a.peek('research')).toMatchObject([{unseen:0}]);
});
