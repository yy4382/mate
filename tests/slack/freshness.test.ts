import { fixtureTarget, externalThread } from '../helpers/canonical-slack.js';
import {afterEach,expect,it,vi} from 'vitest';
import type {AgentMessage} from '@earendil-works/pi-agent-core';
import {Store} from '../../src/storage/store.js';
import {Messages,Output,migrateCurrentRuntime} from '../helpers/canonical-slack.js';
import {Collaboration} from '../../src/collaboration/service.js';
import {CanonicalFreshnessGate as FreshnessGate} from '../../src/conversations/freshness.js';
import {configFixture} from '../helpers/config.js';
const stores:Store[]=[];afterEach(()=>stores.splice(0).forEach(s=>s.close()));const target=fixtureTarget('CTEST','100.000001');
function setup(){const s=new Store(':memory:');stores.push(s);s.register('research','v1',[]);const m=new Messages(s,configFixture);migrateCurrentRuntime(s);m.membership('research','CTEST',true);let now=1000;const post=vi.fn(async()=>({ts:`200.${String(post.mock.calls.length).padStart(6,'0')}`}));const o=new Output(m,{post},()=>now);const c=new Collaboration(s,m,o,configFixture),g=new FreshnessGate(m,c.attention,()=>now);o.gate=g;const w=c.createWork('human',target);c.enqueue('research',w,'start',{});const run=s.beginRun('research')!;s.input(run,{});
 const read=()=>{const v=c.attention.read(run,target) as any;c.attention.presented(run,{role:'toolResult',toolCallId:'read',toolName:'mate',content:[{type:'text',text:JSON.stringify(v)}],isError:false,timestamp:0} as AgentMessage);return v.viewToken as string;};
 const change=(n:number)=>m.record({team:'TTEST',channel:'CTEST',thread:externalThread(target),ts:`${100+n}.000001`,revision:`${100+n}.000001`,text:'new information',user:'UOWNER',deleted:false},['research']);
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
 const id=c.send('research',w,target,'delegated','delegate',{run});const child=c.createTask('research',w,target,'child',parent);c.draftTask('research',child,id);
 g.revise(run,id,1,'revised delegation');c.activateDelegations();expect(c.task(child).status).toBe('draft');expect(c.task(child).outbox_id).toBe('delegate:revision:2');
});
it('durable related ingress blocks dispatch until normalized, then the changed view holds',async()=>{
 const{s,c,m,o,w,run,post,read}=setup();const id=c.send('research',w,target,'draft','one',{run,viewToken:read()});
 s.ingest('AONE','pending',{team_id:'TTEST',event:{type:'message',channel:'CTEST',thread_ts:externalThread(target),ts:'150.000001',user:'UOWNER',text:'arrived before ACK'}});
 await o.send(id);expect(post).not.toHaveBeenCalled();m.normalize('AONE','pending');await o.send(id);expect(s.output(id)?.state).toBe('held');expect(post).not.toHaveBeenCalled();
});
it('artifact drafts freeze bytes, preserve them on caption revision and hold changes before sharing',async()=>{
 const{s,c,g,o,w,run,read,change}=setup();const artifact={title:'result',content:'fixed evidence',contentHash:'hash'};
 const upload=vi.fn(async(_request:any,payload:any,prepared:any,beforeShare:any)=>{expect(payload.content).toBe('fixed evidence');prepared('FFILE');change(2);if(!beforeShare())throw new Error('not shared');return{fileId:'FFILE'};});o.artifacts={upload};
 o.queueArtifact('research',target,'caption',artifact,'artifact',{run,viewToken:read()});s.db.prepare('INSERT INTO output_work VALUES(?,?)').run('artifact',w);
 await o.send('artifact');expect(s.output('artifact')?.state).toBe('held');expect(upload).toHaveBeenCalledOnce();
 const revised=g.revise(run,'artifact',1,'new caption') as any;expect(JSON.parse(s.output('artifact:revision:2')!.request).artifact.content).toBe('fixed evidence');expect(revised.artifact.content).toBeUndefined();g.discard(run,'artifact',2);await o.send('artifact:revision:2');expect(upload).toHaveBeenCalledOnce();
});
it('artifact unknown keeps allocated file identity across recovery and needs matching sharing evidence',async()=>{
 const{s,g,o,w,run,c}=setup();o.artifacts={upload:async(_request,_artifact,prepared,beforeShare)=>{prepared('FFILE');expect(beforeShare()).toBe(true);throw new Error('lost after share');}};
 o.queueArtifact('research',target,'caption',{title:'result',content:'frozen',contentHash:'hash'},'artifact',{run});s.db.prepare('INSERT INTO output_work VALUES(?,?)').run('artifact',w);
 const draft=g.describe('research','artifact') as any;g.continueOnce(run,'artifact',1,draft.holdId);await o.send('artifact');s.recover();expect(JSON.parse(s.output('artifact')!.receipt!).fileId).toBe('FFILE');
 expect(()=>o.reconcileArtifact('artifact','FOTHER',{id:'proof',conversationId:'CTEST',rootId:target.threadId,order:'201000001',revision:'201000001',author:{kind:'agent',id:'research'},origin:'participant',mentions:[],deleted:false,text:'',attachments:[{id:'FFILE'}]})).toThrow('mismatch');
 o.reconcileArtifact('artifact','FFILE',{id:'proof',conversationId:'CTEST',rootId:target.threadId,order:'201000001',revision:'201000001',author:{kind:'agent',id:'research'},origin:'participant',mentions:[],deleted:false,text:'',attachments:[{id:'FFILE'}]});expect(s.output('artifact')?.state).toBe('sent');expect(c.attention.revision(target,'research')).toBeGreaterThan(0);
});
it('pause during artifact byte staging prevents the visible sharing step',async()=>{
 const{s,g,o,w,run}=setup();let shared=false;o.artifacts={upload:async(_request,_artifact,prepared,beforeShare)=>{prepared('FFILE');s.db.prepare("UPDATE works SET state='paused' WHERE id=?").run(w);if(!beforeShare())throw new Error('not shared');shared=true;return{fileId:'FFILE'};}};
 o.queueArtifact('research',target,'caption',{title:'r',content:'f',contentHash:'hash'},'artifact',{run});s.db.prepare('INSERT INTO output_work VALUES(?,?)').run('artifact',w);const draft=g.describe('research','artifact') as any;g.continueOnce(run,'artifact',1,draft.holdId);await o.send('artifact');expect(shared).toBe(false);expect(s.output('artifact')?.state).toBe('pending');
});
it('a failure before file sharing is definite and does not block future drafts as unknown',async()=>{
 const{s,g,o,run}=setup();o.artifacts={upload:async()=>{throw new Error('allocation failed');}};
 o.queueArtifact('research',target,'caption',{title:'r',content:'f',contentHash:'hash'},'artifact',{run});const draft=g.describe('research','artifact') as any;g.continueOnce(run,'artifact',1,draft.holdId);await o.send('artifact');expect(s.output('artifact')?.state).toBe('failed');expect(JSON.parse(s.output('artifact')!.receipt!).reason).toBe('artifact_not_shared');
});
it('publication captions require their own exact presented page before a fresh view is valid',async()=>{
 const{s,c,g,o,run,read}=setup();o.artifacts={upload:async(_request,_artifact,prepared,beforeShare)=>{prepared('FFILE');if(!beforeShare())throw new Error('deferred');return{fileId:'FFILE'};}};
 o.queueArtifact('research',target,'NEW EVIDENCE',{title:'result',content:'body',contentHash:'hash'},'artifact',{run,viewToken:read()});await o.send('artifact');
 const page=c.attention.read(run,target) as any;const present=(v:any)=>c.attention.presented(run,{role:'toolResult',toolCallId:'read',toolName:'mate',content:[{type:'text',text:JSON.stringify(v)}],isError:false,timestamp:0} as AgentMessage);
 present(page);expect(c.attention.valid(run,target,page.viewToken)).toBe(false);const next=c.attention.read(run,target,page.nextCursor) as any;expect(next.publications[0]).toMatchObject({fileId:'FFILE',caption:'NEW EVIDENCE',title:'result'});
 present({...next,publications:[]});expect(c.attention.valid(run,target,page.viewToken)).toBe(false);present(next);expect(c.attention.valid(run,target,page.viewToken)).toBe(true);
 expect((g.describe('research','artifact') as any).receipt.fileId).toBe('FFILE');
});
it('crash recovery distinguishes unshared staging from uncertain sharing',()=>{
 const{s,o,run}=setup();for(const [id,phase]of [['staged','staging'],['shared','sharing']] as const){o.queueArtifact('research',target,'caption',{title:'r',content:'f',contentHash:'hash'},id,{run});s.db.prepare("UPDATE outbox SET state='sending',receipt=? WHERE id=?").run(JSON.stringify({phase,fileId:`F${id.toUpperCase()}`}),id);}
 s.recover();expect(s.output('staged')?.state).toBe('failed');expect(s.output('shared')?.state).toBe('unknown');expect(JSON.parse(s.output('shared')!.receipt!).fileId).toBe('FSHARED');
});
it('bounded publication coverage retains the newest evidence and never claims full coverage',()=>{
 const{s,c,run}=setup();for(let i=0;i<101;i++){const id=`published-${i}`,fileId=`F${i}`;c.messages.writes.queueOutput('research',id,{target,text:`caption-${i}`,artifact:{title:'t',content:'c',contentHash:'h'}});s.transitionOutput(id,'pending','sending');s.transitionOutput(id,'sending','sent',{fileId});s.db.prepare('INSERT INTO conversation_events(channel,thread,message_key,revision,kind) VALUES(?,?,?,?,?)').run(target.conversationId,externalThread(target),`artifact:${fileId}`,fileId,'artifact');}
 let page=c.attention.read(run,target) as any;const publications:any[]=[];while(true){expect(page.coverage.complete).toBe(false);publications.push(...page.publications);if(!page.nextCursor)break;page=c.attention.read(run,target,page.nextCursor);}
 expect(publications).toHaveLength(100);expect(publications.at(-1).caption).toBe('caption-100');expect(publications[0].caption).toBe('caption-1');
});
