import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/storage/store.js';
import { configSchema } from '../../src/config.js';
import { configFixture } from '../helpers/config.js';
import { Messages, Output } from '../../src/slack/messages.js';
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
import { SlackService } from '../../src/daemon/slack.js';
import { WebSlackTransport } from '../../src/slack/transport.js';
import { Artifacts } from '../../src/daemon/artifacts.js';
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(fn => fn()));
function setup() {
  const config = configSchema.parse({ ...configFixture, budgets: { ...configFixture.budgets, maxTokens: 300000 }, agents: [configFixture.agents[0], { ...configFixture.agents[0], id: 'writer', name: 'Writer', slackAppId: 'ATWO', slackUserId: 'UTWO', slackBotId: 'BTWO', botTokenEnv: 'WRITER_BOT', appTokenEnv: 'WRITER_APP' }] });
  const store = new Store(':memory:'), messages = new Messages(store, config), post = vi.fn(async () => ({ ts: `101.${String(post.mock.calls.length).padStart(6,'0')}` }));
  const c = new Collaboration(store, messages, new Output(messages, { post }), config), ingress = new Ingress(c);
  const backend = { execute: vi.fn(async () => ({ code: 0, stdout: 'artifact evidence', stderr: '', truncated: false })) };
  const broker = new Broker(store, c, backend, ['/synthetic/protected']);
  cleanups.push(() => store.close()); return { store, c, ingress, broker, post, backend };
}
it('two Agents can coordinate through one canonical message and direct peer feedback without a task tree',async()=>{
 const{store,c,ingress,broker,post}=setup(),router=new ToolRouter(c,broker),target={channel:'CTEST',thread:'100.000001'};
 let task:any,view='',phase='claim',step=0;
 const supervisor=new Supervisor(c,router,c.config,agent=>({close:()=>{},run:async(spec,hooks)=>{
  step=0;const engine=new Engine({...model,contextWindow:200000},()=>{
   let operation:string|undefined,args:any={};
   if(step++===0){operation='attention.read';args={target};}
   else if(step===2){
    if(phase==='claim'){operation='tasks.claim';args={message:{channel:target.channel,ts:target.thread},expectedVersion:0,viewToken:view};}
    else if(phase==='feedback'){operation='messages.send';args={target,text:'<@UONE> Independent evidence: 2+2=4.',viewToken:view};}
    else{operation='tasks.update';args={taskId:task.id,expectedVersion:task.version,status:'done',result:'Verified 2+2=4',viewToken:view};}
   }
   const message=operation?answer([{type:'toolCall',id:`${phase}:${agent.id}:${step}`,name:'mate',arguments:{operation,args}}],'toolUse'):answer([{type:'text',text:'yield'}]);
   const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:message.stopReason as 'stop'|'toolUse',message});return stream;
  });return engine.run(spec,{...hooks,tool:async(id,op,args)=>{const result=await hooks.tool(id,op,args);if(op==='attention.read')view=(result.value as any).viewToken;if(op==='tasks.claim')task=(result.value as any).result;return result;}});
 }}));cleanups.unshift(()=>supervisor.close());supervisor.register();for(const agent of c.config.agents)c.messages.membership(agent.id,'CTEST',true);
 store.ingest('AONE','root',{team_id:'TTEST',event:{type:'message',channel:'CTEST',ts:target.thread,user:'UOWNER',text:'<@UONE> Verify 2+2'}});ingress.replay('AONE','root');await supervisor.step('research');expect(task.owner).toBe('research');
 for(const row of c.output.ready())await c.output.send(row.id);
 phase='feedback';c.enqueue('writer',task.work_id,'peer-check',{target});await supervisor.step('writer');for(const row of c.output.ready())await c.output.send(row.id);
 phase='finish';await supervisor.step('research');expect(c.task(task.id).status).toBe('done');for(const row of c.output.ready())await c.output.send(row.id);
 expect(c.list('research')).toHaveLength(1);expect(c.task(task.id).message_key).toBe(JSON.stringify(['TTEST','CTEST',target.thread]));expect(JSON.stringify(post.mock.calls)).toContain('Independent evidence');expect(store.db.prepare("SELECT count(*) n FROM runs WHERE state='failed'").get()).toEqual({n:0});
});
it('peer messages can wake an Agent using its existing finite account without a human budget root', async () => {
  const {store,c,ingress}=setup(); for(const agent of c.config.agents){store.register(agent.id,'v1',[]);c.messages.membership(agent.id,'CTEST',true);}
  const before=c.ledger.account('writer');
  store.ingest('ATWO','peer',{team_id:'TTEST',event:{type:'message',channel:'CTEST',ts:'100.000001',user:'UONE',bot_id:'BONE',text:'<@UTWO> help'}}); ingress.replay('ATWO','peer');
  const run=store.beginRun('writer',Date.now(),true)!; expect(run).toBeDefined();
  const binding=store.db.prepare('SELECT work_id FROM delivery_work WHERE delivery_id=?').get(run.deliveryId) as {work_id:string};
  c.reserve(run,binding.work_id,20,0.1);expect(c.ledger.account('writer')).toMatchObject({max_tokens:before.max_tokens,tokens:20,runs:1});
});
it('kernel lock excludes a second daemon; backup restores SQLite plus private memory', async () => {
  const root=mkdtempSync(join(tmpdir(),'mate-checkpoint-')), data=join(root,'data'); mkdirSync(join(data,'agents','research'),{recursive:true}); writeFileSync(join(data,'agents','research','MEMORY.md'),'synthetic lesson');
  const release=acquireLock(join(root,'lock')); expect(()=>acquireLock(join(root,'lock'))).toThrow('Another Mate'); release(); const again=acquireLock(join(root,'lock')); again();
  const store=new Store(join(data,'mate.sqlite')); store.register('research','v1',[{role:'user',content:'persisted'}]);
  try { await backup(store,data,join(root,'checkpoint')); const restored=new Store(join(root,'checkpoint','mate.sqlite')); expect(restored.db.prepare('SELECT count(*) n FROM entries').get()).toEqual({n:1}); restored.close(); expect(readFileSync(join(root,'checkpoint','agents','research','MEMORY.md'),'utf8')).toBe('synthetic lesson'); }
  finally {store.close();rmSync(root,{recursive:true,force:true});}
});
it('public research rejects local/metadata destinations before HTTP', async () => {
  for(const ip of ['127.0.0.1','169.254.169.254','10.0.0.1','100.64.0.1','172.16.0.1','192.168.1.1','::1']) expect(publicIPv4(ip)).toBe(false);
  expect(publicIPv4('93.184.216.34')).toBe(true);
  await expect(new Research(['example.com']).read('https://127.0.0.1',new AbortController().signal)).rejects.toThrow('outside');
  await expect(new Research(['example.com']).read('https://secret@example.com',new AbortController().signal)).rejects.toThrow('outside');
});
it('controls are owner-only, durable replay applies once, and unknown admin sends never retry', async () => {
  const {store,c,ingress,broker}=setup(); const supervisor=new Supervisor(c,new ToolRouter(c,broker),c.config);supervisor.register();cleanups.unshift(()=>supervisor.close());
  const controls=new Controls(c,supervisor,broker); expect(()=>controls.execute('UONE','status')).toThrow('Owner');
  const work=c.createWork('human:root',{channel:'CTEST',thread:'100.000001'});
  const transport=new WebSlackTransport({research:'synthetic',writer:'synthetic'}); const ephemeral=vi.fn(async()=>{throw new Error('connection lost')}); transport.clients.get('research')!.chat.postEphemeral=ephemeral as any;
  const slack=new SlackService(c,transport,ingress,controls);
  store.ingest('AONE','cmd',{command:'/team',team_id:'TTEST',user_id:'UOWNER',channel_id:'CTEST',text:`stop ${work}`});slack.replay();slack.replay();expect(c.work(work).state).toBe('paused');
  expect(store.db.prepare('SELECT count(*) n FROM admin_replies').get()).toEqual({n:1});await slack.flushAdmin();await slack.flushAdmin();expect(ephemeral).toHaveBeenCalledOnce();
});
it('artifact upload is scoped to own artifact directory and uncertain publication cannot be repeated with a new ID', async () => {
  const {store,c,broker}=setup();store.register('research','v1',[]);c.messages.membership('research','CTEST',true);const root=realpathSync(mkdtempSync(join(tmpdir(),'mate-artifact-')));cleanups.push(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'artifacts'));
  const target={channel:'CTEST',thread:'100.000001'}, work=c.createWork('human:artifact',target);c.enqueue('research',work,'one',{});const run=store.beginRun('research')!;store.input(run,{});const grant=broker.issueGrant('UOWNER','research',work,root,['read'],Date.now()+100000);
  const upload=vi.fn(async()=>{throw new Error('lost after send')});const artifacts=new Artifacts(c,broker,{upload},{research:root});const signal=new AbortController().signal;
  await expect(artifacts.publish(run,work,'private',{grantId:grant,path:'MEMORY.md',target,title:'bad'},signal)).rejects.toThrow('Only own');
  await expect(artifacts.publish(run,work,'traversal',{grantId:grant,path:'artifacts/../MEMORY.md',target,title:'bad'},signal)).rejects.toThrow('Only own');
  await expect(artifacts.publish(run,work,'first',{grantId:grant,path:'artifacts/result.txt',target,title:'result'},signal)).rejects.toThrow('lost');
  await expect(artifacts.publish(run,work,'second',{grantId:grant,path:'artifacts/result.txt',target,title:'result'},signal)).rejects.toThrow('unknown');expect(upload).toHaveBeenCalledOnce();
});
it('paused or delayed output cannot starve later active work', async () => {
  const {store,c,post}=setup();store.register('research','v1',[]);c.messages.membership('research','CTEST',true);const target={channel:'CTEST',thread:'100.000001'};
  const paused=c.createWork('human:paused',target), active=c.createWork('human:active',target);
  for(let n=0;n<25;n++) c.send('research',paused,target,`paused-${n}`);
  c.control('UOWNER',paused,'pause');
  const delayed=c.send('research',active,target,'retry later');store.db.prepare('UPDATE outbox SET receipt=? WHERE id=?').run(JSON.stringify({retryAt:Date.now()+100000}),delayed);
  const ready=c.send('research',active,target,'send now');expect(c.output.ready()).toEqual([{id:ready}]);await c.output.send(ready);expect(post).toHaveBeenCalledOnce();
});
it('stop during startup retains the singleton lock until startup settles and never opens sockets afterward', async () => {
  const {Daemon}=await import('../../src/daemon/app.js');const {deferred}=await import('../helpers/pi.js');const root=mkdtempSync(join(tmpdir(),'mate-start-stop-')), gate=deferred();
  const config={mate:configSchema.parse({...configFixture,agents:[{...configFixture.agents[0],model:{provider:'anthropic',id:'claude-haiku-4-5',apiKeyEnv:'MODEL_API_KEY'}}]}),runtime:{dataDir:root,workspaceGrants:[],researchHosts:[]}};
  const refs=['RESEARCH_BOT_TOKEN','RESEARCH_APP_TOKEN','MODEL_API_KEY'], saved=Object.fromEntries(refs.map(ref=>[ref,process.env[ref]]));for(const ref of refs)process.env[ref]='synthetic';
  const log={info:()=>{},error:()=>{}};const daemon=new Daemon(config,log);const verify=vi.spyOn(daemon.slack,'verify').mockImplementation(()=>gate.promise);const membership=vi.spyOn(daemon.slack,'membership');
  try {
    const starting=daemon.start();await vi.waitFor(()=>expect(verify).toHaveBeenCalledOnce());const closing=daemon.close();expect(()=>acquireLock(join(root,'state','daemon.lock'))).toThrow('Another Mate');
    gate.resolve();await starting;await closing;expect(membership).not.toHaveBeenCalled();const release=acquireLock(join(root,'state','daemon.lock'));release();
  } finally {await daemon.close();for(const ref of refs){if(saved[ref]===undefined)delete process.env[ref];else process.env[ref]=saved[ref];}rmSync(root,{recursive:true,force:true});}
});
it('offline replies in watched threads are durably ingested and maintain a separate pagination checkpoint', async () => {
  const {store,c,ingress,broker}=setup();const supervisor=new Supervisor(c,new ToolRouter(c,broker),c.config);supervisor.register();cleanups.unshift(()=>supervisor.close());c.messages.membership('research','CTEST',true);c.messages.watch('research',{channel:'CTEST',thread:'100.000001'},true);
  const transport=new WebSlackTransport({research:'synthetic',writer:'synthetic'});transport.clients.get('research')!.conversations.history=vi.fn(async()=>({ok:true,messages:[]})) as any;
  const replies=vi.fn(async()=>({ok:true,messages:[{ts:'101.000001',thread_ts:'100.000001',user:'UOWNER',text:'offline reply'}]}));transport.clients.get('research')!.conversations.replies=replies as any;
  const slack=new SlackService(c,transport,ingress,new Controls(c,supervisor,broker));await slack.catchUp();slack.replay();
  expect(c.messages.read('research',{channel:'CTEST',thread:'100.000001'}).map(m=>m.text)).toContain('offline reply');expect(replies).toHaveBeenCalledOnce();expect(store.db.prepare("SELECT ts FROM slack_cursors WHERE channel='CTEST:100.000001'").get()).toEqual({ts:'101.000001'});
});
it('execution cleanup scope is identical through canonical and aliased parent directories', async () => {
  const {symlinkSync}=await import('node:fs');const {executionScope}=await import('../../src/daemon/paths.js');const root=mkdtempSync(join(tmpdir(),'mate-scope-'));mkdirSync(join(root,'real','data'),{recursive:true});symlinkSync(join(root,'real'),join(root,'alias'));
  try {expect(executionScope(join(root,'alias','data'))).toBe(executionScope(join(root,'real','data')));}finally{rmSync(root,{recursive:true,force:true});}
});
it('Socket SDK pending URL startup cancels promptly and a late HTTP response cannot create a websocket', async () => {
  const {ManagedSocket}=await import('../../src/slack/socket.js');const {deferred}=await import('../helpers/pi.js');const gate=deferred();let fetching=false;
  const socket=new ManagedSocket('synthetic',async()=>{fetching=true;await gate.promise;return new Response(JSON.stringify({ok:true,url:'wss://invalid.example'}),{status:200,headers:{'content-type':'application/json'}});});
  const starting=socket.start();const rejected=expect(starting).rejects.toThrow('cancelled');await vi.waitFor(()=>expect(fetching).toBe(true));await socket.disconnect();await rejected;
  gate.resolve();await new Promise(resolve=>setTimeout(resolve,20));expect(socket.client.websocket).toBeUndefined();
});

