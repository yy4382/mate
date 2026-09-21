import{afterEach,expect,it}from 'vitest';
import{mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,existsSync}from 'node:fs';
import{tmpdir}from 'node:os';
import{join}from 'node:path';
import{Store,encode,hash}from '../../src/storage/store.js';
import{daemonConfigSchema}from '../../src/daemon/config.js';
import{migrateConfiguration,saveConfiguration,storedConfiguration}from '../../src/daemon/migrate.js';
import{acquireLock}from '../../src/daemon/lock.js';
import{configFixture}from '../helpers/config.js';
import{buildBaseline}from '../../src/runtime/prompt.js';
import{operationDocumentation,ToolRouter}from '../../src/runtime/tools.js';
import{Messages,Output}from '../../src/slack/messages.js';
import{Collaboration}from '../../src/collaboration/service.js';
import{Broker}from '../../src/policy/broker.js';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
function fixture(legacy=false){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mate-migrate-')));roots.push(root);const data=join(root,'data'),path=join(data,'state','mate.sqlite'),own=join(data,'agents','research'),shared=join(root,'shared');
 for(const dir of [join(data,'state'),own,shared])mkdirSync(dir,{recursive:true});writeFileSync(join(own,'MEMORY.md'),'private synthetic knowledge');
 const previous=daemonConfigSchema.parse({mate:configFixture,runtime:{dataDir:data,workspaceGrants:[{agentId:'research',root:shared,operations:['read','write']}]}});
 const store=new Store(path),base=buildBaseline(previous.mate.agents[0]!,operationDocumentation);store.register('research',base.configVersion,base.messages);
 if(!legacy)saveConfiguration(store,previous);else store.db.prepare("INSERT INTO runtime_meta VALUES('policy',?)").run(hash(encode(previous.runtime)));
 const messages=new Messages(store,previous.mate),c=new Collaboration(store,messages,new Output(messages,{post:async()=>({ts:'100.000002'})}),previous.mate);messages.membership('research','CTEST',true);
 const broker=new Broker(store,c,{execute:async()=>({code:0,stdout:'',stderr:'',truncated:false})},['/synthetic-protected']),router=new ToolRouter(c,broker),work=c.createWork('migration',{channel:'CTEST'});
 c.ledger.account('research');const grant=broker.issueGrant('UOWNER','research',work,shared,['read','write'],Date.now()+100000);
 const next=structuredClone(previous);next.mate.agents[0]!.role='An evolving research role';next.runtime.workspaceGrants[0]!.operations=['read'];
 return{root,data,path,own,previous,next,store,c,router,work,broker,grant};
}
it('offline migration backs up memory, updates baseline and grants, preserves debt, tasks, reminders and unknown receipts',async()=>{
 const f=fixture(),{store,c,work}=f;const task=c.createTask('research',work,{channel:'CTEST'},'ongoing');
 const reminder=c.reminders.create('research',work,{target:{channel:'CTEST'},content:'future follow-up',nextAt:Date.now()+100000,timezone:'UTC'});
 c.enqueue('research',work,'unfinished',{});const run=store.beginRun('research')!;store.input(run,{role:'user',content:'PRESERVE_HISTORY',timestamp:0});c.reserve(run,work,500,0.1);
 store.prepareAction(run,'OLD_UNKNOWN',{workId:work,operation:{kind:'exec',command:'synthetic'}});store.startAction(run,'OLD_UNKNOWN');
 f.router.sessions.checkpoint('research','durable checkpoint');store.close();
 const result=await migrateConfiguration(f.previous,f.next,join(f.root,'backup'));expect(result.legacyIdentityAttested).toBe(false);
 const reopened=new Store(f.path);try{
  const current=(reopened.db.prepare("SELECT session_id FROM agents WHERE id='research'").get() as any).session_id;
  expect(current).not.toBe(run.sessionId);expect(JSON.stringify(reopened.context(current))).toContain('PRESERVE_HISTORY');expect(JSON.stringify(reopened.context(current))).toContain('An evolving research role');
  expect(reopened.action('OLD_UNKNOWN')?.state).toBe('unknown');expect(reopened.db.prepare("SELECT tokens FROM budget_accounts WHERE agent_id='research'").get()).toEqual({tokens:500});
  expect(reopened.db.prepare('SELECT id FROM tasks WHERE id=?').get(task)).toBeDefined();expect(reopened.db.prepare('SELECT id FROM schedules WHERE id=?').get(reminder.id)).toBeDefined();
  expect(reopened.db.prepare('SELECT operations FROM grants WHERE id=?').get(f.grant)).toEqual({operations:'["read"]'});
  expect(storedConfiguration(reopened)).toEqual(f.next);expect(readFileSync(join(f.root,'backup','agents','research','MEMORY.md'),'utf8')).toBe('private synthetic knowledge');
  expect(reopened.db.prepare('SELECT text FROM agent_checkpoints').get()).toEqual({text:'durable checkpoint'});
 }finally{reopened.close();}
});
it('migration requires lock, exact previous configuration and stable workspace/Agent identities',async()=>{
 const f=fixture();f.store.close();const dest=join(f.root,'backup');
 const release=acquireLock(join(f.data,'state','daemon.lock'));await expect(migrateConfiguration(f.previous,f.next,dest)).rejects.toThrow('Another Mate');release();
 const wrong=structuredClone(f.previous);wrong.mate.agents[0]!.role='wrong old role';await expect(migrateConfiguration(wrong,f.next,dest)).rejects.toThrow('Previous configuration');
 const rebound=structuredClone(f.next);rebound.mate.agents[0]!.slackUserId='UOTHER';await expect(migrateConfiguration(f.previous,rebound,dest)).rejects.toThrow('rebound');expect(existsSync(dest)).toBe(false);
});
it('legacy identity requires explicit attestation; revoked grants stay revoked',async()=>{
 const f=fixture(true);f.broker.revoke('UOWNER',f.grant);f.store.close();
 await expect(migrateConfiguration(f.previous,f.next,join(f.root,'backup'))).rejects.toThrow('accept-legacy-identity');
 expect((await migrateConfiguration(f.previous,f.next,join(f.root,'backup'),true)).legacyIdentityAttested).toBe(true);
 const s=new Store(f.path);expect(s.db.prepare('SELECT revoked FROM grants WHERE id=?').get(f.grant)).toEqual({revoked:1});s.close();
});
it('a failed migration transaction leaves the old configuration/session/grants usable and retains a complete backup',async()=>{
 const f=fixture();const before=(f.router.sessions.status('research') as any).session;
 f.store.db.exec("CREATE TRIGGER reject_configuration BEFORE UPDATE ON runtime_meta WHEN NEW.key='configuration' BEGIN SELECT RAISE(ABORT,'synthetic persistence failure'); END");f.store.close();
 await expect(migrateConfiguration(f.previous,f.next,join(f.root,'backup'))).rejects.toThrow('synthetic persistence failure');
 const s=new Store(f.path);try{expect(storedConfiguration(s)).toEqual(f.previous);expect(s.db.prepare("SELECT session_id FROM agents WHERE id='research'").get()).toEqual({session_id:before});expect(s.db.prepare('SELECT operations FROM grants WHERE id=?').get(f.grant)).toEqual({operations:'["read","write"]'});expect(existsSync(join(f.root,'backup','COMPLETE.json'))).toBe(true);}finally{s.close();}
});
it('pending model reset migrates exactly once and retains its requested continuation',async()=>{
 const f=fixture();f.c.enqueue('research',f.work,'reset-during-upgrade',{});const run=f.store.beginRun('research')!;f.store.input(run,{});
 await f.router.call(run,f.work,'reset','sessions.reset',{text:'pending checkpoint'},new AbortController().signal);f.store.close();
 await migrateConfiguration(f.previous,f.next,join(f.root,'backup'));
 const s=new Store(f.path);try{expect(s.db.prepare('SELECT state FROM session_resets').get()).toEqual({state:'applied'});expect(s.db.prepare("SELECT count(*) n FROM deliveries WHERE dedupe LIKE 'session-reset:%'").get()).toEqual({n:1});const current=(s.db.prepare("SELECT session_id FROM agents WHERE id='research'").get() as any).session_id;expect(JSON.stringify(s.context(current))).toContain('pending checkpoint');expect(JSON.stringify(s.context(current))).toContain('An evolving research role');}finally{s.close();}
});
it('a migrated configuration starts locally and can add persistent peers beyond the old three-Agent cap',async()=>{
 const f=fixture();f.store.close();
 for(let n=2;n<=4;n++)f.next.mate.agents.push({...structuredClone(f.next.mate.agents[0]!),id:'peer'+n,name:'Peer '+n,slackAppId:'A'+n,slackUserId:'U'+n,slackBotId:'B'+n,botTokenEnv:'PEER'+n+'_BOT',appTokenEnv:'PEER'+n+'_APP'});
 const next=daemonConfigSchema.parse(f.next);await migrateConfiguration(f.previous,next,join(f.root,'backup'));
 const {Daemon}=await import('../../src/daemon/app.js');const refs=next.mate.agents.map(a=>a.botTokenEnv),saved=refs.map(ref=>process.env[ref]);refs.forEach(ref=>process.env[ref]='synthetic-local-only');
 try{const daemon=new Daemon(next,{info:()=>{},error:()=>{}});try{expect(daemon.store.db.prepare('SELECT count(*) n FROM agents').get()).toEqual({n:4});expect(existsSync(join(f.data,'agents','peer4','MEMORY.md'))).toBe(true);}finally{await daemon.close();}}
 finally{refs.forEach((ref,i)=>{if(saved[i]===undefined)delete process.env[ref];else process.env[ref]=saved[i];});}
});

