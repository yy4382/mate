import {afterEach,expect,it,vi} from 'vitest';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store,encode,hash} from '../../src/storage/store.js';
import {Messages,Output,fixtureTarget} from '../helpers/canonical-slack.js';
import {Collaboration} from '../../src/collaboration/service.js';
import {Broker} from '../../src/policy/broker.js';
import {ToolRouter} from '../../src/runtime/tools.js';
import {EnvironmentCapabilities,environmentReportSchema} from '../../src/capabilities/environment.js';
import {normalizeConfiguredWorkspaces,workspaceProfiles,WorkspaceAccess} from '../../src/capabilities/workspaces.js';
import {Artifacts} from '../../src/daemon/artifacts.js';
import {configFixture} from '../helpers/config.js';
import type {ExecutionBackend} from '../../src/execution/backend.js';
import {daemonConfigSchema} from '../../src/daemon/config.js';

const cleanup:(()=>void)[]=[];afterEach(()=>{cleanup.splice(0).forEach(fn=>fn());vi.restoreAllMocks();});
function roots(){const base=mkdtempSync(join(tmpdir(),'mate-environment-')),privateRoot=join(base,'private'),project=join(base,'project'),other=join(base,'other');for(const path of [privateRoot,project,other])mkdirSync(path);cleanup.push(()=>rmSync(base,{recursive:true,force:true}));return{base,privateRoot,project,other};}
function harness(execution:ExecutionBackend={execute:async()=>({code:0,stdout:'',stderr:'',truncated:false})},capabilities:{container?:boolean;attachments?:boolean;artifacts?:boolean;researchHosts?:string[]}={}){
  const path=roots(),store=new Store(':memory:');cleanup.push(()=>store.close());store.register('research','v1',[]);
  const messages=new Messages(store,configFixture);messages.membership('research','CTEST',true);const collaboration=new Collaboration(store,messages,new Output(messages,{post:async()=>({ts:'200.000001'})}),configFixture);
  const container=capabilities.container??true,broker=new Broker(store,collaboration,execution,[]),profiles=workspaceProfiles({research:path.privateRoot},normalizeConfiguredWorkspaces([{agentId:'research',root:path.project,operations:['read'],label:'project'}],[]),container),access=new WorkspaceAccess(collaboration,broker,profiles);
  const target=fixtureTarget('CTEST','100.000001'),work=collaboration.createWork('environment',target);collaboration.enqueue('research',work,'start',{});const run=store.beginRun('research')!;store.input(run,{});
  const environment=new EnvironmentCapabilities(collaboration,broker,profiles,{image:container?`sha256:${'0'.repeat(64)}`:null,network:container?'bridge':'none',researchHosts:capabilities.researchHosts??['example.com'],attachmentConfigured:()=>capabilities.attachments??true,artifactConfigured:()=>capabilities.artifacts??true,artifactSupported:(_actor,target)=>(capabilities.artifacts??true)&&collaboration.messages.references.conversation(target.conversationId).authority==='external'});
  const router=new ToolRouter(collaboration,broker,{environment:(token,current)=>environment.read(token,current),research:async()=>({}),publish:async()=>({})},undefined,(actor,current)=>access.provision(actor,current));
  return{...path,store,messages,collaboration,broker,profiles,access,environment,router,target,work,run};
}

it('normalizes labels by canonical root and rejects ambiguous or duplicate identities',()=>{
  const{project,other}=roots();
  expect(normalizeConfiguredWorkspaces([{agentId:'research',root:project,operations:['read']},{agentId:'research',root:project,operations:['write'],label:'project'}],[])).toMatchObject([{label:'project',operations:['read','write']}]);
  const generated=normalizeConfiguredWorkspaces([{agentId:'research',root:project,operations:['read']}],[])[0]!.label;
  expect(generated).toMatch(/^workspace-[a-f0-9]{16}$/);expect(normalizeConfiguredWorkspaces([{agentId:'research',root:project,operations:['read']}],[])[0]!.label).toBe(generated);
  expect(()=>normalizeConfiguredWorkspaces([{agentId:'research',root:project,operations:['read'],label:'one'},{agentId:'research',root:project,operations:['write'],label:'two'}],[])).toThrow(/multiple labels/);
  expect(()=>normalizeConfiguredWorkspaces([{agentId:'research',root:project,operations:['read'],label:'same'},{agentId:'research',root:other,operations:['read'],label:'same'}],[])).toThrow(/Duplicate workspace label/);
});

