import {afterEach,expect,it,vi} from 'vitest';
import type {AgentMessage} from '@earendil-works/pi-agent-core';
import {Store} from '../../src/storage/store.js';
import {Messages,Output} from '../../src/slack/messages.js';
import {Collaboration} from '../../src/collaboration/service.js';
import {FreshnessGate} from '../../src/slack/freshness.js';
import {configFixture} from '../helpers/config.js';
const stores:Store[]=[];afterEach(()=>stores.splice(0).forEach(s=>s.close()));const target={channel:'CTEST',thread:'100.000001'};
function setup(){const s=new Store(':memory:');stores.push(s);s.register('research','v1',[]);const m=new Messages(s,configFixture);m.membership('research','CTEST',true);let now=1000;const post=vi.fn(async()=>({ts:`200.${String(post.mock.calls.length).padStart(6,'0')}`}));const o=new Output(m,{post},()=>now);const c=new Collaboration(s,m,o,configFixture),g=new FreshnessGate(m,c.attention,()=>now);o.gate=g;const w=c.createWork('human',target);c.enqueue('research',w,'start',{});const run=s.beginRun('research')!;s.input(run,{});
 const read=()=>{const v=c.attention.read(run,target) as any;c.attention.presented(run,{role:'toolResult',toolCallId:'read',toolName:'mate',content:[{type:'text',text:JSON.stringify(v)}],isError:false,timestamp:0} as AgentMessage);return v.viewToken as string;};
 const change=(n:number)=>m.record({team:'TTEST',channel:'CTEST',thread:target.thread,ts:`${100+n}.000001`,revision:`${100+n}.000001`,text:'new information',user:'UOWNER',deleted:false},['research']);
 return{s,m,c,g,o,w,run,post,read,change,time:(v:number)=>{now=v;}};}
it('missing view holds a durable draft; explicit continue is bounded and never pretends it was read',async()=>{
 const{s,c,g,o,w,run,post}=setup();const id=c.send('research',w,target,'draft','draft',{run});await o.send(id);expect(post).not.toHaveBeenCalled();const d=g.describe('research',id) as any;expect(d.status).toBe('held');
 s.recover();const next=s.beginRun('research')!;g.continueOnce(next,id,d.revision,d.holdId);await o.send(id);expect(post).toHaveBeenCalledOnce();expect(s.output(id)?.state).toBe('sent');expect(s.db.prepare('SELECT count(*) n FROM attention_seen').get()).toEqual({n:0});
});
it('queued changes hold at dispatch, can revise and retry with a new presented view',async()=>{
 const{c,g,o,w,run,post,read,change}=setup();const id=c.send('research',w,target,'v1','draft',{run,viewToken:read()});change(1);await o.send(id);expect(post).not.toHaveBeenCalled();
 const d=g.revise(run,id,1,'v2') as any;expect(d.revision).toBe(2);g.retry(run,id,2,read());await o.send('draft:revision:2');expect(post).toHaveBeenCalledOnce();expect(post.mock.calls[0]).toBeDefined();
});
it('serial dispatch makes a later stale queued message held after the earlier local send',async()=>{
 const{c,o,w,run,post,read,s}=setup();const viewToken=read();const first=c.send('research',w,target,'one','one',{run,viewToken}),second=c.send('research',w,target,'two','two',{run,viewToken});
 await Promise.all([o.send(first),o.send(second)]);expect(post).toHaveBeenCalledOnce();expect(s.output(second)?.state).toBe('held');
});
it('429 retries recheck discussion, unknown dispatch blocks another message even with explicit continue',async()=>{
 const{c,g,o,w,run,post,read,change,s,time}=setup();post.mockRejectedValueOnce({code:'slack_webapi_rate_limited_error',retryAfter:1});const id=c.send('research',w,target,'one','one',{run,viewToken:read()});await o.send(id);change(1);time(3000);await o.send(id);expect(s.output(id)?.state).toBe('held');const d=g.describe('research',id) as any;g.continueOnce(run,id,1,d.holdId);post.mockRejectedValueOnce(new Error('lost'));await o.send(id);expect(s.output(id)?.state).toBe('unknown');
 const other=c.send('research',w,target,'other','other',{run});const held=g.describe('research',other) as any;g.continueOnce(run,other,1,held.holdId);await o.send(other);expect(post).toHaveBeenCalledTimes(2);
});
it('discard is silent, stale hold receipts and revoked access cannot authorize continue',async()=>{
 const{c,g,w,run,m,o,post}=setup();const id=c.send('research',w,target,'one','one',{run});const first=g.describe('research',id) as any;g.retry(run,id,1);expect(()=>g.continueOnce(run,id,1,first.holdId)).toThrow('receipt');g.discard(run,id,1);await o.send(id);expect(post).not.toHaveBeenCalled();
 const second=c.send('research',w,target,'two','two',{run});const d=g.describe('research',second) as any;m.membership('research','CTEST',false);expect(()=>g.continueOnce(run,second,1,d.holdId)).toThrow('access');
});
it('expired continue receipt cannot become a permanent unread baseline',async()=>{
 const{c,g,o,w,run,post,time,s}=setup();const id=c.send('research',w,target,'one','one',{run});const d=g.describe('research',id) as any;g.continueOnce(run,id,1,d.holdId);time(62000);await o.send(id);expect(post).not.toHaveBeenCalled();expect(s.output(id)?.state).toBe('held');
});
it('owner Agent stop prevents an already continued pending draft from dispatching',async()=>{
 const{s,c,g,o,w,run,post}=setup();const id=c.send('research',w,target,'one','one',{run});const d=g.describe('research',id) as any;g.continueOnce(run,id,1,d.holdId);s.pause('research');await o.send(id);expect(o.ready()).toEqual([]);expect(post).not.toHaveBeenCalled();
});
it('revising a delegation updates its output reference before activation',()=>{
 const{s,c,g,w,run}=setup();const parent=c.createTask('research',w,target,'parent');c.claim('research',parent);
 const id=c.send('research',w,target,'delegated','delegate',{run});const child=c.createTask('research',w,target,'child',parent);s.db.prepare("UPDATE tasks SET outbox_id=?,status='draft' WHERE id=?").run(id,child);
 g.revise(run,id,1,'revised delegation');c.activateDelegations();expect(c.task(child).status).toBe('draft');expect(c.task(child).outbox_id).toBe('delegate:revision:2');
});
it('durable related ingress blocks dispatch until normalized, then the changed view holds',async()=>{
 const{s,c,m,o,w,run,post,read}=setup();const id=c.send('research',w,target,'draft','one',{run,viewToken:read()});
 s.ingest('AONE','pending',{team_id:'TTEST',event:{type:'message',channel:'CTEST',thread_ts:target.thread,ts:'150.000001',user:'UOWNER',text:'arrived before ACK'}});
 await o.send(id);expect(post).not.toHaveBeenCalled();m.normalize('AONE','pending');await o.send(id);expect(s.output(id)?.state).toBe('held');expect(post).not.toHaveBeenCalled();
});
