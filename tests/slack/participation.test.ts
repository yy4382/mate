import {afterEach,expect,it,vi} from 'vitest';
import type {WebClient} from '@slack/web-api';
import {Store} from '../../src/storage/store.js';
import {migrateCanonicalConversations} from '../../src/slack/canonical-migration.js';
import {slackApplication} from '../../src/slack/application.js';
import {Directory} from '../../src/slack/directory.js';
import {TeamDirectory} from '../../src/conversations/team-directory.js';
import {CanonicalOutput} from '../../src/conversations/output.js';
import {Collaboration} from '../../src/collaboration/service.js';
import {Broker} from '../../src/policy/broker.js';
import {ToolRouter} from '../../src/runtime/tools.js';
import {configFixture} from '../helpers/config.js';
const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).forEach(fn=>fn()));
const signal=new AbortController().signal;
function fixture(){
 const s=new Store(':memory:');cleanup.push(()=>s.close());migrateCanonicalConversations(s,configFixture);
 const {messages:m,mapper}=slackApplication(s,configFixture);s.register('research','baseline',[]);
 const api={list:vi.fn(async()=>({ok:true,channels:[{id:'CNEW',name:'new-public'}],response_metadata:{next_cursor:'next'}})),info:vi.fn(async()=>({ok:true,channel:{id:'CNEW',is_private:false,is_member:false}})),join:vi.fn(async()=>({ok:true,channel:{id:'CNEW',is_member:true}})),leave:vi.fn(async()=>({ok:true}))};
 const d=new Directory(m,new Map([['research',{conversations:api} as unknown as WebClient]]),mapper),directory=new TeamDirectory(m,d);
 const out=new CanonicalOutput(m,{post:async()=>{throw new Error('offline');},pendingInput:()=>false,classify:()=>({kind:'unknown'})});
 const c=new Collaboration(s,m,out,configFixture),home=mapper.conversation('CHOME');m.membership('research',home,true);
 const w=c.createWork('home',{conversationId:home});c.enqueue('research',w,'manual',{});const run=s.beginRun('research')!;s.input(run,{});
 const router=new ToolRouter(c,new Broker(s,c,{execute:async()=>({code:0,stdout:'',stderr:'',truncated:false})},{}),undefined,directory);
 return{s,m,mapper,api,d,directory,c,run,w,router};
}
it('public discovery is paginated metadata without ACL; real tool join grants access and leave revokes it',async()=>{
 const f=fixture();const result=(await f.router.call(f.run,f.w,'discover','conversations.discover',{},signal)).value as any;
 expect(result).toMatchObject({nextCursor:'next',coverage:'public_metadata',supported:true});const candidateId=result.spaces[0].candidateId;
 expect(f.m.references.findConversation({provider:'slack',workspace:'TTEST',externalId:'CNEW'})).toBeUndefined();
 const joined=(await f.router.call(f.run,f.w,'join','conversations.join',{candidateId},signal)).value as any;
 expect(joined).toMatchObject({status:'succeeded',active:true});const id=joined.conversationId;
 expect(f.m.access('research',id)).toBe(true);
 const reads=f.api.info.mock.calls.length;await f.router.call(f.run,f.w,'join','conversations.join',{candidateId},signal);expect(f.api.info.mock.calls.length).toBe(reads);expect(f.api.join).toHaveBeenCalledOnce();
 await f.router.call(f.run,f.w,'leave','conversations.leave',{conversationId:id},signal);expect(f.m.access('research',id)).toBe(false);
 await f.router.call(f.run,f.w,'leave','conversations.leave',{conversationId:id},signal);expect(f.api.leave).toHaveBeenCalledOnce();
 await expect(f.router.call(f.run,f.w,'join','conversations.join',{conversationId:f.mapper.conversation('COTHER')},signal)).rejects.toThrow('identity conflict');
});
it('unknown membership never blindly replays; a fresh positive state observation reconciles it',async()=>{
 const f=fixture(),id=f.mapper.conversation('CNEW');f.api.join.mockRejectedValueOnce(new Error('timeout'));
 expect(await f.d.membership(f.run,'join',id,'join',signal)).toMatchObject({status:'unknown'});expect(f.m.access('research',id)).toBe(false);
 expect(await f.d.membership(f.run,'join',id,'join',signal)).toMatchObject({status:'unknown'});expect(f.api.join).toHaveBeenCalledOnce();
 await f.d.refresh('research',id,signal);expect(f.s.action('join')!.state).toBe('unknown');
 f.api.info.mockResolvedValue({ok:true,channel:{id:'CNEW',is_private:false,is_member:true}});
 await f.d.refresh('research',id,signal);expect(f.s.action('join')!.state).toBe('succeeded');expect(f.m.access('research',id)).toBe(true);
 await f.d.membership(f.run,'join',id,'join',signal);expect(f.api.join).toHaveBeenCalledOnce();
});
it('a revoke during an in-flight join cannot be overwritten by its late response',async()=>{
 const f=fixture(),id=f.mapper.conversation('CNEW');let release!:(x:any)=>void;f.api.join.mockImplementation(()=>new Promise(r=>release=r));
 const joining=f.d.membership(f.run,'join',id,'join',signal);await vi.waitFor(()=>expect(f.api.join).toHaveBeenCalledOnce());
 f.m.membership('research',id,false);release({ok:true,channel:{id:'CNEW',is_member:true}});
 expect(await joining).toMatchObject({status:'unknown'});expect(f.m.access('research',id)).toBe(false);
});
it('private joins and unsupported internal controls are explicit, and declared platform rejection is not unknown',async()=>{
 const f=fixture(),id=f.mapper.conversation('CNEW');f.api.info.mockResolvedValue({ok:true,channel:{id:'CNEW',is_private:true,is_member:false}});
 await expect(f.d.membership(f.run,'private',id,'join',signal)).rejects.toThrow('public channel');expect(f.api.join).not.toHaveBeenCalled();
 f.api.info.mockResolvedValue({ok:true,channel:{id:'CNEW',is_private:false,is_member:false}});f.api.join.mockRejectedValue({code:'slack_webapi_platform_error',data:{error:'missing_scope'}});
 expect(await f.d.membership(f.run,'rejected',id,'join',signal)).toMatchObject({status:'failed',reason:'missing_scope'});
 f.m.references.createConversation('dm','internal','internal');
 expect(f.directory.capabilities('research','internal')).toMatchObject({join:false,leave:false});
 expect(await f.directory.membership(f.run,'local','internal','join',signal)).toMatchObject({status:'unsupported'});expect(f.s.action('local')).toBeUndefined();
});
it('already absent leave is confirmed and refresh rechecks a concurrent membership change',async()=>{
 const f=fixture(),id=f.mapper.conversation('CNEW');f.m.membership('research',id,true);
 f.api.leave.mockRejectedValue({code:'slack_webapi_platform_error',data:{ok:false,not_in_channel:true}});
 expect(await f.d.membership(f.run,'leave',id,'leave',signal)).toMatchObject({status:'succeeded',active:false});
 let release!:(x:any)=>void;f.api.info.mockImplementation(()=>new Promise(r=>release=r));
 const refreshing=f.d.refresh('research',id,signal);f.m.membership('research',id,false);release({ok:true,channel:{id:'CNEW',is_member:true}});
 await expect(refreshing).rejects.toThrow('changed during');expect(f.m.access('research',id)).toBe(false);
});

it('documented membership refusal is failed, so a later valid leave is not permanently blocked as unknown',async()=>{
 const f=fixture(),id=f.mapper.conversation('CNEW');f.m.membership('research',id,true);
 for(const code of ['last_member','token_expired','ratelimited']){
   f.api.leave.mockRejectedValueOnce({code:'slack_webapi_platform_error',data:{error:code}});
   expect(await f.d.membership(f.run,code,id,'leave',signal)).toMatchObject({status:'failed',reason:code});
   expect(f.m.access('research',id)).toBe(true);
 }
 expect(await f.d.membership(f.run,'after-second-member',id,'leave',signal)).toMatchObject({status:'succeeded',active:false});
});
it('a platform internal error can have side effects and remains unknown rather than permitting blind retry',async()=>{
 const f=fixture(),id=f.mapper.conversation('CNEW');f.api.join.mockRejectedValue({code:'slack_webapi_platform_error',data:{error:'internal_error'}});
 expect(await f.d.membership(f.run,'unknown-platform',id,'join',signal)).toMatchObject({status:'unknown'});
 expect(await f.d.membership(f.run,'another-write',id,'join',signal)).toMatchObject({status:'unknown'});expect(f.api.join).toHaveBeenCalledOnce();
});