it('keeps missing labels out of legacy policy identity while explicit labels require migration',()=>{
  const{base,project}=roots(),agent={id:'research',name:'Research',role:'Investigate',model:{provider:'anthropic',id:'claude-haiku-4-5',apiKeyEnv:'MODEL_API_KEY'}},input={version:2 as const,mate:{agents:[agent],ownerUserIds:['owner'],budgets:{maxRuns:3,maxTokens:1000,maxCostUsd:1,runTimeoutMs:10000}},adapters:{local:{humans:['owner'],rooms:[{id:'room',agents:['research'],humans:['owner']}]}},runtime:{dataDir:base,workspaceGrants:[{agentId:'research',root:project,operations:['read' as const]}],researchHosts:[]}};
  const legacy=daemonConfigSchema.parse(input);expect(Object.hasOwn(legacy.runtime.workspaceGrants[0]!,'label')).toBe(false);
  const labeled=daemonConfigSchema.parse({...input,runtime:{...input.runtime,workspaceGrants:[{...input.runtime.workspaceGrants[0]!,label:'project'}]}});expect(hash(encode(legacy.runtime))).not.toBe(hash(encode(labeled.runtime)));
});

it('provisions all configured grants atomically before observation',()=>{
  const h=harness(),second=normalizeConfiguredWorkspaces([{agentId:'research',root:h.other,operations:['read'],label:'other'}],[])[0]!,access=new WorkspaceAccess(h.collaboration,h.broker,[...h.profiles,second]);
  h.store.db.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON grants WHEN NEW.root='${second.root.replaceAll("'","''")}' BEGIN SELECT RAISE(ABORT,'synthetic'); END`);
  expect(()=>access.provision('research',h.work)).toThrow('synthetic');expect(h.store.db.prepare('SELECT count(*) n FROM grants').get()).toEqual({n:0});expect(h.store.db.prepare("SELECT count(*) n FROM audit WHERE kind='grant'").get()).toEqual({n:0});
});

it('reports only effective current-work capabilities without mutating authorization',async()=>{
  const h=harness();h.access.provision('research',h.work);const before={grants:h.store.db.prepare('SELECT count(*) n FROM grants').get(),audit:h.store.db.prepare('SELECT count(*) n FROM audit').get()};
  const first=(await h.router.call(h.run,h.work,'environment-one','environment.info',{},new AbortController().signal)).value;expect(environmentReportSchema.parse(first)).toMatchObject({format:'mate.environment.v1',workId:h.work,authorization:'informational_snapshot_rechecked_on_every_action',workspaces:{pathStyle:'relative_to_grant',execMountPoint:'/workspace',simultaneouslyMounted:false,grants:[{label:'private-workspace',kind:'private',operations:['exec','read','write']},{label:'project',kind:'configured',operations:['read']}]},execution:{status:'configured',network:'bridge'},research:{status:'configured',search:false},attachmentInput:{status:'configured'},artifactOutput:{status:'configured'}});
  expect(JSON.stringify(first)).not.toContain(h.privateRoot);expect(JSON.stringify(first)).not.toContain(h.project);expect(h.store.db.prepare('SELECT count(*) n FROM grants').get()).toEqual(before.grants);expect(h.store.db.prepare('SELECT count(*) n FROM audit').get()).toEqual(before.audit);
  const project=(first as any).workspaces.grants.find((grant:any)=>grant.label==='project');h.broker.revoke('UOWNER',project.id);
  const second=(await h.router.call(h.run,h.work,'environment-two','environment.info',{},new AbortController().signal)).value as any;expect(second.workspaces.grants.map((grant:any)=>grant.label)).toEqual(['private-workspace']);expect(second.workspaces.unavailable).toEqual([{label:'project',kind:'configured',reason:'configured_grant_not_effective'}]);
  await expect(h.broker.execute(h.run,h.work,'stale',project.id,{kind:'read',path:'.'})).rejects.toThrow('Grant does not cover action');
  const privateGrant=second.workspaces.grants[0];h.broker.revoke('UOWNER',privateGrant.id);const withoutExec=h.environment.read(h.run,h.work);expect(withoutExec.execution).toMatchObject({status:'unavailable',network:'none',image:null});
});

