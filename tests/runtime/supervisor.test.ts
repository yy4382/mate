import { afterEach, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Store } from '../../src/storage/store.js';
import { configSchema } from '../../src/config.js';
import { configFixture } from '../helpers/config.js';
import { Messages, Output } from '../../src/slack/messages.js';
import { Collaboration } from '../../src/collaboration/service.js';
import { Broker } from '../../src/policy/broker.js';
import { Supervisor, type Worker } from '../../src/runtime/supervisor.js';
import { WorkerClient } from '../../src/runtime/client.js';
import { ToolRouter } from '../../src/runtime/tools.js';
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(fn => fn()));
function setup(factory?: (id: string) => Worker) {
  const config = configSchema.parse({ ...configFixture, agents: [configFixture.agents[0], { ...configFixture.agents[0], id: 'writer', name: 'Writer', slackAppId: 'ATWO', slackUserId: 'UTWO', slackBotId: 'BTWO', botTokenEnv: 'WRITER_BOT', appTokenEnv: 'WRITER_APP' }] });
  const store = new Store(':memory:'), messages = new Messages(store, config), output = new Output(messages, { post: async () => ({ ts: '100.000002' }) }), collaboration = new Collaboration(store, messages, output, config);
  const broker = new Broker(store, collaboration, { execute: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }) }, ['/never']);
  const router = new ToolRouter(collaboration, broker);
  const supervisor = new Supervisor(collaboration, router, config, agent => factory?.(agent.id) ?? new WorkerClient('test', 'test', 'only-provider-secret', new URL('../../dist/tests/helpers/worker-fixture.js', import.meta.url)));
  supervisor.register();
  for (const agent of config.agents) for (const channel of ['CTEST','CTWO']) messages.membership(agent.id, channel, true);
  const work = collaboration.createWork('human:one', { channel: 'CTEST', thread: '100.000001' });
  cleanups.push(() => { supervisor.close(); store.close(); }); return { config, store, collaboration, supervisor, router, work };
}
function last(store: Store, agent: string) {
  const row = store.db.prepare('SELECT session_id FROM agents WHERE id=?').get(agent) as { session_id: string };
  const message = (store.context(row.session_id) as AgentMessage[]).findLast(m => m.role === 'assistant');
  if (message?.role !== 'assistant' || message.content[0]?.type !== 'text') throw new Error('No assistant result');
  return { session: row.session_id, data: JSON.parse(message.content[0].text) };
}
it('real worker processes retain cross-channel context and isolate Agent state and inherited secrets', async () => {
  process.env.SYNTHETIC_SLACK_SECRET = 'must-not-inherit';
  try {
    const { store, collaboration: c, supervisor, work } = setup();
    c.enqueue('research', work, 'channel-one', { text: 'first private input', target: { channel: 'CTEST', thread: '100.000001' } });
    await supervisor.step('research'); const first = last(store, 'research');
    c.enqueue('research', work, 'channel-two', { text: 'second channel', target: { channel: 'CTWO', thread: '100.000001' } });
    c.enqueue('writer', work, 'writer-one', { text: 'writer only' });
    await Promise.all([supervisor.step('research'), supervisor.step('writer')]);
    const second = last(store, 'research'), writer = last(store, 'writer');
    expect(second.session).toBe(first.session); expect(second.data.calls).toBe(2); expect(second.data.pid).toBe(first.data.pid);
    expect(writer.session).not.toBe(first.session); expect(writer.data.pid).not.toBe(first.data.pid); expect(writer.data.calls).toBe(1);
    expect(JSON.stringify(second.data.context)).toContain('first private input'); expect(JSON.stringify(writer.data.context)).not.toContain('first private input');
    expect(second.data.env).not.toContain('SYNTHETIC_SLACK_SECRET'); expect(second.data.env).not.toContain('HOME');
  } finally { delete process.env.SYNTHETIC_SLACK_SECRET; }
}, 15000);
it('worker loss keeps reservation and input; explicit recovery resumes the same logical session', async () => {
  let failures = true;
  const { store, collaboration: c, supervisor, work } = setup(() => failures ? { run: async () => { throw new Error('killed'); }, close: () => {} } : new WorkerClient('test','test','key',new URL('../../dist/tests/helpers/worker-fixture.js',import.meta.url)));
  const delivery = c.enqueue('research', work, 'one', { text: 'recover me' });
  await supervisor.step('research'); expect(store.delivery(delivery).status).toBe('injected'); expect(c.work(work).tokens).toBe(50000);
  // The owner explicitly raises exhausted budget before resuming this synthetic test.
  store.db.prepare('UPDATE works SET max_tokens=300000 WHERE id=?').run(work); store.resume('research'); failures = false;
  await supervisor.step('research'); expect(store.delivery(delivery).status).toBe('handled'); expect(JSON.stringify(last(store,'research').data.context)).toContain('recover me');
}, 10000);
it('local tools use immutable receipts and can claim another visible activity', async () => {
  const { store, collaboration: c, work, router } = setup(); c.enqueue('research', work, 'one', {}); const run = store.beginRun('research')!; store.input(run, {});
  const target = { channel: 'CTEST', thread: '100.000001' }, signal = new AbortController().signal;
  const created = await router.call(run, work, 'create', 'tasks.create', { target, title: 'one' }, signal);
  expect(await router.call(run, work, 'create', 'tasks.create', { target, title: 'one' }, signal)).toEqual(created); expect(c.list('research')).toHaveLength(1);
  const other = c.createWork('human:other', target), task = c.createTask('research', other, target, 'other');
  const held=(await router.call(run,work,'claim','tasks.claim',{taskId:task,expectedVersion:0},signal)).value as any; expect(c.task(task).owner).toBeNull(); await router.call(run,work,'continue-claim','tasks.continue',{intentId:held.intentId,holdId:held.holdId,acknowledge:'apply_despite_unread_or_changes'},signal);expect(c.task(task).owner).toBe('research');
  await expect(router.call(run, work, 'spoof', 'messages.send', { target, text: 'hi', agentId: 'writer' }, signal)).rejects.toThrow();
});
it('recovery is bounded even with large task results; memory callback is injected and hashed', async () => {
  let seen: import('../../src/runtime/engine.js').RunSpec | undefined;
  const { store, collaboration: c, work, router, config, supervisor: original } = setup(); original.close();
  const supervisor = new Supervisor(c, router, config, () => ({ run: async spec => { seen = spec; return { tokens: 0, cost: 0, certain: true, waiting: false, continuation: false }; }, close: () => {} }), async () => '私有memory'.repeat(10000));
  cleanups.unshift(() => supervisor.close());
  for (let n = 0; n < 3; n++) { const task = c.createTask('research', work, { channel: 'CTEST', thread: '100.000001' }, 'big'); c.claim('research', task); c.update('research', task, 'review', 'x'.repeat(35000)); }
  c.enqueue('research', work, 'large', {}); await supervisor.step('research');
  expect(Buffer.byteLength(seen!.recovery)).toBeLessThan(15000); expect(JSON.parse(seen!.recovery).memoryNeedsOrganization).toBe(true);
  expect(JSON.parse(seen!.recovery).memory).toContain('私有memory'); expect(store.db.prepare("SELECT count(*) n FROM audit WHERE kind='context_restore'").get()).toEqual({ n: 1 });
});
it('inbox list/read cannot reveal a revoked channel and ack never handles queued delivery', async () => {
  const { store, collaboration: c, work, router } = setup(); const first = c.enqueue('research', work, 'first', {}); const run = store.beginRun('research')!; store.input(run, {});
  const secret = c.enqueue('research', work, 'secret', { target: { channel: 'CTWO', thread: '100.000001' }, text: 'private' });
  c.messages.membership('research', 'CTWO', false); const signal = new AbortController().signal;
  expect(JSON.stringify(await router.call(run, work, 'list', 'inbox.list', {}, signal))).not.toContain(secret);
  await expect(router.call(run, work, 'read', 'inbox.read', { deliveryId: secret }, signal)).rejects.toThrow();
  await router.call(run, work, 'ack', 'inbox.ack', { deliveryId: first }, signal); expect(store.delivery(first).status).toBe('injected');
});
it('invalid run IPC fails immediately instead of consuming the run timeout', async () => {
  const worker = new WorkerClient('test','test','key',new URL('../../dist/tests/helpers/worker-fixture.js',import.meta.url));
  try { await expect(worker.run({ sessionId: 's', messages: [], recovery: 'x'.repeat(50001), tokenCap: 100, costCap: 1, maxTurns: 1 }, { journal: async () => {}, tool: async () => ({ value: null }) }, 10000, new AbortController().signal)).rejects.toThrow('Invalid worker run payload'); }
  finally { worker.close(); }
}, 2000);
it('crash after effect commit before tool-result journal restores its receipt without re-execution', async () => {
  const { answer } = await import('../helpers/pi.js'); let first = true, restored = '';
  const { store, collaboration: c, work, supervisor } = setup(() => ({ close: () => {}, run: async (spec, hooks) => {
    if (first) {
      first = false;
      await hooks.journal(answer([{ type: 'toolCall', id: 'create-committed', name: 'mate', arguments: { operation: 'tasks.create', args: { target: { channel: 'CTEST', thread: '100.000001' }, title: 'commit before crash' } } }], 'toolUse'));
      await hooks.tool('create-committed', 'tasks.create', { target: { channel: 'CTEST', thread: '100.000001' }, title: 'commit before crash' });
      throw new Error('kill before result journal');
    }
    restored = JSON.stringify(spec.messages); return { tokens: 0, cost: 0, certain: true, waiting: false, continuation: false };
  } }));
  c.enqueue('research', work, 'crash-window', {}); await supervisor.step('research'); expect(c.list('research')).toHaveLength(1);
  store.resume('research'); await supervisor.step('research'); expect(c.list('research')).toHaveLength(1);
  expect(restored).toContain('recoveredAction'); expect(restored).toContain('succeeded'); expect(restored).toContain('Historical receipt');
});
it('switching activity retains the Agent account and work stop targets the selected activity', async()=>{
  const {store,collaboration:c,work,router}=setup();
  const other=c.createWork('other',{channel:'CTWO'});c.enqueue('research',work,'one',{});
  const run=store.beginRun('research')!;store.input(run,{});c.reserve(run,work,100,0.1);
  const before=c.ledger.account('research');
  await router.call(run,work,'switch','works.select',{workId:other},new AbortController().signal);
  await router.call(run,work,'create','tasks.create',{target:{channel:'CTWO'},title:'new context'},new AbortController().signal);
  expect(c.list('research')[0]?.work_id).toBe(other);expect(c.ledger.account('research')).toEqual(before);
  expect(c.control('UOWNER',work,'pause')).toEqual([]);expect(c.control('UOWNER',other,'pause')).toEqual([run.id]);
});
it('an exhausted activity does not pause the Agent or starve another activity',async()=>{
  const {store,collaboration:c,work,supervisor}=setup(()=>({close:()=>{},run:async()=>({tokens:1,cost:0,certain:true,waiting:false,continuation:false})}));
  store.db.prepare('UPDATE works SET tokens=max_tokens WHERE id=?').run(work);
  c.enqueue('research',work,'old',{});await supervisor.step('research');
  const other=c.createWork('other',{channel:'CTWO'});const delivery=c.enqueue('research',other,'new',{});
  await supervisor.step('research');expect(store.delivery(delivery).status).toBe('handled');
  expect(store.db.prepare("SELECT paused FROM agents WHERE id='research'").get()).toEqual({paused:0});
});
it('new messages and new work cannot erase unknown account usage',()=>{
  const {store,collaboration:c,work}=setup();
  c.ledger.setLimits('UOWNER','research',3,100,1);c.enqueue('research',work,'one',{});
  const run=store.beginRun('research')!;store.input(run,{});c.reserve(run,work,100,0.5);store.finish(run);
  const other=c.createWork('human:new',{channel:'CTWO'});c.enqueue('research',other,'two',{});const next=store.beginRun('research')!;
  expect(()=>c.reserve(next,other,1,0)).toThrow('Agent budget exhausted');
  expect(c.ledger.account('research').tokens).toBe(100);
});
it('selected activity survives interrupted delivery recovery while its origin is paused',()=>{
  const {store,collaboration:c,work}=setup();const other=c.createWork('other',{channel:'CTWO'});
  c.enqueue('research',work,'one',{});const first=store.beginRun('research')!;store.input(first,{});c.reserve(first,work,10,0.1);
  c.selectWork(first,other);c.control('UOWNER',work,'pause');store.recover();
  const next=store.beginRun('research',Date.now(),true)!;expect(next).toBeDefined();
  c.reserve(next,other,10,0.1);expect(c.currentWork(next,work)).toBe(other);
  expect(c.ledger.account('research').tokens).toBe(20);
});
it('work selection replays its receipt and distinguishes own reservation from exhausted unrelated work',async()=>{
  const {store,collaboration:c,work,router}=setup();const other=c.createWork('other',{channel:'CTWO'});
  c.enqueue('research',work,'one',{});const run=store.beginRun('research')!;store.input(run,{});c.reserve(run,work,100000,1);
  const signal=new AbortController().signal;
  await router.call(run,work,'create','tasks.create',{target:{channel:'CTEST'},title:'reserved allowance'},signal);
  const first=await router.call(run,work,'switch','works.select',{workId:other},signal);
  expect(await router.call(run,work,'switch','works.select',{workId:other},signal)).toEqual(first);
  const exhausted=c.createWork('exhausted',{channel:'CTEST'});store.db.prepare('UPDATE works SET tokens=max_tokens WHERE id=?').run(exhausted);
  await expect(router.call(run,work,'blocked','works.select',{workId:exhausted},signal)).rejects.toThrow('budget exhausted');
});
it('cached attention.read rechecks current membership even with an expired presentation epoch',async()=>{
 const{store,collaboration:c,router,work}=setup();c.enqueue('research',work,'start',{});const run=store.beginRun('research')!;const args={target:{channel:'CTEST'}},signal=new AbortController().signal;
 await router.call(run,work,'read','attention.read',args,signal);c.attention.invalidate(run.sessionId);c.messages.membership('research','CTEST',false);
 await expect(router.call(run,work,'read','attention.read',args,signal)).rejects.toThrow('access');
});
it('fresh review seat withholds bodies through tools, notice, recovery and held feedback while allowing an independent submission',async()=>{
 let captured='';const {store,collaboration:c,work,router,supervisor}=setup(()=>({close:()=>{},run:async(spec,hooks)=>{captured=JSON.stringify(spec);captured+=await hooks.notice?.();return{tokens:1,cost:0,certain:true,waiting:false,continuation:false};}}));
 const target={channel:'CTEST',thread:'100.000001'};
 c.messages.record({team:'TTEST',channel:'CTEST',thread:target.thread,ts:target.thread,revision:target.thread,text:'WITHHELD_PEER_CONCLUSION',user:'UTWO',deleted:false},['research']);
 c.seats.activate('UOWNER','research',target,'Independently compute 2+2; submit result.',()=>'/synthetic/clean-review-root');
 const delivery=c.enqueue('research',work,'review',{text:'WITHHELD_PEER_CONCLUSION',source:{id:'UTWO'},target});store.db.prepare('UPDATE deliveries SET created_at=1234567890000 WHERE id=?').run(delivery);await supervisor.step('research');
 expect(captured).toContain('Independently compute');expect(captured).not.toContain('WITHHELD_PEER_CONCLUSION');expect(captured).not.toContain('UTWO');expect(captured).not.toContain('1234567890000');
 const session=(store.db.prepare("SELECT session_id FROM agents WHERE id='research'").get() as {session_id:string}).session_id;expect(JSON.stringify(store.context(session))).not.toContain('1234567890000');
 c.enqueue('research',work,'tools',{});const run=store.beginRun('research')!;const signal=new AbortController().signal;
 for(const [op,args] of [['messages.read',{target}],['messages.search',{query:'CONCLUSION'}],['attention.read',{target}],['inbox.list',{}],['tasks.list',{}],['conversations.members',{channel:'CTEST'}],['research.read',{url:'https://example.com'}]] as const)await expect(router.call(run,work,op,op,args,signal)).rejects.toThrow('isolates');
 const result=await router.call(run,work,'send','messages.send',{target,text:'My independent result is 4'},signal);const held=result.value as any;expect(held.status).toBe('held');expect(JSON.stringify(held)).not.toContain('WITHHELD');
 await router.call(run,work,'continue','drafts.continue',{draftId:held.draftId,revision:held.revision,holdId:held.holdId,acknowledge:'send_despite_unread_or_changes'},signal);await c.output.send(held.draftId);expect(store.output(held.draftId)?.state).toBe('sent');
 expect(store.db.prepare('SELECT count(*) n FROM attention_seen').get()).toEqual({n:0});
});
it('review activation cannot wash an already used identity or accept an unverified workspace',()=>{
 const{store,collaboration:c,work}=setup();const target={channel:'CTEST'};
 expect(()=>c.seats.activate('UTWO','research',target,'brief',()=>'/clean')).toThrow('Owner');
 expect(()=>c.seats.activate('UOWNER','research',target,'brief',()=>{throw new Error('dirty workspace');})).toThrow('dirty');
 c.enqueue('research',work,'used',{});store.beginRun('research');expect(()=>c.seats.activate('UOWNER','research',target,'brief',()=>'/clean')).toThrow('unused');
});

