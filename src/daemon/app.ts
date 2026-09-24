import {SlackHistory} from '../slack/history.js';
import type {AdapterLifecycle} from './adapter.js';
import {SlackRuntime} from '../slack/runtime.js';
import {initializeCanonicalStore} from '../storage/internal-schema.js';
import {localConversations} from '../local/application.js';
import {LocalAdapter} from '../local/input.js';
import {configureLocalRooms} from '../local/rooms.js';
import {migrateProjections} from '../storage/projection-schema.js';
import {migrateProjectionImports} from '../storage/projection-import-schema.js';
import {migrateHistoryIndexes} from '../storage/history-schema.js';
import {migrateCoordinationRecovery} from '../storage/coordination-schema.js';
import {migrateOperationsView} from '../storage/operations-schema.js';
import {migrateSystemOperations} from '../storage/system-operations-schema.js';
import {TeamDirectory} from '../conversations/team-directory.js';
import {migrateInternalConversations} from '../storage/internal-schema.js';
import { migrateCanonicalConversations } from '../slack/canonical-migration.js';
import { slackApplication } from '../slack/application.js';

import { CanonicalOutput as Output } from '../conversations/output.js';
import { storedConfiguration,saveConfiguration } from './migrate.js';
import {Attachments}from '../slack/attachments.js';
import { Directory } from '../slack/directory.js';
import { mkdirSync, writeFileSync, existsSync, realpathSync, lstatSync, readdirSync, readFileSync, chownSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { sameConfiguration, daemonConfigSchema, slackRuntimeConfig, type DaemonConfig } from './config.js';
import { requireSecret } from '../config.js';
import { Store, hash } from '../storage/store.js';

import { CanonicalSlackTransport as WebSlackTransport } from '../slack/transport.js';
import { Collaboration } from '../collaboration/service.js';
import { Broker } from '../policy/broker.js';
import type {ExecutionBackend} from '../execution/backend.js';
import {LinuxUserBackend} from '../execution/linux-user.js';
import {LinuxProcessManager} from '../execution/linux-processes.js';
import {SystemOperations} from '../policy/system-operations.js';
import {PrivilegedBackend} from '../execution/privileged.js';
import { canonicalRoot, within } from '../execution/paths.js';
import { Supervisor } from '../runtime/supervisor.js';
import { ToolRouter } from '../runtime/tools.js';
import { acquireLock } from './lock.js';
import { Controls } from './control.js';
import { Research } from './research.js';
import { Artifacts } from './artifacts.js';
import {EnvironmentCapabilities} from '../capabilities/environment.js';
import {reservedAgentHomePaths,pathVariants} from './paths.js';
import {assertNoRestoreInProgress} from './restore.js';
import {FairAdmission} from '../concurrency/admission.js';
import {AdmittedBackend} from '../execution/admitted.js';
import {assertLinuxOperationAllowed} from '../deployment/linux-upgrade-guard.js';
import {initialMemory} from '../agents/workspace.js';
export interface Log { info(data: object, message: string): void; error(data: object, message: string): void }
export class Daemon {
  readonly store: Store;
  readonly collaboration: Collaboration;
  readonly broker: Broker;
  readonly system:SystemOperations;
  readonly supervisor: Supervisor;
  readonly controls:Controls;
  readonly local:LocalAdapter|undefined;
  readonly adapter:AdapterLifecycle|undefined;
  private readonly slackRuntime:SlackRuntime|undefined;
  /** Compatibility inspection surface; production lifecycle uses the adapter port. */
  get slack(){if(!this.slackRuntime)throw new Error('Slack adapter unavailable');return this.slackRuntime.service;}
  get projections(){if(!this.slackRuntime)throw new Error('Slack adapter unavailable');return this.slackRuntime.projections;}
  readonly memoryRoots: Record<string, string> = {};
  readonly backend: ExecutionBackend;
  private release: () => void;
  private readonly abort=new AbortController();
  private background?:Promise<void>;
  private privileged?:Promise<void>;
  private opening?:Promise<void>;
  private stopping = false;
  private paused = false;
  private runs = new Set<Promise<unknown>>();
  private loopPromise?: Promise<void>;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  readonly config:DaemonConfig;
  static async create(input:unknown,log:Log,projectRoot=resolve('.')):Promise<Daemon>{
    const config=daemonConfigSchema.parse(input),data=config.runtime.dataDir;
    if(process.platform==='linux'&&!config.runtime.linuxUsers)throw new Error('Linux deployment requires one Linux user for every Agent');
    if(config.runtime.linuxUsers&&process.platform==='linux'){
      if(process.getuid?.()!==0)throw new Error('Mate must run as root to switch Agent Linux users');
      const processes=new LinuxProcessManager(Object.fromEntries(Object.entries(config.runtime.linuxUsers).map(([agentId,user])=>[agentId,user.uid])));
      for(const agent of config.mate.agents)processes.verifyQuota(agent.id);
    }
    mkdirSync(data,{recursive:true,mode:0o700});if(lstatSync(data).isSymbolicLink()||within(realpathSync(projectRoot),realpathSync(data)))throw new Error('Data directory must be outside the application checkout and not a symlink');
    const state=join(data,'state');mkdirSync(state,{recursive:true,mode:0o700});if(lstatSync(state).isSymbolicLink())throw new Error('State path must not be a symlink');
    if(config.runtime.linuxUsers)for(const path of [data,state]){const status=lstatSync(path);if(!status.isDirectory()||status.uid!==process.getuid?.()||status.gid!==process.getgid?.()||(status.mode&0o777)!==0o700)throw new Error(`Mate control directory must be private and owned by Mate: ${path}`);}
    const release=acquireLock(join(state,'daemon.lock'));let transferred=false;
    try{
      assertLinuxOperationAllowed('start',config);
      await assertNoRestoreInProgress(data);
      const daemon=new Daemon(config,log,projectRoot,release);transferred=true;return daemon;
    }finally{if(!transferred)release();}
  }
  private constructor(config:DaemonConfig,readonly log:Log,readonly projectRoot:string,release:()=>void) {
    this.config=config;this.release=release;
    const slackConfig=slackRuntimeConfig(config);
    const data = config.runtime.dataDir;
    if (lstatSync(data).isSymbolicLink() || within(realpathSync(projectRoot), realpathSync(data))) throw new Error('Data directory must be outside the application checkout and not a symlink');
    const state = join(data, 'state');
    if (lstatSync(state).isSymbolicLink()) throw new Error('State path must not be a symlink');
    let opened: Store | undefined;
    try {
      this.store = opened = new Store(join(state, 'mate.sqlite'));
      this.store.db.exec('BEGIN IMMEDIATE');
      const previous=storedConfiguration(this.store);
      if(previous&&!sameConfiguration(previous,config))throw new Error('Configuration changed; run explicit offline migration');
      if(!previous&&this.store.db.prepare('SELECT 1 FROM agents').get())throw new Error('Legacy configuration requires explicit offline migration');
      const policyHash = hash(JSON.stringify(config.runtime));
      const oldPolicy = this.store.db.prepare("SELECT value FROM runtime_meta WHERE key='policy'").get() as { value: string } | undefined;
      if (oldPolicy && oldPolicy.value !== policyHash) throw new Error('Runtime policy changed; explicit policy migration required');
      const c = config.mate;
      if(!this.store.db.prepare("SELECT 1 FROM runtime_meta WHERE key='conversation_format'").get()){
        if(previous)throw new Error('Canonical conversation storage requires explicit offline migration');

      }
      if(slackConfig)migrateCanonicalConversations(this.store,slackConfig);else initializeCanonicalStore(this.store);
      if(previous&&Number(this.store.db.pragma('user_version',{simple:true}))<21)throw new Error('Conversation storage requires explicit offline migration');
      if(previous&&Number(this.store.db.pragma('user_version',{simple:true}))<22)throw new Error('Coordination storage requires explicit offline migration');
      if(previous&&Number(this.store.db.pragma('user_version',{simple:true}))<23)throw new Error('Operations view storage requires explicit offline migration');
      migrateInternalConversations(this.store);migrateProjections(this.store);migrateProjectionImports(this.store);migrateHistoryIndexes(this.store);migrateCoordinationRecovery(this.store);migrateOperationsView(this.store);migrateSystemOperations(this.store);
      const slackApp=slackConfig?slackApplication(this.store,slackConfig,c):undefined;
      const messages=slackApp?.messages??localConversations(this.store,c);
      messages.writes.assertFormat();
      const transport=slackApp&&slackConfig?new WebSlackTransport(this.store,slackApp.mapper):undefined;
      const output=new Output(messages,transport??{post:async()=>{throw new Error('External transport unavailable');},pendingInput:()=>false,classify:()=>({kind:'rejected',reason:'External transport unavailable'})});
      this.collaboration = new Collaboration(this.store, messages, output, c);
      this.system=new SystemOperations(this.store,this.collaboration,config.runtime.systemAgents??[],new PrivilegedBackend());
      const agentsDir = join(data, 'agents');if(!config.runtime.linuxUsers)mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
      if (existsSync(agentsDir)&&lstatSync(agentsDir).isSymbolicLink()) throw new Error('Agents directory must not be a symlink');
      for (const agent of this.collaboration.agents.list()) {
        const linux=config.runtime.linuxUsers?.[agent.id];
        const root = linux?.home??join(data, 'agents', agent.id);
        if(linux){
          if(!existsSync(root))throw new Error(`Linux Agent home must be provisioned first: ${agent.id}`);
          const status=lstatSync(root);
          if(!status.isDirectory()||status.uid!==linux.uid||status.gid!==linux.gid||(status.mode&0o777)!==0o700)throw new Error(`Linux Agent home must be private and owned by its user: ${agent.id}`);
          if(within(realpathSync(data),realpathSync(root))||within(realpathSync(root),realpathSync(data)))throw new Error('Linux Agent home must be outside Mate data');
        }else mkdirSync(root, { recursive: true, mode: 0o700 });
        if (lstatSync(root).isSymbolicLink()) throw new Error('Agent memory must not be a symlink');
        this.memoryRoots[agent.id] = canonicalRoot(root, [projectRoot, state]);
        const memory=join(root,'MEMORY.md');if (!existsSync(memory)){if(linux)throw new Error(`Provision Linux Agent memory entry before startup: ${agent.id}`);for(const name of ['notes','artifacts'])mkdirSync(join(root,name),{recursive:true,mode:0o700});writeFileSync(memory, initialMemory(agent.name), { flag: 'wx', mode: 0o600 });}if(linux){const status=lstatSync(memory);if(!status.isFile()||status.uid!==linux.uid||status.gid!==linux.gid||(status.mode&0o600)!==0o600)throw new Error(`Linux Agent memory entry is not writable by its user: ${agent.id}`);}
      }
      if(config.runtime.linuxUsers){const homes=Object.values(this.memoryRoots);for(const [index,root] of homes.entries())for(const other of homes.slice(index+1))if(within(root,other)||within(other,root))throw new Error('Linux Agent homes overlap');}
      const protectedRoots=reservedAgentHomePaths(projectRoot,state,agentsDir),privateBase=new Set(pathVariants(agentsDir));
      const privateForbidden=protectedRoots.filter(root=>!privateBase.has(root));for(const root of Object.values(this.memoryRoots))canonicalRoot(root,privateForbidden);
      if(config.runtime.sharedRoot){
        const shared=canonicalRoot(config.runtime.sharedRoot,[...protectedRoots,...Object.values(this.memoryRoots)]),stat=lstatSync(shared);
        if((process.platform==='linux'&&stat.uid!==0)||(stat.mode&0o022)||(stat.mode&0o005)!==0o005)throw new Error('Shared root must be root-owned and readable, not writable, by Agents');
        for(const [agentId,user] of Object.entries(config.runtime.linuxUsers??{})){
          const own=join(shared,agentId);
          if(!existsSync(own)){mkdirSync(own,{mode:0o755});chmodSync(own,0o755);chownSync(own,user.uid,user.gid);}
          const ownStat=lstatSync(own);
          if(!ownStat.isDirectory()||ownStat.uid!==user.uid||ownStat.gid!==user.gid||(ownStat.mode&0o777)!==0o755)throw new Error(`Shared Agent directory must be owned by its user and peer-readable: ${agentId}`);
        }
      }
      const identities=config.runtime.linuxUsers??Object.fromEntries(Object.entries(this.memoryRoots).map(([id,home])=>[id,{uid:process.getuid!(),gid:process.getgid!(),home}]));
      const linuxBackend=new LinuxUserBackend(identities);
      const linuxProcesses=config.runtime.linuxUsers?new LinuxProcessManager(Object.fromEntries(Object.entries(config.runtime.linuxUsers).map(([agentId,user])=>[agentId,user.uid]))):undefined;
      const backendAdmission=new FairAdmission(config.runtime.limits.maxBackendOperations),admittedFiles=new AdmittedBackend(linuxBackend,backendAdmission);
      this.backend = admittedFiles;
      this.broker = new Broker(this.store, this.collaboration, this.backend, this.memoryRoots);
      const research = new Research(config.runtime.researchHosts);
      let artifacts!: Artifacts;
      const attachments=transport?new Attachments(this.collaboration,this.broker,transport.clients):undefined;
      const environment=new EnvironmentCapabilities(this.collaboration,{homes:this.memoryRoots,...(config.runtime.sharedRoot?{sharedRoot:config.runtime.sharedRoot}:{}),access:process.platform==='linux'?'linux_user_permissions':'local_user_permissions',researchHosts:config.runtime.researchHosts,attachmentConfigured:actor=>attachments?.configured(actor)??false,artifactConfigured:actor=>artifacts?.configured(actor)??false,artifactSupported:(actor,target)=>artifacts?.supports(actor,target)??false});
      const router = new ToolRouter(this.collaboration, this.broker, { attachment:(...args)=>{if(!attachments)throw new Error('Attachment adapter unavailable');return attachments.save(...args);},environment:(run,workId)=>environment.read(run,workId),...(linuxProcesses?{processes:linuxProcesses}:{}),system:this.system,research: (url, signal) => research.read(url, signal), publish: (...args) => artifacts.publish(...args) }, new TeamDirectory(messages,transport?new Directory(messages,transport.clients,transport.mapper):undefined),value=>slackApp?.argumentsCodec.args(value)??value,transport?new SlackHistory(messages,transport):undefined);
      this.supervisor = new Supervisor(this.collaboration, router, c, undefined, async (agentId, workId, signal) => {
        const result = await admittedFiles.execute({ agentId,root: this.memoryRoots[agentId]!, operation: { kind: 'read', path: 'MEMORY.md' }, timeoutMs: 10000 }, signal);
        if (result.code !== 0 || result.truncated) throw new Error('Private memory recovery read failed'); return result.stdout;
      },{runAdmission:new FairAdmission(config.runtime.limits.maxActiveRuns),workerIdleMs:config.runtime.limits.workerIdleMs});
      this.supervisor.register();
      this.controls=new Controls(this.collaboration,this.supervisor,this.broker,actor=>this.verifyReviewWorkspace(actor),(user,command,id,args)=>this.slackRuntime?.projections.control(user,command,id,args),linuxProcesses,this.system);
      this.adapter=this.slackRuntime=transport?new SlackRuntime(this.collaboration,transport,this.controls,message=>this.log.error({},message),this.system):undefined;
      this.local=config.adapters.local?new LocalAdapter(this.collaboration,config.adapters.local.humans):undefined;
      artifacts = new Artifacts(this.collaboration,this.broker,this.slackRuntime?.service,this.memoryRoots);
      this.store.atomic(()=>{configureLocalRooms(this.collaboration,previous?.adapters.local,config.adapters.local);saveConfiguration(this.store,config);});
      this.store.db.exec('COMMIT');
    } catch (error) {
      try{if(opened?.db.inTransaction)opened.db.exec('ROLLBACK');}finally{try{opened?.close();}finally{this.release();}}
      throw error;
    }
  }
  private verifyReviewWorkspace(actor:string):string {
    const root=this.memoryRoots[actor],agent=this.collaboration.agents.get(actor);
    if(!root||!agent)throw new Error('Unknown review identity');
    const names=readdirSync(root);if(names.some(name=>!['MEMORY.md','notes','artifacts'].includes(name)))throw new Error('Review workspace is not clean');
    for(const dir of ['notes','artifacts']){if(!names.includes(dir))continue;const path=join(root,dir);if(lstatSync(path).isSymbolicLink()||readdirSync(path).length)throw new Error('Review workspace contains prior material');}
    const memory=join(root,'MEMORY.md');if(lstatSync(memory).isSymbolicLink()||lstatSync(memory).nlink!==1||readFileSync(memory,'utf8')!==initialMemory(agent.name))throw new Error('Review memory contains prior material');
    return root;
  }
  start(progress?:()=>void): Promise<void> {
    if(!this.startPromise){this.opening=this.open(progress);this.startPromise=this.opening.catch(async error=>{await this.close();throw error;});}
    return this.startPromise;
  }
  private async open(progress?:()=>void): Promise<void> {
    if (this.stopping) throw new Error('Daemon stopped during startup');
    this.store.recover();this.system.recover();this.adapter?.recover();this.supervisor.recoverSessions();
    const models=builtinModels();for(const agent of this.config.mate.agents){requireSecret(process.env,agent.model.apiKeyEnv);if(!models.getModel(agent.model.provider,agent.model.id))throw new Error(`Unknown provider/model for ${agent.id}`);}
    const slackConfig=slackRuntimeConfig(this.config);if(slackConfig&&this.slackRuntime)this.slackRuntime.transport.configure(Object.fromEntries(slackConfig.agents.map(agent=>[agent.id,requireSecret(process.env,agent.botTokenEnv)])));
    await this.adapter?.start(this.abort.signal,progress);if(this.stopping)throw new Error('Daemon stopped during startup');
    this.collaboration.output.gate?.adoptPending();
    this.loopPromise=this.loop();this.log.info({},'Mate daemon started');
  }
  private async flushExternal():Promise<void>{
    try{
      for(const row of this.collaboration.output.ready(20,'external')){
        if(this.stopping||this.paused)return;
        const target=this.collaboration.messages.records.targetedEffect('outbox',row.id).target;
        if(this.collaboration.messages.references.conversation(target.conversationId).authority==='external')await this.collaboration.output.send(row.id);
      }
    }catch{this.log.error({},'External output flush failed; durable state retained');}
    if(!this.stopping&&!this.paused)try{await this.adapter?.flush();}catch{this.log.error({},'Adapter maintenance failed; internal scheduling continues');}
  }
  private async loop(): Promise<void> {
    while (!this.stopping) {
      try{if(!this.paused)this.adapter?.poll();}catch{this.log.error({},'Adapter replay failed; internal scheduling continues');}
      try {
        if (!this.paused) {
          this.collaboration.tick();
          for(const row of this.collaboration.output.ready(20,'internal')){
            const target=this.collaboration.messages.records.targetedEffect('outbox',row.id).target;
            if(this.collaboration.messages.references.conversation(target.conversationId).authority==='internal')await this.collaboration.output.send(row.id);
          }
          this.collaboration.activateDelegations();
          if(!this.privileged)this.privileged=this.system.dispatchApproved().catch(()=>{this.log.error({},'Privileged execution dispatch failed; durable state retained');}).finally(()=>{delete this.privileged;});
          if(!this.background)this.background=this.flushExternal().finally(()=>{delete this.background;});
          if (!this.paused && !this.stopping) for (const agent of this.collaboration.agents.list()) {
            const run=this.supervisor.step(agent.id).catch(()=>{this.log.error({agentId:agent.id},'Agent scheduling failed');});
            this.runs.add(run);void run.then(()=>this.runs.delete(run));
          }
        }
      }catch{this.log.error({},'Daemon tick failed; durable state retained');}
      if(!this.stopping)await new Promise<void>(resolve=>{
        const wake=()=>{clearTimeout(timer);this.abort.signal.removeEventListener('abort',wake);resolve();};
        const timer=setTimeout(wake,500);this.abort.signal.addEventListener('abort',wake,{once:true});
      });
    }
  }
  close(): Promise<void> { return this.closePromise ??= this.shutdown(); }
  private async shutdown(): Promise<void> {
    this.stopping=true;this.abort.abort();
    const failures:unknown[]=[];
    const settle=async(action:()=>unknown)=>{try{await action();}catch(error){failures.push(error);}};
    try{
      await settle(()=>this.supervisor.close());await settle(()=>this.adapter?.close());
      await settle(()=>this.opening?.catch(()=>{}));await settle(()=>this.loopPromise);await settle(()=>this.background);await settle(()=>this.privileged);
      await Promise.allSettled([...this.runs]);await settle(()=>this.supervisor.drain());
    }finally{try{this.store.close();}finally{this.release();}}
    if(failures.length)throw new AggregateError(failures,'Daemon cleanup failed after draining owned work');
  }
}
