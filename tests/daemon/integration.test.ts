import { fixtureTarget, externalThread } from '../helpers/canonical-slack.js';
import { CanonicalSlackNormalizer } from '../../src/slack/normalize.js';
import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync,existsSync,mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/storage/store.js';
import { configSchema } from '../../src/config.js';
import { configFixture } from '../helpers/config.js';
import { Messages, Output,migrateCurrentRuntime } from '../helpers/canonical-slack.js';
import { Collaboration } from '../../src/collaboration/service.js';
import { Broker } from '../../src/policy/broker.js';
import { Supervisor } from '../../src/runtime/supervisor.js';
import { ToolRouter } from '../../src/runtime/tools.js';
import { Engine } from '../../src/runtime/engine.js';
import { answer, model } from '../helpers/pi.js';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Ingress } from '../../src/daemon/ingress.js';
import { acquireLock } from '../../src/daemon/lock.js';
import { backup } from '../../src/daemon/backup.js';
import { Research, publicIPv4 } from '../../src/daemon/research.js';
import { Controls } from '../../src/daemon/control.js';
import { SlackService,formatControlReply } from '../../src/slack/service.js';
import { Directory } from '../../src/slack/directory.js';
import {DurableReceiver} from '../../src/slack/receiver.js';
import { CanonicalSlackTransport as WebSlackTransport } from '../../src/slack/transport.js';
import { Artifacts } from '../../src/daemon/artifacts.js';
import {ProcessNotRunningError,type LinuxProcessManager} from '../../src/execution/linux-processes.js';
import {SystemOperations} from '../../src/policy/system-operations.js';
import {daemonConfigSchema} from '../../src/daemon/config.js';
import {daemonFixture} from '../helpers/daemon-config.js';
const cleanups: (() => void)[] = [];
afterEach(() => {vi.restoreAllMocks();cleanups.splice(0).forEach(fn => fn());});
function setup() {
  const config = configSchema.parse({ ...configFixture, agents: [configFixture.agents[0], { ...configFixture.agents[0], id: 'writer', name: 'Writer', slackAppId: 'ATWO', slackUserId: 'UTWO', slackBotId: 'BTWO', botTokenEnv: 'WRITER_BOT', appTokenEnv: 'WRITER_APP' }] });
  const store = new Store(':memory:'), messages = new Messages(store, config);migrateCurrentRuntime(store);const post = vi.fn(async () => ({ ts: `101.${String(post.mock.calls.length).padStart(6,'0')}` }));
  const c = new Collaboration(store, messages, new Output(messages, { post }), config), ingress = new Ingress(c,new CanonicalSlackNormalizer(messages,messages.mapper,c.output));
  const backend = { execute: vi.fn(async () => ({ code: 0, stdout: 'artifact evidence', stderr: '', truncated: false })) };
  const broker = new Broker(store, c, backend, { research: '/tmp', writer: '/tmp' });
  cleanups.push(() => store.close()); return { store, c, ingress, broker, post, backend, mapper:messages.mapper };
}
it('keeps an inaccessible listed DM closed without blocking other Slack conversations', async () => {
  const { store, c, ingress, broker, mapper } = setup();
  for (const agent of c.config.agents) store.register(agent.id, 'v1', []);
  const transport = new WebSlackTransport(store, mapper, { research: 'synthetic', writer: 'synthetic' });
  const service = new SlackService(c, transport, ingress, new Controls(c, {} as any, broker));
  const stale = mapper.conversation('DSLACKBOT'), active = mapper.conversation('DOWNER');
  c.messages.membership('research', stale, true);
  c.messages.membership('research', active, true);
  const directory = new Directory(c.messages, transport.clients, mapper);
  transport.clients.get('research')!.users.conversations = vi.fn(async () => ({ channels: [
    { id: 'DSLACKBOT', user: 'USLACKBOT', is_im: true },
    { id: 'DOWNER', user: 'UOWNER', is_im: true },
  ] })) as any;
  const info = vi.fn(async ({ channel }: { channel: string }) => {
    if (channel === 'DSLACKBOT') throw { data: { error: 'channel_not_found' } };
    return { channel: { is_im: channel.startsWith('D'), is_member: channel.startsWith('C') } };
  });
  transport.clients.get('research')!.conversations.info = info as any;
  transport.clients.get('writer')!.conversations.info = info as any;
  const discovered = await directory.spaces('research');
  expect(discovered.spaces.map(space => space.conversationId)).not.toContain(stale);
  await expect(service.membership(true)).resolves.toBe(true);
  expect(c.messages.access('research', stale)).toBe(false);
  expect(c.messages.access('research', active)).toBe(true);
  expect(info).not.toHaveBeenCalledWith({ channel: 'DSLACKBOT' });
  expect(info).toHaveBeenCalledWith({ channel: 'DOWNER' });
  await directory.spaces('research');
  expect(c.messages.access('research', stale)).toBe(false);
  info.mockImplementation(async () => { throw new Error('network unavailable'); });
  await expect(service.membership(true)).rejects.toThrow('Slack membership verification did not complete');
  expect(c.messages.access('research', active)).toBe(false);
  info.mockImplementation(async ({ channel }) => {
    if (channel === 'CTEST') throw { data: { error: 'channel_not_found' } };
    return { channel: { is_im: channel.startsWith('D'), is_member: true } };
  });
  await expect(service.membership(true)).rejects.toThrow('Slack membership verification did not complete');
});
it('two Agents can coordinate through one canonical message and direct peer feedback without a task tree',async()=>{
 const{store,c,ingress,broker,post}=setup(),router=new ToolRouter(c,broker),target=fixtureTarget('CTEST','100.000001');
 let task:any,view='',phase='claim',step=0;
 const supervisor=new Supervisor(c,router,c.config,agent=>({close:()=>{},run:async(spec,hooks)=>{
  step=0;const engine=new Engine({...model,contextWindow:200000},()=>{
   let operation:string|undefined,args:any={};
   if(step++===0){operation='attention.read';args={target};}
   else if(step===2){
    if(phase==='claim'){operation='tasks.claim';args={message:{messageId:target.threadId},expectedVersion:0,viewToken:view};}
    else if(phase==='feedback'){operation='messages.send';args={target,text:'<@UONE> Independent evidence: 2+2=4.',viewToken:view};}
    else{operation='tasks.update';args={taskId:task.id,expectedVersion:task.version,status:'done',result:'Verified 2+2=4',viewToken:view};}
   }
   const message=operation?answer([{type:'toolCall',id:`${phase}:${agent.id}:${step}`,name:'mate',arguments:{operation,args}}],'toolUse'):answer([{type:'text',text:'yield'}]);
   const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:message.stopReason as 'stop'|'toolUse',message});return stream;
  });return engine.run(spec,{...hooks,tool:async(id,op,args)=>{const result=await hooks.tool(id,op,args);if(op==='attention.read')view=(result.value as any).viewToken;if(op==='tasks.claim')task=(result.value as any).result;return result;}});
 }}));cleanups.unshift(()=>supervisor.close());supervisor.register();for(const agent of c.config.agents)c.messages.membership(agent.id,'CTEST',true);
 store.ingest('AONE','root',{team_id:'TTEST',event:{type:'message',channel:'CTEST',ts:externalThread(target),user:'UOWNER',text:'<@UONE> Verify 2+2'}});ingress.replay('AONE','root');await supervisor.step('research');expect(task.owner).toBe('research');
 for(const row of c.output.ready())await c.output.send(row.id);
 phase='feedback';c.enqueue('writer',task.work_id,'peer-check',{target});await supervisor.step('writer');for(const row of c.output.ready())await c.output.send(row.id);
 phase='finish';await supervisor.step('research');expect(c.task(task.id).status).toBe('done');for(const row of c.output.ready())await c.output.send(row.id);
 expect(c.list('research')).toHaveLength(1);expect(c.task(task.id).message_key).toBe(JSON.stringify(['TTEST','CTEST',externalThread(target)]));expect(JSON.stringify(post.mock.calls)).toContain('Independent evidence');expect(store.db.prepare("SELECT count(*) n FROM runs WHERE state='failed'").get()).toEqual({n:0});
});
it('peer messages wake an Agent without creating a human-owned quota', async () => {
  const {store,c,ingress}=setup(); for(const agent of c.config.agents){store.register(agent.id,'v1',[]);c.messages.membership(agent.id,'CTEST',true);}
  store.ingest('ATWO','peer',{team_id:'TTEST',event:{type:'message',channel:'CTEST',ts:'100.000001',user:'UONE',bot_id:'BONE',text:'<@UTWO> help'}}); ingress.replay('ATWO','peer');
  const run=store.beginRun('writer',Date.now(),true)!; expect(run).toBeDefined();
  const binding=store.db.prepare('SELECT work_id FROM delivery_work WHERE delivery_id=?').get(run.deliveryId) as {work_id:string};
  c.bindRunWork(run,binding.work_id);expect(c.currentWork(run,binding.work_id)).toBe(binding.work_id);
});
it('kernel lock excludes a second daemon; backup restores SQLite plus private memory', async () => {
  const root=mkdtempSync(join(tmpdir(),'mate-checkpoint-')), data=join(root,'data'); mkdirSync(join(data,'agents','research'),{recursive:true});mkdirSync(join(data,'state')); writeFileSync(join(data,'agents','research','MEMORY.md'),'synthetic lesson');
  const release=acquireLock(join(root,'lock')); expect(()=>acquireLock(join(root,'lock'))).toThrow('Another Mate'); release(); const again=acquireLock(join(root,'lock')); again();
  const store=new Store(join(data,'state','mate.sqlite')); store.register('research','v1',[{role:'user',content:'persisted'}]);
  const checkpointConfig=daemonFixture(data);
  try { await backup(store,data,join(root,'checkpoint'),checkpointConfig); const restored=new Store(join(root,'checkpoint','mate.sqlite')); expect(restored.db.prepare('SELECT count(*) n FROM entries').get()).toEqual({n:1}); restored.close(); expect(readFileSync(join(root,'checkpoint','agents','research','MEMORY.md'),'utf8')).toBe('synthetic lesson'); }
  finally {store.close();rmSync(root,{recursive:true,force:true});}
});
it('public research rejects local/metadata destinations before HTTP', async () => {
  for(const ip of ['127.0.0.1','169.254.169.254','10.0.0.1','100.64.0.1','172.16.0.1','192.168.1.1','::1']) expect(publicIPv4(ip)).toBe(false);
  expect(publicIPv4('93.184.216.34')).toBe(true);
  await expect(new Research(['example.com']).read('https://127.0.0.1',new AbortController().signal)).rejects.toThrow('outside');
  await expect(new Research(['example.com']).read('https://secret@example.com',new AbortController().signal)).rejects.toThrow('outside');
});
it('starts the Linux-user route with a separate private home and peer-visible shared work root',async()=>{
  const {Daemon}=await import('../../src/daemon/app.js');
  const base=realpathSync(mkdtempSync(join(tmpdir(),'mate-linux-daemon-'))),data=join(base,'data'),home=join(base,'private-research'),sharedRoot=join(base,'shared');
  mkdirSync(home,{mode:0o700});for(const dir of ['notes','artifacts'])mkdirSync(join(home,dir),{mode:0o700});writeFileSync(join(home,'MEMORY.md'),'# Research\n\nPrivate memory entry. Keep durable lessons and links to notes here.\n',{mode:0o600});
  mkdirSync(sharedRoot,{mode:0o755});chmodSync(sharedRoot,0o755);mkdirSync(join(sharedRoot,'research'),{mode:0o755});chmodSync(join(sharedRoot,'research'),0o755);
  const user={uid:process.getuid!(),gid:process.getgid!(),home,username:'research'};
  const input=daemonFixture(data,configFixture,{linuxUsers:{research:user},sharedRoot,researchHosts:[]});
  mkdirSync(join(data,'state'),{recursive:true,mode:0o700});chmodSync(data,0o700);chmodSync(join(data,'state'),0o755);
  await expect(Daemon.create(input,{info:()=>{},error:()=>{}},process.cwd())).rejects.toThrow('Mate control directory');
  chmodSync(join(data,'state'),0o700);
  const daemon=await Daemon.create(input,{info:()=>{},error:()=>{}},process.cwd());
  try{
    expect(daemon.memoryRoots.research).toBe(realpathSync(home));
    expect(daemon.config.runtime.sharedRoot).toBe(realpathSync(sharedRoot));
    expect(existsSync(join(home,'MEMORY.md'))).toBe(true);
  }finally{await daemon.close();rmSync(base,{recursive:true,force:true});}
});
it('requires distinct non-root Linux identities and one shared root for the team',()=>{
  const other={...configFixture.agents[0]!,id:'bob',name:'Bob',slackAppId:'ATWO',slackUserId:'UTWO',slackBotId:'BTWO',botTokenEnv:'BOB_BOT',appTokenEnv:'BOB_APP'};
  const input=daemonFixture('/var/lib/mate',{...configFixture,agents:[configFixture.agents[0],other]},{sharedRoot:'/srv/mate/shared',linuxUsers:{research:{uid:1001,gid:1001,home:'/srv/mate/private/research'},bob:{uid:1002,gid:1002,home:'/srv/mate/private/bob'}}});
  expect(daemonConfigSchema.safeParse(input).success).toBe(true);
  expect(daemonConfigSchema.safeParse({...input,runtime:{...input.runtime,sharedRoot:undefined}}).success).toBe(false);
  expect(daemonConfigSchema.safeParse({...input,runtime:{...input.runtime,workspaceManifest:'/var/lib/mate/old-manifest.json'}}).success).toBe(false);
  expect(daemonConfigSchema.safeParse({...input,runtime:{...input.runtime,linuxUsers:{...input.runtime.linuxUsers,bob:{uid:1001,gid:1002,home:'/srv/mate/private/bob'}}}}).success).toBe(false);
  expect(daemonConfigSchema.safeParse({...input,runtime:{...input.runtime,linuxUsers:{...input.runtime.linuxUsers,bob:{uid:0,gid:1002,home:'/srv/mate/private/bob'}}}}).success).toBe(false);
  expect(daemonConfigSchema.safeParse({...input,runtime:{...input.runtime,systemAgents:['research']}}).success).toBe(true);
  expect(daemonConfigSchema.safeParse({...input,runtime:{...input.runtime,systemAgents:['unknown']}}).success).toBe(false);
});
it('controls are owner-only, durable replay applies once, and unknown admin sends never retry', async () => {
  const {store,c,ingress,broker}=setup(); const supervisor=new Supervisor(c,new ToolRouter(c,broker),c.config);supervisor.register();cleanups.unshift(()=>supervisor.close());
  const controls=new Controls(c,supervisor,broker); expect(()=>controls.execute('UONE','status')).toThrow('Owner');
  const work=c.createWork('human:root',fixtureTarget('CTEST','100.000001'));
  const transport=new WebSlackTransport(store,ingress.normalizer instanceof CanonicalSlackNormalizer?ingress.normalizer.mapper:(()=>{throw new Error();})(),{research:'synthetic',writer:'synthetic'}); const ephemeral=vi.fn(async()=>{throw new Error('connection lost')}); transport.clients.get('research')!.chat.postEphemeral=ephemeral as any;
  const slack=new SlackService(c,transport,ingress,controls);
  store.ingest('AONE','cmd',{command:'/team',team_id:'TTEST',user_id:'UOWNER',channel_id:'CTEST',text:`stop ${work}`});slack.replay();slack.replay();expect(c.work(work).state).toBe('paused');
  expect(store.db.prepare('SELECT count(*) n FROM admin_replies').get()).toEqual({n:1});await slack.flushAdmin();await slack.flushAdmin();expect(ephemeral).toHaveBeenCalledOnce();
});
it('lets only the owner list and stop an Agent Linux scope through controls',()=>{
  const {c,broker}=setup(),unit='mate-agent-1001-123e4567-e89b-42d3-a456-426614174000.scope';
  const list=vi.fn(()=>[{unit,pids:[4101]}]),stop=vi.fn(()=>({unit,stopped:true}));
  const controls=new Controls(c,{} as Supervisor,broker,undefined,undefined,{list,stop} as unknown as LinuxProcessManager);
  expect(()=>controls.execute('UONE','processes research')).toThrow('Owner only');
  expect(controls.execute('UOWNER','processes research')).toEqual([{unit,pids:[4101]}]);
  expect(controls.execute('UOWNER',`process-stop research ${unit}`)).toEqual({unit,stopped:true});
  expect(list).toHaveBeenCalledWith('research');expect(stop).toHaveBeenCalledWith('research',unit);
});
it('reports a repeated owner stop as no longer running after a crash before control receipt commit',()=>{
  const {c,broker}=setup(),unit='mate-agent-1001-123e4567-e89b-42d3-a456-426614174000.scope';
  const stop=vi.fn().mockReturnValueOnce({unit,stopped:true}).mockImplementationOnce(()=>{throw new ProcessNotRunningError('Agent scope is not running');});
  const controls=new Controls(c,{} as Supervisor,broker,undefined,undefined,{list:()=>[],stop} as unknown as LinuxProcessManager);
  expect(controls.execute('UOWNER',`process-stop research ${unit}`)).toEqual({unit,stopped:true});
  expect(controls.execute('UOWNER',`process-stop research ${unit}`)).toEqual({unit,stopped:false,reason:'not_running'});
});
it('routes a system request through a human Slack confirmation button before privileged dispatch',async()=>{
  const {store,c,ingress,broker}=setup(),execute=vi.fn(async()=>({code:0,stdout:'done',stderr:'',truncated:false}));
  store.register('research','v1',[]);c.messages.membership('research','CTEST',true);
  const work=c.createWork('system-approval',fixtureTarget('CTEST','100.000001'));c.enqueue('research',work,'start',{});const run=store.beginRun('research')!;store.input(run,{});
  const system=new SystemOperations(store,c,['research'],{execute},()=>1000),router=new ToolRouter(c,broker,{system,research:async()=>({}),publish:async()=>({})});
  const mapper=ingress.normalizer instanceof CanonicalSlackNormalizer?ingress.normalizer.mapper:(()=>{throw new Error();})();
  const transport=new WebSlackTransport(store,mapper,{research:'synthetic',writer:'synthetic'});
  const client=transport.clients.get('research')!,post=vi.fn(async(_request:unknown)=>({ok:true,ts:'200.000001'}));
  client.conversations.open=vi.fn().mockRejectedValueOnce(new Error('DM lookup unavailable')).mockResolvedValue({ok:true,channel:{id:'DOWNER'}}) as any;client.chat.postMessage=post as any;
  const slack=new SlackService(c,transport,ingress,{} as Controls,()=>false,system),input={program:'/usr/bin/apt-get',args:['install','example'],cwd:'/tmp'};
  const requested=(await router.call(run,work,'root-command','tools.call',{name:'system.request',input},new AbortController().signal)).value as {id:string;status:string};
  expect(requested.status).toBe('pending');await system.dispatchApproved();expect(execute).not.toHaveBeenCalled();
  await slack.flushApprovals();expect(post).not.toHaveBeenCalled();expect(system.pendingNotices()).toHaveLength(1);
  await slack.flushApprovals();expect(post).toHaveBeenCalledOnce();
  const blocks=(post.mock.calls[0]![0] as any).blocks;expect(JSON.stringify(blocks)).toContain('not frozen');expect(JSON.stringify(blocks)).toContain('confirm');
  store.ingest('AONE','clicked',{type:'block_actions',team:{id:'TTEST'},user:{id:'UOWNER'},actions:[{action_id:'mate_system_approve',value:requested.id}]});
  slack.replay();expect(store.db.prepare("SELECT kind,body FROM audit WHERE kind='ingress_rejected'").all()).toEqual([]);expect(system.status('research',requested.id).status).toBe('approved');await system.dispatchApproved();expect(execute).toHaveBeenCalledOnce();
  await slack.flushResults();expect(post).toHaveBeenCalledTimes(2);expect((post.mock.calls[1]![0] as {text:string}).text).toContain('succeeded');
  expect((await router.call(run,work,'root-status','system.status',{requestId:requested.id},new AbortController().signal)).value).toMatchObject({status:'succeeded',receipt:{stdout:'done'}});
  const controls=new Controls(c,{} as Supervisor,broker,undefined,undefined,undefined,system);
  expect(controls.execute('UOWNER',`system-status ${requested.id}`)).toMatchObject({status:'succeeded'});
  expect(()=>controls.execute('UOTHER',`system-status ${requested.id}`)).toThrow('Owner');
  store.ingest('AONE','clicked-again',{type:'block_actions',team:{id:'TTEST'},user:{id:'UOWNER'},actions:[{action_id:'mate_system_approve',value:requested.id}]});
  slack.replay();await system.dispatchApproved();expect(execute).toHaveBeenCalledOnce();
  const denied=(await router.call(run,work,'root-denied','system.request',input,new AbortController().signal)).value as {id:string};
  store.ingest('AONE','not-owner',{type:'block_actions',team:{id:'TTEST'},user:{id:'UOTHER'},actions:[{action_id:'mate_system_approve',value:denied.id}]});
  slack.replay();expect(system.status('research',denied.id).status).toBe('pending');
  store.ingest('AONE','rejected',{type:'block_actions',team:{id:'TTEST'},user:{id:'UOWNER'},actions:[{action_id:'mate_system_reject',value:denied.id}]});
  slack.replay();await system.dispatchApproved();expect(system.status('research',denied.id).status).toBe('rejected');expect(execute).toHaveBeenCalledOnce();
  const expired=(await router.call(run,work,'root-expired','system.request',input,new AbortController().signal)).value as {id:string};
  system.expire(601001);store.ingest('AONE','late-click',{type:'block_actions',team:{id:'TTEST'},user:{id:'UOWNER'},actions:[{action_id:'mate_system_approve',value:expired.id}]});
  slack.replay();await system.dispatchApproved();expect(system.status('research',expired.id).status).toBe('expired');expect(execute).toHaveBeenCalledOnce();
  const disconnected=(await router.call(run,work,'no-ui','system.request',input,new AbortController().signal)).value as {id:string};
  await system.dispatchApproved();expect(system.status('research',disconnected.id).status).toBe('pending');expect(execute).toHaveBeenCalledOnce();
});
it('keeps direct system-tool refusal, expiry and changed-request replay visible without running anything',async()=>{
  const {store,c,broker}=setup(),execute=vi.fn(async()=>({code:0,stdout:'unexpected',stderr:'',truncated:false}));
  store.register('research','v1',[]);c.messages.membership('research','CTEST',true);
  const work=c.createWork('system-refusal',fixtureTarget('CTEST','100.000001'));c.enqueue('research',work,'start',{});const run=store.beginRun('research')!;store.input(run,{});
  const system=new SystemOperations(store,c,['research'],{execute},()=>1000),router=new ToolRouter(c,broker,{system,research:async()=>({}),publish:async()=>({})}),signal=new AbortController().signal;
  const input={program:'/usr/bin/apt-get',args:['install','example'],cwd:'/tmp'};
  const first=(await router.call(run,work,'refused','system.request',input,signal)).value as {id:string};
  await expect(router.call(run,work,'refused','tools.call',{name:'system.request',input:{...input,args:['remove','example']}},signal)).rejects.toThrow('identity');
  system.decide('UOWNER',first.id,'reject');
  expect((await router.call(run,work,'refused-status','system.status',{requestId:first.id},signal)).value).toMatchObject({status:'rejected',receipt:{reason:'approval_rejected'}});
  const second=(await router.call(run,work,'timed-out','tools.call',{name:'system.request',input},signal)).value as {id:string};
  system.expire(601001);
  expect((await router.call(run,work,'expired-status','system.status',{requestId:second.id},signal)).value).toMatchObject({status:'expired',receipt:{reason:'approval_expired'}});
  store.db.prepare('INSERT INTO review_seats VALUES(?,?,?,?,1)').run('research','{}','brief','/tmp/clean');
  await expect(router.call(run,work,'review-system','system.request',input,signal)).rejects.toThrow(/review|isolates/);
  await system.dispatchApproved();expect(execute).not.toHaveBeenCalled();
});
it('rejects forged Slack approval envelopes and a request belonging to another Agent app',async()=>{
  const {store,c,ingress}=setup(),execute=vi.fn(async()=>({code:0,stdout:'unexpected',stderr:'',truncated:false}));
  store.register('research','v1',[]);store.register('writer','v1',[]);c.messages.membership('writer','CTEST',true);
  const work=c.createWork('cross-app-system',fixtureTarget('CTEST','100.000001'));c.enqueue('writer',work,'start',{});const run=store.beginRun('writer')!;store.input(run,{});
  const system=new SystemOperations(store,c,['writer'],{execute},()=>1000),request=system.request(run,work,'writer-system',{program:'/usr/bin/id',args:[],cwd:'/tmp'});
  const mapper=ingress.normalizer instanceof CanonicalSlackNormalizer?ingress.normalizer.mapper:(()=>{throw new Error();})();
  const transport=new WebSlackTransport(store,mapper,{research:'synthetic',writer:'synthetic'}),slack=new SlackService(c,transport,ingress,{} as Controls,()=>false,system);
  const socket={on:()=>{},start:async()=>{},disconnect:async()=>{}},receiver=new DurableReceiver(store,'AONE','TTEST',socket,()=>{},()=>slack.replay()),ack=vi.fn(async()=>{});
  const body={type:'block_actions',api_app_id:'AONE',team_id:'TTEST',user:{id:'UOWNER'},actions:[{action_id:'mate_system_approve',value:request.id}]};
  await expect(receiver.receive({envelope_id:'wrong-app',body:{...body,api_app_id:'ATWO'},ack})).rejects.toThrow('app identity');
  await expect(receiver.receive({envelope_id:'wrong-team',body:{...body,team_id:'TOTHER'},ack})).rejects.toThrow('workspace identity');
  expect(ack).not.toHaveBeenCalled();
  await receiver.receive({envelope_id:'cross-app',body,ack});expect(ack).toHaveBeenCalledOnce();
  await system.dispatchApproved();expect(system.status('writer',request.id).status).toBe('pending');expect(execute).not.toHaveBeenCalled();
});
it('lets the owner page through long system output within Slack control reply limits',async()=>{
  const {store,c,broker}=setup(),execute=vi.fn(async()=>({code:0,stdout:'\0'.repeat(60000),stderr:'🙂'.repeat(10000),truncated:false}));
  store.register('research','v1',[]);c.messages.membership('research','CTEST',true);
  const work=c.createWork('long-system-output',fixtureTarget('CTEST','100.000001'));c.enqueue('research',work,'start',{});const run=store.beginRun('research')!;store.input(run,{});
  const system=new SystemOperations(store,c,['research'],{execute},()=>1000),request=system.request(run,work,'long-result',{program:'/usr/bin/id',args:[],cwd:'/tmp'});
  system.decide('UOWNER',request.id,'approve');await system.dispatchApproved();
  const controls=new Controls(c,{} as Supervisor,broker,undefined,undefined,undefined,system);
  const status=controls.execute('UOWNER',`system-status ${request.id}`) as {receipt:{stdoutMore:boolean;stderrMore:boolean}};
  expect(status.receipt).toMatchObject({stdoutMore:true,stderrMore:true});expect(formatControlReply(status)).not.toContain('mate.control-overflow.v1');
  const first=controls.execute('UOWNER',`system-output ${request.id} stdout 0`) as {chunk:string;nextOffset:number};
  expect(first.chunk).toBe('\0'.repeat(2000));expect(first.nextOffset).toBe(2000);expect(formatControlReply(first)).not.toContain('mate.control-overflow.v1');
  const second=controls.execute('UOWNER',`system-output ${request.id} stderr 0`) as {chunk:string;nextOffset:number};
  expect(second.chunk).toBe('🙂'.repeat(1000));expect(formatControlReply(second)).not.toContain('mate.control-overflow.v1');
});
it('uncertain artifact publication cannot be repeated with a new ID', async () => {
  const {store,c,broker}=setup();new ToolRouter(c,broker);store.register('research','v1',[]);c.messages.membership('research','CTEST',true);const root=realpathSync(mkdtempSync(join(tmpdir(),'mate-artifact-')));cleanups.push(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'artifacts'));
  const target=fixtureTarget('CTEST','100.000001'), work=c.createWork('human:artifact',target);c.enqueue('research',work,'one',{});const run=store.beginRun('research')!;store.input(run,{});
  const upload=vi.fn(async(_request:any,_artifact:any,prepared:any,beforeShare:any)=>{prepared('FFILE');beforeShare();throw new Error('lost after send')});const artifacts=new Artifacts(c,broker,{configured:()=>true,supports:()=>true,upload},{research:root});const signal=new AbortController().signal;
  const draft=await artifacts.publish(run,work,'first',{path:'artifacts/result.txt',target,title:'result'},signal) as any;expect(draft.status).toBe('held');expect(upload).not.toHaveBeenCalled();
  c.output.gate!.continueOnce(run,draft.draftId,draft.revision,draft.holdId);await c.output.send(draft.draftId);expect(store.output(draft.draftId)?.state).toBe('unknown');
  await expect(artifacts.publish(run,work,'second',{path:'artifacts/result.txt',target,title:'result'},signal)).rejects.toThrow('unknown');expect(upload).toHaveBeenCalledOnce();
});
it('paused or delayed output cannot starve later active work', async () => {
  const {store,c,post}=setup();store.register('research','v1',[]);c.messages.membership('research','CTEST',true);const target=fixtureTarget('CTEST','100.000001');
  const paused=c.createWork('human:paused',target), active=c.createWork('human:active',target);
  for(let n=0;n<25;n++) c.send('research',paused,target,`paused-${n}`);
  c.control('UOWNER',paused,'pause');
  const delayed=c.send('research',active,target,'retry later');store.db.prepare('UPDATE outbox SET receipt=? WHERE id=?').run(JSON.stringify({retryAt:Date.now()+100000}),delayed);
  const ready=c.send('research',active,target,'send now');expect(c.output.ready()).toEqual([{id:ready}]);await c.output.send(ready);expect(post).toHaveBeenCalledOnce();
});
it('stop during startup retains the singleton lock until startup settles and never opens sockets afterward', async () => {
  const {Daemon}=await import('../../src/daemon/app.js');const {deferred}=await import('../helpers/pi.js');const root=mkdtempSync(join(tmpdir(),'mate-start-stop-')), gate=deferred();
  const config=daemonFixture(root,{...configFixture,agents:[{...configFixture.agents[0],model:{provider:'anthropic',id:'claude-haiku-4-5',apiKeyEnv:'MODEL_API_KEY'}}]},{researchHosts:[]});
  const refs=['RESEARCH_BOT_TOKEN','RESEARCH_APP_TOKEN','MODEL_API_KEY'], saved=Object.fromEntries(refs.map(ref=>[ref,process.env[ref]]));for(const ref of refs)process.env[ref]='synthetic';
  const log={info:()=>{},error:()=>{}};const daemon=await Daemon.create(config,log);const verify=vi.spyOn(daemon.slack,'verify').mockImplementation(()=>gate.promise);const membership=vi.spyOn(daemon.slack,'membership');
  try {
    const starting=daemon.start();await vi.waitFor(()=>expect(verify).toHaveBeenCalledOnce());const closing=daemon.close();expect(()=>acquireLock(join(root,'state','daemon.lock'))).toThrow('Another Mate');
    gate.resolve();await expect(starting).rejects.toThrow('Daemon stopped during startup');await closing;expect(membership).not.toHaveBeenCalled();const release=acquireLock(join(root,'state','daemon.lock'));release();
  } finally {await daemon.close();for(const ref of refs){if(saved[ref]===undefined)delete process.env[ref];else process.env[ref]=saved[ref];}rmSync(root,{recursive:true,force:true});}
});
it('offline replies in watched threads are durably ingested and maintain a separate pagination checkpoint', async () => {
  const {store,c,ingress,broker}=setup();const supervisor=new Supervisor(c,new ToolRouter(c,broker),c.config);supervisor.register();cleanups.unshift(()=>supervisor.close());c.messages.membership('research','CTEST',true);c.messages.watch('research',fixtureTarget('CTEST','100.000001'),true);
  const transport=new WebSlackTransport(store,ingress.normalizer instanceof CanonicalSlackNormalizer?ingress.normalizer.mapper:(()=>{throw new Error();})(),{research:'synthetic',writer:'synthetic'});transport.clients.get('research')!.conversations.history=vi.fn(async()=>({ok:true,messages:[]})) as any;
  const replies=vi.fn(async()=>({ok:true,messages:[{ts:'101.000001',thread_ts:'100.000001',user:'UOWNER',text:'offline reply'}]}));transport.clients.get('research')!.conversations.replies=replies as any;
  const slack=new SlackService(c,transport,ingress,new Controls(c,supervisor,broker));await slack.catchUp();slack.replay();
  expect(c.messages.read('research',fixtureTarget('CTEST','100.000001')).map(m=>m.text)).toContain('offline reply');expect(replies).toHaveBeenCalledOnce();expect(store.db.prepare("SELECT ts FROM slack_cursors WHERE channel='CTEST:100.000001'").get()).toEqual({ts:'101.000001'});
});
it('Socket SDK pending URL startup cancels promptly and a late HTTP response cannot create a websocket', async () => {
  const {ManagedSocket}=await import('../../src/slack/socket.js');const {deferred}=await import('../helpers/pi.js');const gate=deferred();let fetching=false;
  const socket=new ManagedSocket('synthetic',async()=>{fetching=true;await gate.promise;return new Response(JSON.stringify({ok:true,url:'wss://invalid.example'}),{status:200,headers:{'content-type':'application/json'}});});
  const starting=socket.start();const rejected=expect(starting).rejects.toThrow('cancelled');await vi.waitFor(()=>expect(fetching).toBe(true));await socket.disconnect();await rejected;
  gate.resolve();await new Promise(resolve=>setTimeout(resolve,20));expect(socket.client.websocket).toBeUndefined();
});