it('discovery aliases preserve grants, receipts and strict actor schemas for file capabilities',async()=>{
 const {store,collaboration:c,work,router}=setup();c.enqueue('research',work,'files',{});const run=store.beginRun('research')!;store.input(run,{});const signal=new AbortController().signal;
 const list=await router.call(run,work,'list-tools','tools.list',{},signal);expect(JSON.stringify(list)).toContain('file.edit');
 const schema=await router.call(run,work,'schema','tools.describe',{name:'file.edit'},signal);expect(JSON.stringify(schema)).toContain('expectedHash');
 await expect(router.call(run,work,'read','tools.call',{name:'file.list',input:{grantId:'missing',path:'.'}},signal)).rejects.toThrow('Grant');
 await expect(router.call(run,work,'spoof','tools.call',{name:'file.list',input:{grantId:'missing',path:'.',agentId:'writer'}},signal)).rejects.toThrow();
 await expect(router.call(run,work,'recurse','tools.call',{name:'tools.call',input:{}},signal)).rejects.toThrow('Unknown');
});
it('registered adapters cannot bypass a review seat through direct or discovery calls',async()=>{
 const{store,collaboration:c,work,router}=setup();c.enqueue('research',work,'adapter',{});const run=store.beginRun('research')!;store.input(run,{});const signal=new AbortController().signal;
 const {z}=await import('zod');let called=0;router.environment.register({name:'custom.external',description:'test',schema:z.object({}).strict(),execute:async()=>{called++;return{value:'external'};}});
 store.db.prepare('INSERT INTO review_seats VALUES(?,?,?,?,1)').run('research',JSON.stringify({channel:'CTEST'}),'brief','/synthetic');
 await expect(router.call(run,work,'direct','custom.external',{},signal)).rejects.toThrow('review seat');
 await expect(router.call(run,work,'alias','tools.call',{name:'custom.external',input:{}},signal)).rejects.toThrow('review seat');expect(called).toBe(0);
});
it('prototype-named registered adapters still obey stopped work',async()=>{
 const{store,collaboration:c,work,router}=setup();c.enqueue('research',work,'adapter-work',{});const run=store.beginRun('research')!;store.input(run,{});const {z}=await import('zod');let called=0;
 router.environment.register({name:'constructor',description:'test',schema:z.object({}).strict(),execute:async()=>{called++;return{value:null};}});
 store.db.prepare("UPDATE works SET state='paused' WHERE id=?").run(work);
 await expect(router.call(run,work,'stopped-adapter','tools.call',{name:'constructor',input:{}},new AbortController().signal)).rejects.toThrow();expect(called).toBe(0);
});
