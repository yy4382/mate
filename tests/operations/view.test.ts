import {afterEach,expect,it,vi}from 'vitest';
import {Store}from '../../src/storage/store.js';
import {localApplication}from '../../src/local/application.js';
import {TeamDirectory}from '../../src/conversations/team-directory.js';
import {Controls}from '../../src/daemon/control.js';
import {LocalConsole}from '../../src/local/console.js';
import {formatControlReply}from '../../src/slack/service.js';
import type {TeamSettings}from '../../src/domain/agents.js';

const settings:TeamSettings={agents:['alice','bob'].map(id=>({id,name:id,role:'colleague',model:{provider:'test',id:'test',apiKeyEnv:'TEST_KEY'}})),ownerUserIds:['owner'],budgets:{maxRuns:50,maxTokens:100000,maxCostUsd:20,runTimeoutMs:10000}};
const stores:Store[]=[];afterEach(()=>{vi.useRealTimers();stores.splice(0).forEach(store=>store.close());});
function setup(){
 const store=new Store(':memory:');stores.push(store);const app=localApplication(store,settings);
 for(const agent of settings.agents){store.register(agent.id,'v1',[]);app.collaboration.ledger.account(agent.id);}
 const target=app.input.createRoom('room',['alice','bob'],['owner']),work=app.collaboration.createWork('operations',target);
 return{store,...app,target,work};
}
function run(f:ReturnType<typeof setup>,actor:string,dedupe:string){f.collaboration.enqueue(actor,f.work,dedupe,{kind:'synthetic'});const token=f.store.beginRun(actor,Date.now(),true)!;f.store.input(token,{role:'user',content:'PRIVATE_INPUT'});return token;}

it('returns owner-only authoritative status without sensitive bodies and local controls reuse the DTO',()=>{
 vi.useFakeTimers();vi.setSystemTime(10000);const f=setup(),c=f.collaboration,s=f.store;
 const task=c.createTask('alice',f.work,f.target,'PRIVATE_TASK_TITLE');c.claim('alice',task);c.update('alice',task,'done','PRIVATE_TASK_RESULT');
 c.reminders.create('alice',f.work,{target:f.target,content:'PRIVATE_REMINDER_CONTENT',nextAt:0,timezone:'UTC'});
 c.send('alice',f.work,f.target,'PRIVATE_HELD_OUTPUT','held-output');
 c.send('alice',f.work,f.target,'PRIVATE_UNKNOWN_OUTPUT','unknown-output');s.transitionOutput('unknown-output','held','pending');s.transitionOutput('unknown-output','pending','sending');s.transitionOutput('unknown-output','sending','unknown',{secret:'PRIVATE_OUTPUT_RECEIPT'});
 const token=run(f,'alice','first');s.prepareAction(token,'action',{secret:'PRIVATE_ACTION_REQUEST'});s.startAction(token,'action');s.finish(token,'PRIVATE_RUN_ERROR');
 expect(()=>c.operations.status('intruder')).toThrow('Owner only');
 const before={deliveries:s.db.prepare('SELECT count(*) n FROM deliveries').get(),events:s.db.prepare('SELECT count(*) n FROM conversation_events').get(),outbox:s.db.prepare('SELECT count(*) n FROM outbox').get()};
 const status=c.operations.status('owner') as any,encoded=JSON.stringify(status);
 expect(status.agents.find((agent:any)=>agent.id==='alice')).toMatchObject({registered:true,paused:true});
 expect(status.uncertainActions.items).toContainEqual({id:'action',agentId:'alice',runId:token.id,state:'unknown'});
 expect(status.uncertainOutputs.items).toContainEqual({id:'unknown-output',agentId:'alice',state:'unknown'});
 expect(status.heldDrafts.items[0]).toMatchObject({draftId:'held-output',agentId:'alice',state:'held'});
 expect(status.dueReminders.items[0]).toMatchObject({agentId:'alice',workId:f.work,nextAt:0});
 for(const secret of ['PRIVATE_TASK_TITLE','PRIVATE_TASK_RESULT','PRIVATE_REMINDER_CONTENT','PRIVATE_HELD_OUTPUT','PRIVATE_UNKNOWN_OUTPUT','PRIVATE_OUTPUT_RECEIPT','PRIVATE_ACTION_REQUEST','PRIVATE_RUN_ERROR','PRIVATE_INPUT'])expect(encoded).not.toContain(secret);
 const controls=new Controls(c,{} as any,{} as any);expect(controls.execute('owner','status')).toEqual(status);
 expect(new LocalConsole(f.input,controls).execute({id:'status',op:'control',human:'owner',text:'status'})).toEqual({id:'status',result:status});
 expect({deliveries:s.db.prepare('SELECT count(*) n FROM deliveries').get(),events:s.db.prepare('SELECT count(*) n FROM conversation_events').get(),outbox:s.db.prepare('SELECT count(*) n FROM outbox').get()}).toEqual(before);
});