it('artifact publication snapshots survive content edits and explicit revision replaces the frozen bytes',async()=>{
 const{store,c,broker,backend}=setup();new ToolRouter(c,broker);store.register('research','v1',[]);c.messages.membership('research','CTEST',true);
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mate-artifact-revise-')));cleanups.push(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'artifacts'));
 const target={conversationId:'CTEST'},work=c.createWork('artifact',target);c.enqueue('research',work,'one',{});const run=store.beginRun('research')!;store.input(run,{});
 const uploads:any[]=[];const artifacts=new Artifacts(c,broker,{configured:()=>true,supports:()=>true,upload:async({text},artifact,prepared,beforeShare)=>{prepared('FFILE');if(!beforeShare())throw new Error('deferred');uploads.push({text,artifact});return{fileId:'FFILE'};}},{research:root});const args={path:'artifacts/result.txt',target,title:'result'},signal=new AbortController().signal;
 const draft=await artifacts.publish(run,work,'first',args,signal) as any;backend.execute.mockResolvedValue({code:0,stdout:'new file content',stderr:'',truncated:false});
 expect((await artifacts.publish(run,work,'first',args,signal) as any).artifact.bytes).toBe(Buffer.byteLength('artifact evidence'));expect(JSON.parse(store.output('first')!.request).artifact.content).toBe('artifact evidence');
 const revised=await artifacts.publish(run,work,'revision',{...args,draftId:draft.draftId,revision:1},signal) as any;expect(revised.artifact.bytes).toBe(Buffer.byteLength('new file content'));
 c.output.gate!.continueOnce(run,draft.draftId,2,revised.holdId);await c.output.send('first:revision:2');expect(uploads[0].artifact.content).toBe('new file content');expect(store.output('first:revision:2')?.state).toBe('sent');
});
it('Slack file allocation is persisted before transfer; only proven file shares reconcile unknown publication',async()=>{
 const{store,c,broker,ingress}=setup();new ToolRouter(c,broker);store.register('research','v1',[]);c.messages.membership('research','CTEST',true);
 const transport=new WebSlackTransport(store,ingress.normalizer instanceof CanonicalSlackNormalizer?ingress.normalizer.mapper:(()=>{throw new Error();})(),{research:'synthetic'}),service=new SlackService(c,transport,ingress,new Controls(c,{} as any,broker));const client=transport.clients.get('research')!;
 client.files.getUploadURLExternal=vi.fn(async()=>({ok:true,file_id:'FFILE',upload_url:'https://files.slack.com/upload/v1/synthetic'})) as any;
 client.files.completeUploadExternal=vi.fn(async()=>{throw new Error('lost receipt after share');}) as any;
 const fetchMock=vi.fn(async()=>({ok:true,body:{cancel:async()=>{}}}));vi.stubGlobal('fetch',fetchMock);
 const target=fixtureTarget('CTEST','100.000001'),work=c.createWork('upload',target);c.enqueue('research',work,'one',{});const run=store.beginRun('research')!;store.input(run,{});c.output.artifacts=service;c.output.queueArtifact('research',target,'caption',{title:'file',content:'frozen',contentHash:'hash'},'upload',{run});store.db.prepare('INSERT INTO output_work VALUES(?,?)').run('upload',work);const draft=c.output.gate!.describe('research','upload') as any;
 try{c.output.gate!.continueOnce(run,'upload',1,draft.holdId);await c.output.send('upload');expect(JSON.parse(store.output('upload')!.receipt!).fileId).toBe('FFILE');expect(fetchMock).toHaveBeenCalledOnce();
  client.files.info=vi.fn(async()=>({ok:true,file:{id:'FFILE',user:'UONE',shares:{private:{CTEST:[{ts:'200.000001',thread_ts:'100.000001'}]}}}})) as any;
  await service.reconcile();expect(store.output('upload')?.state).toBe('sent');expect(client.files.completeUploadExternal).toHaveBeenCalledOnce();
 }finally{vi.unstubAllGlobals();}
});
it('peer publication attention includes captions and respects page ACK, mute and revoked channel access',async()=>{
 const{store,c,broker,ingress}=setup();new ToolRouter(c,broker);for(const actor of ['research','writer']){store.register(actor,'v1',[]);c.messages.membership(actor,'CTEST',true);}
 const target=fixtureTarget('CTEST','100.000001'),work=c.createWork('peer-artifact',target);for(const actor of ['research','writer'])c.enqueue(actor,work,actor,{});
 const run=store.beginRun('research')!,peer=store.beginRun('writer')!;store.input(run,{});store.input(peer,{});
 c.output.artifacts={configured:()=>true,supports:()=>true,upload:async(_request,_artifact,prepared,beforeShare)=>{prepared('FFILE');if(!beforeShare())throw new Error('deferred');return{fileId:'FFILE'};}};
 c.output.queueArtifact('research',target,'peer caption',{title:'result',content:'frozen',contentHash:'hash'},'artifact',{run});const draft=c.output.gate!.describe('research','artifact') as any;c.output.gate!.continueOnce(run,'artifact',1,draft.holdId);await c.output.send('artifact');
 expect(c.attention.peek('writer')).toEqual([{target,revision:expect.any(Number),unseen:1}]);let page=c.attention.read(peer,target) as any;
 const present=(value:any)=>c.attention.presented(peer,{role:'toolResult',toolCallId:'p',toolName:'mate',content:[{type:'text',text:JSON.stringify(value)}],isError:false,timestamp:0});
 present(page);expect(c.attention.valid(peer,target,page.viewToken)).toBe(false);page=c.attention.read(peer,target,page.nextCursor) as any;expect(page.publications[0].caption).toBe('peer caption');present(page);expect(c.attention.valid(peer,target,page.viewToken)).toBe(true);
 c.attention.state('writer',target,'mute',1);expect(c.attention.peek('writer')).toEqual([]);c.messages.membership('writer','CTEST',false);expect(()=>c.attention.read(peer,target)).toThrow('access');
});
it('Slack artifact echoes replace publication projection without double unread after exact presentation',async()=>{
 const{store,c,broker,ingress}=setup();new ToolRouter(c,broker);for(const actor of ['research','writer']){store.register(actor,'v1',[]);c.messages.membership(actor,'CTEST',true);}const target=fixtureTarget('CTEST','100.000001'),work=c.createWork('echo-artifact',target);for(const actor of ['research','writer'])c.enqueue(actor,work,actor,{});
 const run=store.beginRun('research')!,peer=store.beginRun('writer')!;store.input(run,{});store.input(peer,{});c.output.artifacts={configured:()=>true,supports:()=>true,upload:async(_request,_artifact,prepared,beforeShare)=>{prepared('FFILE');if(!beforeShare())throw new Error('deferred');return{fileId:'FFILE'};}};
 c.output.queueArtifact('research',target,'Done 🎉 https://example.com',{title:'result',content:'f',contentHash:'hash'},'artifact',{run});const draft=c.output.gate!.describe('research','artifact')as any;c.output.gate!.continueOnce(run,'artifact',1,draft.holdId);await c.output.send('artifact');
 let page=c.attention.read(peer,target)as any;while(true){c.attention.presented(peer,{role:'toolResult',toolCallId:'p',toolName:'mate',content:[{type:'text',text:JSON.stringify(page)}],isError:false,timestamp:0});if(!page.nextCursor)break;page=c.attention.read(peer,target,page.nextCursor);}
 store.ingest('ATWO','echo-file',{team_id:'TTEST',event:{type:'message',channel:'CTEST',ts:'201.000001',thread_ts:externalThread(target),text:'Done :tada: <https://example.com>',user:'UONE',files:[{id:'FFILE',title:'result'}]}});ingress.normalizer.normalize('ATWO','echo-file');
 expect(c.attention.peek('writer')).toEqual([{target,revision:expect.any(Number),unseen:0}]);const after=c.attention.read(peer,target)as any;expect(after.publications).toEqual([]);expect(after.messages[0].attachments[0].id).toBe('FFILE');
});
it.each(['defer','discard','continue','revise','retry'] as const)('the same changed discussion permits the Agent choice %s through the Pi loop without a task tree',async choice=>{
 const{store,c,broker,post,mapper}=setup(),router=new ToolRouter(c,broker),target=fixtureTarget('CTEST','100.000001');let view='',draft:any,step=0,now=200;
 const change=()=>c.messages.record(mapper.message({channel:'CTEST',thread:externalThread(target),ts:`${now++}.000001`,revision:`${now}.000001`,user:'UTWO',text:'new peer evidence',deleted:false}),['research']);
 const supervisor=new Supervisor(c,router,c.config,()=>({close:()=>{},run:async(spec,hooks)=>{
  const engine=new Engine({...model,contextWindow:200000},()=>{
   let operation:string|undefined,args:any={};step++;
   if(step===1){operation='attention.read';args={target};}
   else if(step===2){change();operation='messages.send';args={target,text:'original conclusion',viewToken:view};}
   else if(step===3){
    if(choice==='defer'){operation='attention.defer';args={target,until:Date.now()+100000};}
    if(choice==='discard'){operation='drafts.discard';args={draftId:draft.draftId,revision:draft.revision};}
    if(choice==='continue'){operation='drafts.continue';args={draftId:draft.draftId,revision:draft.revision,holdId:draft.holdId,acknowledge:'send_despite_unread_or_changes'};}
    if(choice==='revise'){operation='drafts.revise';args={draftId:draft.draftId,revision:draft.revision,text:'revised conclusion'};}
    if(choice==='retry'){operation='attention.read';args={target};}
   }else if(step===4&&choice==='retry'){operation='drafts.retry';args={draftId:draft.draftId,revision:draft.revision,viewToken:view};}
   else if(step===4&&choice==='revise'){operation='drafts.continue';args={draftId:draft.draftId,revision:draft.revision,holdId:draft.holdId,acknowledge:'send_despite_unread_or_changes'};}
   const message=operation?answer([{type:'toolCall',id:`${choice}:${step}`,name:'mate',arguments:{operation,args}}],'toolUse'):answer([{type:'text',text:'private turn completed'}]);
   const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:message.stopReason as 'stop'|'toolUse',message});return stream;
  });
  return engine.run(spec,{...hooks,tool:async(id,op,args)=>{const reply=await hooks.tool(id,op,args);if(op==='attention.read')view=(reply.value as any).viewToken;if(op==='messages.send'||op==='drafts.revise')draft=reply.value;return reply;}});
 }}));cleanups.unshift(()=>supervisor.close());supervisor.register();for(const a of c.config.agents)c.messages.membership(a.id,'CTEST',true);
 const work=c.createWork('choices',target);change();c.enqueue('research',work,'choose',{target});await supervisor.step('research');
 expect(store.db.prepare("SELECT count(*) n FROM runs WHERE state='failed'").get()).toEqual({n:0});expect(c.list('research')).toHaveLength(0);
 for(const row of c.output.ready())await c.output.send(row.id);
 if(choice==='defer'||choice==='discard')expect(post).not.toHaveBeenCalled();else expect(post).toHaveBeenCalledOnce();
 if(choice==='defer'){expect(c.output.gate!.list('research')).toHaveLength(1);expect(c.attention.peek('research')).toEqual([]);}
 if(choice==='revise')expect(JSON.stringify(post.mock.calls)).toContain('revised conclusion');
 const seen=store.db.prepare("SELECT revision FROM attention_seen WHERE agent_id='research' AND key=?").get(mapper.messageId('CTEST','201.000001'));
 if(choice==='continue')expect(seen).toBeUndefined();
 if(choice==='retry')expect(seen).toEqual({revision:'202000001'});
});
it('unknown output and unnormalized ingress do not starve unrelated targets before the ready batch limit',async()=>{
 const{store,c,broker,post}=setup();new ToolRouter(c,broker);store.register('research','v1',[]);c.messages.references.createConversation('channel','external','CTHREE');c.messages.references.bindConversation({provider:'slack',workspace:'TTEST',externalId:'CTHREE'},'CTHREE','primary');for(const channel of ['CTEST','CTWO','CTHREE'])c.messages.membership('research',channel,true);
 const work=c.createWork('fairness',{conversationId:'CTEST'});c.enqueue('research',work,'run',{});const run=store.beginRun('research')!;store.input(run,{});
 const enqueue=(channel:string,id:string)=>{const output=c.send('research',work,{conversationId:channel},id,id,{run});const draft=c.output.gate!.describe('research',output) as any;c.output.gate!.continueOnce(run,output,draft.revision,draft.holdId);return output;};
 const unknown=enqueue('CTEST','unknown');store.transitionOutput(unknown,'pending','sending');store.transitionOutput(unknown,'sending','unknown');
 for(let i=0;i<25;i++)enqueue('CTEST','blocked-'+i);
 store.ingest('AONE','pending-ingress',{team_id:'TTEST',event:{channel:'CTWO',type:'message',ts:'100.000001',user:'UOWNER',text:'normalize first'}});
 for(let i=0;i<25;i++)enqueue('CTWO','ingress-blocked-'+i);
 const unrelated=enqueue('CTHREE','unrelated');expect(c.output.ready()).toEqual([{id:unrelated}]);await c.output.send(unrelated);expect(post).toHaveBeenCalledOnce();expect(store.output(unknown)?.state).toBe('unknown');
});