it('migrates real legacy configuration key order without rewriting immutable effect evidence', async () => {
 const f=fixture();
 // R8 serialized model after Slack installation fields, before channels.
 const a=f.previous.mate.agents[0]!;
 const oldAgent={id:a.id,name:a.name,role:a.role,slackAppId:a.slackAppId,slackUserId:a.slackUserId,slackBotId:a.slackBotId,botTokenEnv:a.botTokenEnv,appTokenEnv:a.appTokenEnv,model:a.model,channels:a.channels};
 const legacy={...f.previous,mate:{...f.previous.mate,agents:[oldAgent]}};
 expect(encode(legacy)).not.toBe(encode(f.previous));
 f.store.db.prepare("UPDATE runtime_meta SET value=? WHERE key='configuration'").run(encode(legacy));
 const outbox='legacy-unknown';
 f.store.queueOutput('research',outbox,{target:{channel:'CTEST'},text:'unchanged legacy wire'});
 f.store.transitionOutput(outbox,'pending','sending');f.store.transitionOutput(outbox,'sending','unknown');
 const before=f.store.output(outbox)!;
 const session=(f.router.sessions.status('research') as {session:string}).session;
 f.store.db.prepare('UPDATE sessions SET config_version=? WHERE id=?').run('legacy-baseline-hash',session);
 f.store.close();
 await migrateConfiguration(f.previous,f.previous,join(f.root,'backup'));
 const s=new Store(f.path);
 try{
  expect(s.output(outbox)).toEqual(before);
  expect(storedConfiguration(s)).toEqual(f.previous);
  const current=s.db.prepare("SELECT session_id FROM agents WHERE id='research'").get() as {session_id:string};
  expect(current.session_id).not.toBe(session);
  expect(s.db.prepare('SELECT config_version FROM sessions WHERE id=?').get(current.session_id)).toEqual({config_version:buildBaseline(a,operationDocumentation).configVersion});
 }finally{s.close();}
});
