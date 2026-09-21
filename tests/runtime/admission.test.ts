import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FairAdmission} from '../../src/concurrency/admission.js';
import {AdmittedBackend} from '../../src/execution/admitted.js';
import {daemonConfigSchema} from '../../src/daemon/config.js';
import {Daemon} from '../../src/daemon/app.js';
import {SandboxBackend} from '../../src/execution/backend.js';

const cleanup:(()=>Promise<unknown>|void)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0).reverse())await close();});

it('admits in FIFO order, removes cancelled waiters and makes release idempotent',async()=>{
  const admission=new FairAdmission(1),order:string[]=[];
  const first=await admission.acquire(),cancel=new AbortController();
  const second=admission.acquire(cancel.signal).then(release=>{order.push('second');release();});
  const third=admission.acquire().then(release=>{order.push('third');release();});
  expect(admission.snapshot()).toEqual({active:1,queued:2,limit:1});cancel.abort();await expect(second).rejects.toThrow('cancelled');
  first();first();await third;expect(order).toEqual(['third']);expect(admission.snapshot()).toEqual({active:0,queued:0,limit:1});
});

it('bounds backend operations and releases a slot after cancellation or failure',async()=>{
  const calls:string[]=[];let releaseFirst!:()=>void;const gate=new Promise<void>(resolve=>releaseFirst=resolve);
  const backend=new AdmittedBackend({execute:vi.fn(async request=>{const path=(request.operation as any).path as string;calls.push(path);if(path==='first')await gate;if(path==='failure')throw new Error('synthetic failure');return{code:0,stdout:'',stderr:'',truncated:false};})},new FairAdmission(1));
  const request=(path:string)=>({root:'/synthetic',operation:{kind:'read' as const,path},timeoutMs:1000});
  const first=backend.execute(request('first')),cancel=new AbortController(),cancelled=backend.execute(request('cancelled'),cancel.signal);cancel.abort();await expect(cancelled).rejects.toThrow('cancelled');
  const third=backend.execute(request('third'));await Promise.resolve();expect(calls).toEqual(['first']);releaseFirst();await first;await third;
  await expect(backend.execute(request('failure'))).rejects.toThrow('synthetic failure');await expect(backend.execute(request('after-failure'))).resolves.toMatchObject({code:0});
  expect(calls).toEqual(['first','third','failure','after-failure']);
});

it('releases run admission when pre-run accounting throws',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'mate-admission-error-')));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const raw=JSON.parse(readFileSync(resolve('mate.local.example.json'),'utf8'));raw.runtime.dataDir=join(root,'data');const daemon=await Daemon.create(daemonConfigSchema.parse(raw),{info:()=>{},error:()=>{}});cleanup.push(()=>daemon.close());
  const work=daemon.collaboration.createWork('accounting-failure',{conversationId:'team-room'});daemon.collaboration.enqueue('research',work,'retain-input',{});
  const account=vi.spyOn(daemon.collaboration.ledger,'account').mockImplementationOnce(()=>{throw new Error('synthetic accounting failure');});
  await expect(daemon.supervisor.step('research')).rejects.toThrow('synthetic accounting failure');
  expect((daemon.supervisor as any).admission.snapshot()).toEqual({active:0,queued:0,limit:1});account.mockRestore();
  vi.spyOn(daemon.supervisor,'factory').mockReturnValue({close(){},async run(){return{tokens:1,cost:0,certain:true,waiting:false,continuation:false};}});
  await expect(daemon.supervisor.step('research')).resolves.toBe(true);
});

