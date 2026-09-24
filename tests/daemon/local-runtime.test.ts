import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,realpathSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {PassThrough} from 'node:stream';
import {Daemon} from '../../src/daemon/app.js';
import {daemonConfigSchema} from '../../src/daemon/config.js';
import {LocalConsole} from '../../src/local/console.js';
import {migrateConfiguration} from '../../src/daemon/migrate.js';
import {acquireLock} from '../../src/daemon/lock.js';
import {TeamDirectory} from '../../src/conversations/team-directory.js';
import {configFixture} from '../helpers/config.js';
const clean:(()=>Promise<unknown>|void)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const fn of clean.splice(0).reverse())await fn();});
function config(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mate-local-runtime-')));clean.push(()=>rmSync(root,{recursive:true,force:true}));
 const c=daemonConfigSchema.parse({mate:configFixture,runtime:{dataDir:join(root,'data')}});
 c.mate.agents[0]!.model.id='claude-haiku-4-5';c.mate.ownerUserIds=['owner'];
 c.adapters={local:{humans:['owner','reader'],rooms:[{id:'local-room',agents:['research'],humans:['owner','reader']}]}};
 return{c,root};
}
async function daemon(c:unknown){const d=await Daemon.create(c,{info:()=>{},error:()=>{}});clean.push(()=>d.close());return d;}
function credentials(){const previous=process.env.MODEL_API_KEY;process.env.MODEL_API_KEY='synthetic';clean.push(()=>{if(previous===undefined)delete process.env.MODEL_API_KEY;else process.env.MODEL_API_KEY=previous;});}
it('uses the same permanent daemon, Supervisor, tool/gate and local console without Slack credentials',async()=>{
 credentials();const {c}=config(),d=await daemon(c),console=new LocalConsole(d.local!,d.controls);
 vi.spyOn(d.supervisor,'recovery').mockResolvedValue('synthetic private recovery');
 let calls=0;
 vi.spyOn(d.supervisor,'factory').mockImplementation(()=>({close(){},async run(_spec,hooks){
   calls++;if(calls===1){const draft=(await hooks.tool('reply','messages.send',{target:{conversationId:'local-room'},text:'internal answer'})).value as any;
     await hooks.tool('confirm','drafts.continue',{draftId:draft.draftId,revision:draft.revision,holdId:draft.holdId,acknowledge:'send_despite_unread_or_changes'});}
   return{tokens:3,cost:0,certain:true,waiting:false,continuation:false};
 }}));
 d.collaboration.messages.watch('research',{conversationId:'local-room'},true);
 console.execute({id:'send',op:'send',human:'owner',eventId:'input-1',target:{conversationId:'local-room'},text:'investigate'});
 await d.start();await vi.waitFor(()=>expect(d.local!.read('owner',{conversationId:'local-room'}).messages.some(m=>m.text==='internal answer')).toBe(true),{timeout:3000});
 expect(calls).toBeGreaterThan(0);expect(d.adapter).toBeUndefined();
 expect(()=>console.execute({id:'bad',op:'control',human:'reader',text:'agent-stop research'})).toThrow('Owner only');
 console.execute({id:'stop',op:'control',human:'owner',text:'agent-stop research'});
 await d.close();const reopened=await daemon(c);
 expect(reopened.local!.read('reader',{conversationId:'local-room'}).messages.map(m=>m.text)).toContain('internal answer');
 expect(reopened.store.db.prepare("SELECT paused FROM agents WHERE id='research'").get()).toEqual({paused:1});
});
it('keeps room revocations on restart and unchanged migration, applies only explicit membership deltas',async()=>{
 const {c,root}=config(),d=await daemon(c);
 d.local!.receive('owner','input',{conversationId:'local-room'},'durable');
 d.collaboration.messages.membership('research','local-room',false);
 d.store.db.prepare("DELETE FROM internal_members WHERE conversation_id='local-room' AND kind='human' AND principal_id='reader'").run();await d.close();
 const reopened=await daemon(c);expect(reopened.collaboration.messages.access('research','local-room')).toBe(false);
 expect(()=>reopened.local!.read('reader',{conversationId:'local-room'})).toThrow('access denied');await reopened.close();
 const next=structuredClone(c);next.mate.agents.push({...next.mate.agents[0]!,id:'peer'});next.adapters.local!.rooms[0]!.agents.push('peer');
 await migrateConfiguration(c,next,join(root,'backup'));const migrated=await daemon(next);
 expect(migrated.collaboration.messages.access('research','local-room')).toBe(false);expect(migrated.collaboration.messages.access('peer','local-room')).toBe(true);
 expect(()=>migrated.local!.read('reader',{conversationId:'local-room'})).toThrow('access denied');
 expect(migrated.local!.read('owner',{conversationId:'local-room'}).messages[0]!.text).toBe('durable');
});
it('rejects unbound external output before an intent and returns internal spaces when discovery fails',async()=>{
 const {c}=config(),d=await daemon(c),m=d.collaboration.messages;
 m.references.createConversation('channel','external','external');m.membership('research','external',true);
 expect(()=>d.collaboration.output.queue('research',{conversationId:'external'},'body','forbidden')).toThrow('unavailable');expect(d.store.output('forbidden')).toBeUndefined();
 const directory=new TeamDirectory(m,{spaces:async()=>{throw new Error('offline');},members:async()=>{throw new Error('offline');},openDM:async()=>{throw new Error('offline');}});
 expect(await directory.spaces('research')).toMatchObject({incomplete:true,spaces:[{conversationId:'local-room'}]});
});
it('a stalled adapter flush or rejected replay cannot block internal scheduling; shutdown retains lock until drain',async()=>{
 credentials();const {c}=config(),d=await daemon(c);let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const adapter={start:async()=>{},recover(){},poll(){throw new Error('offline');},flush:vi.fn(()=>gate),close:vi.fn(async()=>{})};
 Object.defineProperty(d,'adapter',{value:adapter});
 const tick=vi.spyOn(d.collaboration,'tick'),step=vi.spyOn(d.supervisor,'step').mockResolvedValue(false);
 await d.start();await vi.waitFor(()=>expect(adapter.flush).toHaveBeenCalledOnce());
 const before=step.mock.calls.length;await vi.waitFor(()=>expect(step.mock.calls.length).toBeGreaterThan(before),{timeout:1500});expect(tick.mock.calls.length).toBeGreaterThan(1);
 const closing=d.close();expect(()=>acquireLock(join(c.runtime.dataDir,'state','daemon.lock'))).toThrow('Another Mate');release();await closing;
 expect(adapter.close).toHaveBeenCalledOnce();acquireLock(join(c.runtime.dataDir,'state','daemon.lock'))();
});
it('failed startup closes owned resources and releases the singleton lock automatically',async()=>{
 credentials();const {c}=config(),d=await daemon(c);
 const close=vi.fn(async()=>{});Object.defineProperty(d,'adapter',{value:{start:async()=>{throw new Error('partial start');},recover(){},poll(){},flush:async()=>{},close}});
 await expect(d.start()).rejects.toThrow('partial start');expect(close).toHaveBeenCalledOnce();acquireLock(join(c.runtime.dataDir,'state','daemon.lock'))();await d.close();
});
it('JSONL console reports request errors and the real CLI starts, reads and controls the same local store',async()=>{
 const {c,root}=config(),d=await daemon(c),input=new PassThrough(),output=new PassThrough();let text='';output.on('data',v=>text+=v);
 const serving=new LocalConsole(d.local!,d.controls).serve(input,output,new AbortController().signal);
 input.end('{bad\n'+JSON.stringify({id:'rooms',op:'rooms',human:'owner'})+'\n');await serving;
 expect(JSON.parse(text.split('\n')[0]!)).toHaveProperty('error');expect(JSON.parse(text.split('\n')[1]!).result).toEqual([{conversationId:'local-room'}]);await d.close();
 const path=join(root,'config.json');writeFileSync(path,JSON.stringify(c));
 const lines=[{id:'pause',op:'control',human:'owner',text:'agent-stop research'},{id:'send',op:'send',human:'owner',eventId:'cli-message',target:{conversationId:'local-room'},text:'from real CLI'},{id:'read',op:'read',human:'owner',target:{conversationId:'local-room'}}];
 const result=execFileSync(process.execPath,[resolve('dist/src/main.js'),'local',path],{input:lines.map(x=>JSON.stringify(x)).join('\n')+'\n',env:{...process.env,MODEL_API_KEY:'synthetic'},encoding:'utf8',timeout:10000,stdio:['pipe','pipe','pipe']});
 const replies=result.trim().split('\n').map(line=>JSON.parse(line));expect(replies).toHaveLength(3);expect(replies[2].result.messages[0].text).toBe('from real CLI');
});
it('removing and explicitly re-adding a local room preserves history and requires migration to grant membership again',async()=>{
 const {c,root}=config(),d=await daemon(c);d.local!.receive('owner','kept',{conversationId:'local-room'},'kept history');await d.close();
 const removed=structuredClone(c);removed.adapters.local!.rooms=[];
 await migrateConfiguration(c,removed,join(root,'removed-backup'));const r=await daemon(removed);
 expect(r.local!.rooms('owner')).toEqual([]);expect(r.collaboration.messages.access('research','local-room')).toBe(false);await r.close();
 await migrateConfiguration(removed,c,join(root,'added-backup'));const added=await daemon(c);
 expect(added.local!.read('owner',{conversationId:'local-room'}).messages[0]!.text).toBe('kept history');expect(added.collaboration.messages.access('research','local-room')).toBe(true);
});
it('internal publication bypasses an unrelated in-flight external request and ready limits do not hide internal work',async()=>{
 const {c}=config(),d=await daemon(c),m=d.collaboration.messages,s=d.store,out=d.collaboration.output;
 m.references.createConversation('channel','external','external');m.membership('research','external',true);vi.spyOn(m,'requirePublication').mockImplementation(()=>{});
 const internalWork=d.collaboration.createWork('internal',{conversationId:'local-room'}),externalWork=d.collaboration.createWork('external',{conversationId:'external'});
 d.collaboration.enqueue('research',internalWork,'manual-run',{});const run=s.beginRun('research')!;s.input(run,{});
 const queue=(id:string,conversationId:string,work:string)=>{d.collaboration.send('research',work,{conversationId},id,id,{run});const draft=out.gate!.describe('research',id) as any;out.gate!.continueOnce(run,id,1,draft.holdId);};
 for(let n=0;n<22;n++)queue('external-'+n,'external',externalWork);
 queue('internal','local-room',internalWork);
 expect(out.ready(20,'internal')).toEqual([{id:'internal'}]);
 let reject!:(e:Error)=>void;const gate=new Promise<never>((_,r)=>reject=r);vi.spyOn(out.transport,'post').mockImplementation(()=>gate);
 const sending=out.send('external-0');await vi.waitFor(()=>expect(s.output('external-0')!.state).toBe('sending'));
 await out.send('internal');expect(s.output('internal')!.state).toBe('sent');reject(new Error('offline'));await sending;
});
it('an adapter close error still drains background work before DB close and lock release',async()=>{
 credentials();const {c}=config(),d=await daemon(c);let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const adapter={start:async()=>{},recover(){},poll(){},flush:vi.fn(()=>gate),close:async()=>{throw new Error('close failed');}};
 Object.defineProperty(d,'adapter',{value:adapter});vi.spyOn(d.supervisor,'step').mockResolvedValue(false);
 await d.start();await vi.waitFor(()=>expect(adapter.flush).toHaveBeenCalledOnce());
 const closing=d.close();const assertion=expect(closing).rejects.toThrow('cleanup failed');
 await Promise.resolve();expect(()=>acquireLock(join(c.runtime.dataDir,'state','daemon.lock'))).toThrow('Another Mate');
 expect(d.store.db.prepare('SELECT 1').get()).toBeDefined();release();await assertion;
 acquireLock(join(c.runtime.dataDir,'state','daemon.lock'))();
 // The idempotent close retains its original error; test cleanup deliberately consumes it.
 clean.push(()=>{Object.defineProperty(d,'close',{value:()=>closing.catch(()=>{})});});
});