it('configured project grants cannot overlap the private Agent memory tree', async () => {
  const {Daemon}=await import('../../src/daemon/app.js');const root=mkdtempSync(join(tmpdir(),'mate-private-grants-'));mkdirSync(join(root,'agents'),{recursive:true});
  const old=process.env.RESEARCH_BOT_TOKEN;process.env.RESEARCH_BOT_TOKEN='synthetic';
  try {expect(()=>new Daemon({mate:configSchema.parse(configFixture),runtime:{dataDir:root,researchHosts:[],workspaceGrants:[{agentId:'research',root:join(root,'agents'),operations:['read']}]}},{info:()=>{},error:()=>{}})).toThrow('Protected root overlap');}
  finally{if(old===undefined)delete process.env.RESEARCH_BOT_TOKEN;else process.env.RESEARCH_BOT_TOKEN=old;rmSync(root,{recursive:true,force:true});}
});
it('private exec grant upgrades preserve revocation and expiry and require configured Docker',async()=>{
 const{Daemon}=await import('../../src/daemon/app.js');const saved=process.env.RESEARCH_BOT_TOKEN;process.env.RESEARCH_BOT_TOKEN='synthetic';
 try{for(const docker of [undefined,{binary:'/usr/local/bin/docker',host:'unix:///synthetic.sock',image:`sha256:${'0'.repeat(64)}`}]){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'mate-grants-')));const daemon=new Daemon({mate:configSchema.parse(configFixture),runtime:{dataDir:root,researchHosts:[],workspaceGrants:[],...(docker?{docker}:{})}},{info:()=>{},error:()=>{}});
  if(docker)vi.spyOn((daemon as any).container,'recover').mockResolvedValue(undefined);
  try{for(const state of ['valid','revoked','expired']){
   const work=daemon.collaboration.createWork(state,{channel:'CTEST'}),grant=daemon.broker.issueGrant('UOWNER','research',work,daemon.memoryRoots.research!,['read','write'],Date.now()+100000);
   if(state==='revoked')daemon.broker.revoke('UOWNER',grant);if(state==='expired')daemon.store.db.prepare('UPDATE grants SET expires=1 WHERE id=?').run(grant);
   (daemon as any).ensureGrants('research',work);
   const row=daemon.store.db.prepare('SELECT operations,revoked,expires FROM grants WHERE id=?').get(grant) as any;
   expect(JSON.parse(row.operations).includes('exec')).toBe(!!docker&&state==='valid');if(state==='revoked')expect(row.revoked).toBe(1);if(state==='expired')expect(row.expires).toBe(1);
  }
  expect(daemon.store.db.prepare("SELECT count(*) n FROM audit WHERE kind='private_workspace_exec_upgrade'").get()).toEqual({n:docker?1:0});
  }finally{await daemon.close();rmSync(root,{recursive:true,force:true});}
 }}finally{if(saved===undefined)delete process.env.RESEARCH_BOT_TOKEN;else process.env.RESEARCH_BOT_TOKEN=saved;}
});