it('shares backend admission with concurrent private-memory recovery',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'mate-recovery-admission-')));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const raw=JSON.parse(readFileSync(resolve('mate.local.example.json'),'utf8'));raw.runtime.dataDir=join(root,'data');raw.runtime.limits={maxActiveRuns:2,maxBackendOperations:1,workerIdleMs:300000};
  let active=0,maximum=0;const releases:(()=>void)[]=[];
  vi.spyOn(SandboxBackend.prototype,'execute').mockImplementation(async()=>{active++;maximum=Math.max(maximum,active);await new Promise<void>(resolve=>releases.push(resolve));active--;return{code:0,stdout:'memory',stderr:'',truncated:false};});
  const daemon=await Daemon.create(daemonConfigSchema.parse(raw),{info:()=>{},error:()=>{}});cleanup.push(()=>daemon.close());
  const work=daemon.collaboration.createWork('recovery-admission',{conversationId:'team-room'}),signal=new AbortController().signal;
  const first=daemon.supervisor.recovery('research',work,signal),second=daemon.supervisor.recovery('writer',work,signal);
  await vi.waitFor(()=>expect(releases).toHaveLength(1));expect(maximum).toBe(1);releases.shift()!();
  await vi.waitFor(()=>expect(releases).toHaveLength(1));expect(maximum).toBe(1);releases.shift()!();await Promise.all([first,second]);
});

it('production Daemon runs one Agent at a time, cancels a queued Agent, preserves FIFO and reaps idle workers',async()=>{
  let now=19_999;vi.spyOn(Date,'now').mockImplementation(()=>now);
  const root=realpathSync(mkdtempSync(join(tmpdir(),'mate-admission-')));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const raw=JSON.parse(readFileSync(resolve('mate.local.example.json'),'utf8'));raw.runtime.dataDir=join(root,'data');raw.runtime.limits={maxActiveRuns:1,maxBackendOperations:1,workerIdleMs:600};
  raw.mate.agents.push({...raw.mate.agents[0],id:'observer',name:'Observer'});raw.adapters.local.rooms[0].agents.push('observer');const config=daemonConfigSchema.parse(raw);
  const previous=process.env.MODEL_API_KEY;process.env.MODEL_API_KEY='synthetic';cleanup.push(()=>{if(previous===undefined)delete process.env.MODEL_API_KEY;else process.env.MODEL_API_KEY=previous;});
  const daemon=await Daemon.create(config,{info:()=>{},error:()=>{}});cleanup.push(()=>daemon.close());vi.spyOn(daemon.supervisor,'recovery').mockResolvedValue('memory');
  const started:string[]=[],closed:string[]=[];let releaseResearch!:()=>void;const researchGate=new Promise<void>(resolve=>releaseResearch=resolve);
  cleanup.push(()=>releaseResearch());
  vi.spyOn(daemon.supervisor,'factory').mockImplementation(agent=>({close(){closed.push(agent.id);},async run(){started.push(agent.id);if(agent.id==='research')await researchGate;return{tokens:1,cost:0,certain:true,waiting:false,continuation:false};}}));
  daemon.local!.receive('owner','admission-input',{conversationId:'team-room'},'schedule fairly');now=20_000;await daemon.start();
  await vi.waitFor(()=>expect(started).toEqual(['research']));expect(daemon.store.db.prepare("SELECT count(*) n FROM runs WHERE state='active'").get()).toEqual({n:1});
  daemon.supervisor.stopAgent('writer');releaseResearch();
  await vi.waitFor(()=>expect(started).toEqual(['research','observer']));expect(started).not.toContain('writer');
  // The scheduler probes for work every 500ms; those empty probes must not reset the idle deadline.
  await vi.waitFor(()=>expect(new Set(closed)).toEqual(new Set(['research','observer'])),{timeout:2000});
  expect(daemon.store.db.prepare("SELECT paused FROM agents WHERE id='writer'").get()).toEqual({paused:1});
});

it('requires a finite positive worker idle timeout in deployment configuration',()=>{
  const raw=JSON.parse(readFileSync(resolve('mate.local.example.json'),'utf8'));raw.runtime.limits.workerIdleMs=0;
  expect(()=>daemonConfigSchema.parse(raw)).toThrow();
});