it('merges safe activity with a query-bound vector cursor and never wakes an Agent',()=>{
 vi.useFakeTimers();vi.setSystemTime(20000);const f=setup(),c=f.collaboration,s=f.store;
 const task=c.createTask('alice',f.work,f.target,'PRIVATE_TASK');c.claim('alice',task);c.update('alice',task,'done','PRIVATE_RESULT');
 const reminder=c.reminders.create('alice',f.work,{target:f.target,content:'PRIVATE_CONTENT',nextAt:20000,timezone:'UTC'});c.tick(20000);
 const firing=(s.db.prepare('SELECT id FROM reminder_firings WHERE reminder_id=?').get(reminder.id) as {id:string}).id;c.reminders.finish('alice',firing,'completed','PRIVATE_SUMMARY');
 const token=run(f,'alice','activity-run');s.prepareAction(token,'safe-action',{secret:'PRIVATE_REQUEST'});s.startAction(token,'safe-action');s.settleAction(token,'safe-action','failed',{secret:'PRIVATE_RECEIPT'});s.finish(token);
 const before={deliveries:s.db.prepare('SELECT count(*) n FROM deliveries').get(),events:s.db.prepare('SELECT count(*) n FROM conversation_events').get(),facts:s.db.prepare('SELECT count(*) n FROM operational_facts').get()};
 let cursor:string|undefined,all:any[]=[];do{const page=c.operations.activity('owner',{limit:2,...(cursor?{cursor}:{})});all.push(...page.items);cursor=page.cursor??undefined;if(all.length>100)throw new Error('pagination loop');}while(cursor);
 expect(new Set(all.map(item=>`${item.source}:${item.sourceId}`)).size).toBe(all.length);
 expect([...new Set(all.map(item=>item.source))]).toEqual(expect.arrayContaining(['task','reminder_event','reminder_firing','run','action','runtime']));
 const encoded=JSON.stringify(all);for(const secret of ['PRIVATE_TASK','PRIVATE_RESULT','PRIVATE_CONTENT','PRIVATE_SUMMARY','PRIVATE_REQUEST','PRIVATE_RECEIPT'])expect(encoded).not.toContain(secret);
 expect(all.find(item=>item.kind==='runtime.run_completed')).toMatchObject({actorId:'alice',subject:{type:'run',id:token.id}});
 const first=c.operations.activity('owner',{limit:1});expect(first.cursor).toBeTruthy();expect(()=>c.operations.activity('owner',{limit:2,cursor:first.cursor!})).toThrow('query mismatch');
 expect(first.sources.runtime!.coverage).toMatchObject({historicalComplete:false,availableSince:expect.any(Number)});
 expect({deliveries:s.db.prepare('SELECT count(*) n FROM deliveries').get(),events:s.db.prepare('SELECT count(*) n FROM conversation_events').get(),facts:s.db.prepare('SELECT count(*) n FROM operational_facts').get()}).toEqual(before);
});

it('rolls runtime and internal DM state back when their required fact cannot commit, then replays facts idempotently',async()=>{
 const f=setup(),s=f.store,token=run(f,'alice','rollback-run');
 s.db.exec("CREATE TRIGGER reject_runtime_fact BEFORE INSERT ON operational_facts WHEN NEW.source='runtime' BEGIN SELECT RAISE(ABORT,'fact rejected'); END");
 expect(()=>s.finish(token)).toThrow('fact rejected');expect(s.db.prepare('SELECT state FROM runs WHERE id=?').get(token.id)).toEqual({state:'active'});expect(s.delivery(token.deliveryId).status).toBe('injected');
 s.db.exec('DROP TRIGGER reject_runtime_fact');s.finish(token);expect(s.db.prepare('SELECT state FROM runs WHERE id=?').get(token.id)).toEqual({state:'complete'});

 const dmRun=run(f,'alice','dm-run'),directory=new TeamDirectory(f.messages);
 s.db.exec("CREATE TRIGGER reject_dm_fact BEFORE INSERT ON operational_facts WHEN NEW.source='internal_dm' BEGIN SELECT RAISE(ABORT,'dm fact rejected'); END");
 await expect(directory.openDM(dmRun,'open-dm',{kind:'agent',id:'bob'},new AbortController().signal)).rejects.toThrow('dm fact rejected');
 expect(s.db.prepare('SELECT count(*) n FROM internal_dm_pairs').get()).toEqual({n:0});expect(s.action('open-dm')).toBeUndefined();
 s.db.exec('DROP TRIGGER reject_dm_fact');const target=await directory.openDM(dmRun,'open-dm',{kind:'agent',id:'bob'},new AbortController().signal);
 expect(await directory.openDM(dmRun,'open-dm',{kind:'agent',id:'bob'},new AbortController().signal)).toEqual(target);
 expect(s.db.prepare("SELECT count(*) n FROM operational_facts WHERE source='internal_dm'").get()).toEqual({n:1});
 const fact={source:'internal_dm' as const,sourceId:(target as any).conversationId,kind:'internal_dm_created' as const,actorId:'alice',subject:{type:'internal_dm' as const,id:(target as any).conversationId},counts:{members:2 as const}};
 s.atomic(()=>s.operationalFact(fact));expect(s.db.prepare("SELECT count(*) n FROM operational_facts WHERE source='internal_dm'").get()).toEqual({n:1});
 expect(()=>s.atomic(()=>s.operationalFact({...fact,actorId:'bob'}))).toThrow('identity conflict');
});