it('reports artifact output against the current target instead of actor binding alone',()=>{
  const h=harness();h.access.provision('research',h.work);h.messages.references.createConversation('channel','internal','internal-room');h.messages.membership('research','internal-room',true);const internal=h.collaboration.createWork('internal',{conversationId:'internal-room'});h.collaboration.selectWork(h.run,internal);h.access.provision('research',internal);
  expect(h.environment.read(h.run,internal).artifactOutput).toMatchObject({adapterStatus:'configured',status:'unavailable',scope:'supported_external_target_only',reason:'The current work target does not support artifact output.'});
});

it('work selection provisions the selected work and review seats redact external capabilities',async()=>{
  const h=harness();h.access.provision('research',h.work);const oldGrant=(h.store.db.prepare('SELECT id FROM grants WHERE work_id=? ORDER BY rowid LIMIT 1').get(h.work) as {id:string}).id,other=h.collaboration.createWork('other',h.target);
  await h.router.call(h.run,h.work,'select','works.select',{workId:other},new AbortController().signal);
  const selected=(await h.router.call(h.run,h.work,'selected-environment','environment.info',{},new AbortController().signal)).value as any;expect(selected.workId).toBe(other);expect(selected.workspaces.grants).toHaveLength(2);
  await expect(h.broker.execute(h.run,h.work,'old-work',oldGrant,{kind:'read',path:'.'})).rejects.toThrow(/work mismatch/i);
  h.store.db.prepare('INSERT INTO review_seats VALUES(?,?,?,?,1)').run('research',JSON.stringify(h.target),'brief',h.profiles.find(profile=>profile.kind==='private')!.root);
  const seat=(await h.router.call(h.run,h.work,'seat-environment','environment.info',{},new AbortController().signal)).value as any;expect(seat.workspaces.grants.map((grant:any)=>grant.kind)).toEqual(['private']);expect(seat.execution.network).toBe('none');expect(seat.research.status).toBe('unavailable');expect(seat.attachmentInput.status).toBe('unavailable');expect(seat.artifactOutput.status).toBe('unavailable');
});

it('reports structured files without pretending container, research or adapters are configured',async()=>{
  const h=harness(undefined,{container:false,attachments:false,artifacts:false,researchHosts:[]});h.access.provision('research',h.work);const report=h.environment.read(h.run,h.work);
  expect(report.workspaces.grants[0]?.operations).toEqual(['read','write']);expect(report.execution).toMatchObject({status:'unavailable',network:'none',image:null});expect(report.research.status).toBe('unavailable');expect(report.attachmentInput.status).toBe('unavailable');expect(report.artifactOutput.status).toBe('unavailable');
});

it('fails closed without leaking a vanished host workspace path',()=>{
  const h=harness();h.access.provision('research',h.work);rmSync(h.privateRoot,{recursive:true,force:true});
  let message='';try{h.environment.read(h.run,h.work);}catch(error){message=String(error);}
  expect(message).toContain('Grant root unavailable or changed');expect(message).not.toContain(h.privateRoot);expect(message).not.toContain(h.base);
});

it('fails unsupported artifact output before reading or freezing the file',async()=>{
  const execute=vi.fn(async()=>({code:0,stdout:'secret',stderr:'',truncated:false})),h=harness({execute});h.access.provision('research',h.work);writeFileSync(join(h.privateRoot,'artifacts-result.txt'),'secret');
  const artifacts=new Artifacts(h.collaboration,h.broker,{configured:()=>false,supports:()=>false,upload:async()=>{throw new Error('must not upload');}},{research:h.privateRoot});
  const privateGrant=(h.store.db.prepare('SELECT id FROM grants WHERE root=?').get(h.profiles.find(profile=>profile.kind==='private')!.root) as {id:string}).id;
  await expect(artifacts.publish(h.run,h.work,'unsupported',{grantId:privateGrant,path:'artifacts-result.txt',title:'result',target:h.target},new AbortController().signal)).rejects.toThrow(/adapter unavailable/);
  expect(execute).not.toHaveBeenCalled();expect(h.store.db.prepare('SELECT count(*) n FROM outbox').get()).toEqual({n:0});
});