it('keeps reminder history coverage incomplete after editing a migrated reminder',()=>{
 const f=setup(),c=f.collaboration,s=f.store,reminder=c.reminders.create('alice',f.work,{target:f.target,content:'legacy purpose',nextAt:50000,timezone:'UTC'});
 s.db.prepare('UPDATE schedules SET legacy=1 WHERE id=?').run(reminder.id);s.db.prepare('UPDATE reminder_event_baselines SET historical_complete=0 WHERE reminder_id=?').run(reminder.id);
 c.reminders.edit('alice',reminder.id,reminder.version,{target:f.target,content:'edited purpose',nextAt:60000,timezone:'UTC'});
 expect(s.db.prepare('SELECT legacy FROM schedules WHERE id=?').get(reminder.id)).toEqual({legacy:0});
 expect(c.operations.activity('owner',{sources:['reminder_event','reminder_firing']}).sources).toMatchObject({reminder_event:{coverage:{historicalComplete:false,gapCount:1}},reminder_firing:{coverage:{historicalComplete:false,gapCount:1}}});
});

it('rolls owner work control back when the centralized runtime fact fails',()=>{
 const f=setup(),s=f.store,token=run(f,'alice','controlled');
 s.db.exec("CREATE TRIGGER reject_control_fact BEFORE INSERT ON operational_facts WHEN NEW.source='runtime' BEGIN SELECT RAISE(ABORT,'control fact rejected'); END");
 expect(()=>f.collaboration.control('owner',f.work,'pause')).toThrow('control fact rejected');
 expect(f.collaboration.work(f.work).state).toBe('active');expect(s.db.prepare('SELECT state FROM runs WHERE id=?').get(token.id)).toEqual({state:'active'});expect(s.db.prepare("SELECT count(*) n FROM operational_facts WHERE source_id=?").get(`${token.id}:interrupted`)).toEqual({n:0});
 s.db.exec('DROP TRIGGER reject_control_fact');f.collaboration.control('owner',f.work,'pause');expect(s.db.prepare('SELECT state FROM runs WHERE id=?').get(token.id)).toEqual({state:'interrupted'});
});

it('pages a sparse actor and kind filter without loss or duplicates',()=>{
 vi.useFakeTimers();vi.setSystemTime(70000);const f=setup(),c=f.collaboration;
 for(let i=0;i<125;i++){c.createTask('bob',f.work,f.target,`peer ${i}`);c.createTask('alice',f.work,f.target,`own ${i}`);}
 let cursor:string|undefined,items:any[]=[];do{const page=c.operations.activity('owner',{sources:['task'],actorId:'alice',kinds:['task.create'],limit:17,...(cursor?{cursor}:{})});items.push(...page.items);cursor=page.cursor??undefined;}while(cursor);
 expect(items).toHaveLength(125);expect(new Set(items.map(item=>item.sourceId)).size).toBe(125);expect(items.every(item=>item.actorId==='alice'&&item.kind==='task.create')).toBe(true);
});

it('keeps oversized Slack control responses valid and directs the owner to a narrower query',()=>{
 const value={works:{items:Array.from({length:100},(_,i)=>({id:`work-${i}-${'x'.repeat(500)}`})),atLeast:101,truncated:true}};
 const reply=formatControlReply(value,1000),parsed=JSON.parse(reply);expect(Buffer.byteLength(reply)).toBeLessThan(1000);expect(parsed).toMatchObject({format:'mate.control-overflow.v1',truncated:true,fields:{works:{atLeast:101,truncated:true}}});expect(parsed.hint).toContain('smaller limit');
 expect(JSON.parse(formatControlReply({ok:true}))).toEqual({ok:true});
});
