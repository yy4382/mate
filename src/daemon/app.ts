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
import { SandboxBackend, type ExecutionBackend } from '../execution/backend.js';
import { ContainerBackend, ControlledBackend } from '../execution/container.js';
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
import {normalizeConfiguredWorkspaces,workspaceProfiles,WorkspaceAccess} from '../capabilities/workspaces.js';
import { assertDockerControlIsolation,executionProtectedPaths,executionScope,pathVariants } from './paths.js';
import {assertNoRestoreInProgress} from './restore.js';
import {FairAdmission} from '../concurrency/admission.js';
import {AdmittedBackend} from '../execution/admitted.js';
import {DeploymentBoundaryBackend,nodeDeploymentEnvironment,verifyDeploymentWorkspaces,type DeploymentEnvironment} from '../deployment/runtime.js';
import type {VerifiedWorkspaces} from '../deployment/workspaces.js';
import {assertLinuxOperationAllowed} from '../deployment/linux-upgrade-guard.js';
export interface Log { info(data: object, message: string): void; error(data: object, message: string): void }
export interface DaemonEnvironment extends DeploymentEnvironment {}
export class Daemon {
  readonly store: Store;
  readonly collaboration: Collaboration;
  readonly broker: Broker;
  readonly system:SystemOperations;
  readonly workspaceAccess:WorkspaceAccess;
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
  private container: ContainerBackend | undefined;
  private readonly containerProbeRoots:string[];
  private readonly managedWorkspaceBoundary:boolean;
  private readonly deploymentEnvironment:DeploymentEnvironment;
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
  static async create(input:unknown,log:Log,projectRoot=resolve('.'),environment:DaemonEnvironment=nodeDeploymentEnvironment()):Promise<Daemon>{
    const config=daemonConfigSchema.parse(input),data=config.runtime.dataDir;
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
      const agentsDir=join(data,'agents');assertDockerControlIsolation(projectRoot,state,agentsDir,config.runtime.workspaceGrants,config.runtime.docker,config.runtime.workspaceManifest?[config.runtime.workspaceManifest]:[]);
      const container=config.runtime.docker?new ContainerBackend({...config.runtime.docker,scope:executionScope(data)}):undefined;
      await container?.recover();
      const workspaces=verifyDeploymentWorkspaces(config,environment);
      const daemon=new Daemon(config,log,projectRoot,release,container,workspaces,environment);transferred=true;return daemon;
    }finally{if(!transferred)release();}
  }
  private constructor(config:DaemonConfig,readonly log:Log,readonly projectRoot:string,release:()=>void,container:ContainerBackend|undefined,verifiedWorkspaces:VerifiedWorkspaces|undefined,deploymentEnvironment:DeploymentEnvironment) {
    this.config=config;this.release=release;this.container=container;this.containerProbeRoots=verifiedWorkspaces?[...verifiedWorkspaces.roots.values(),...verifiedWorkspaces.externalRoots]:[];this.managedWorkspaceBoundary=!!verifiedWorkspaces;this.deploymentEnvironment=deploymentEnvironment;
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
      const agentsDir = join(data, 'agents');if(!verifiedWorkspaces)mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
      if (lstatSync(agentsDir).isSymbolicLink()) throw new Error('Agents directory must not be a symlink');
      for (const agent of this.collaboration.agents.list()) {
        const linux=config.runtime.linuxUsers?.[agent.id];
        const root = linux?.home??verifiedWorkspaces?.roots.get(agent.id)??join(data, 'agents', agent.id);
        if(linux){
          if(!existsSync(root))throw new Error(`Linux Agent home must be provisioned first: ${agent.id}`);
          const status=lstatSync(root);
          if(!status.isDirectory()||status.uid!==linux.uid||status.gid!==linux.gid||(status.mode&0o777)!==0o700)throw new Error(`Linux Agent home must be private and owned by its user: ${agent.id}`);
          if(within(realpathSync(data),realpathSync(root))||within(realpathSync(root),realpathSync(data)))throw new Error('Linux Agent home must be outside Mate data');
        }else if(!verifiedWorkspaces)mkdirSync(root, { recursive: true, mode: 0o700 });
        if (lstatSync(root).isSymbolicLink()) throw new Error('Agent memory must not be a symlink');
        this.memoryRoots[agent.id] = canonicalRoot(root, [projectRoot, state]);
        for (const dir of ['notes','artifacts']) {const path=join(root,dir);if(!existsSync(path)){if(linux)throw new Error(`Provision Linux Agent private directory before startup: ${path}`);mkdirSync(path,{mode:0o700});}if(linux){const status=lstatSync(path);if(!status.isDirectory()||status.uid!==linux.uid||status.gid!==linux.gid||(status.mode&0o700)!==0o700)throw new Error(`Linux Agent private directory is not writable by its user: ${path}`);}}
        const memory=join(root,'MEMORY.md');if (!existsSync(memory)){if(linux)throw new Error(`Provision Linux Agent memory entry before startup: ${agent.id}`);writeFileSync(memory, `# ${agent.name}\n\nPrivate memory entry. Keep durable lessons and links to notes here.\n`, { flag: 'wx', mode: 0o600 });}if(linux){const status=lstatSync(memory);if(!status.isFile()||status.uid!==linux.uid||status.gid!==linux.gid||(status.mode&0o600)!==0o600)throw new Error(`Linux Agent memory entry is not writable by its user: ${agent.id}`);}
      }
      if(config.runtime.linuxUsers){const homes=Object.values(this.memoryRoots);for(const [index,root] of homes.entries())for(const other of homes.slice(index+1))if(within(root,other)||within(other,root))throw new Error('Linux Agent homes overlap');}
      const protectedRoots=[...executionProtectedPaths(projectRoot,state,agentsDir,config.runtime.docker),...(verifiedWorkspaces?.protectedPaths??[])],privateBase=new Set(pathVariants(agentsDir));
      const privateForbidden=protectedRoots.filter(root=>!privateBase.has(root));for(const root of Object.values(this.memoryRoots))canonicalRoot(root,privateForbidden);
      const sharedProfiles:typeof config.runtime.workspaceGrants=[];
      if(config.runtime.sharedRoot){
        const shared=canonicalRoot(config.runtime.sharedRoot,[...protectedRoots,...Object.values(this.memoryRoots)]),stat=lstatSync(shared);
        if((process.platform==='linux'&&stat.uid!==0)||(stat.mode&0o022)||(stat.mode&0o005)!==0o005)throw new Error('Shared root must be root-owned and readable, not writable, by Agents');
        for(const [agentId,user] of Object.entries(config.runtime.linuxUsers??{})){
          const own=join(shared,agentId);
          if(!existsSync(own)){mkdirSync(own,{mode:0o755});chmodSync(own,0o755);chownSync(own,user.uid,user.gid);}
          const ownStat=lstatSync(own);
          if(!ownStat.isDirectory()||ownStat.uid!==user.uid||ownStat.gid!==user.gid||(ownStat.mode&0o777)!==0o755)throw new Error(`Shared Agent directory must be owned by its user and peer-readable: ${agentId}`);
          sharedProfiles.push({agentId,root:shared,operations:['read'],label:'shared'},{agentId,root:own,operations:['read','write','exec'],label:'shared-own'});
        }
      }
      const profiles=workspaceProfiles(this.memoryRoots,normalizeConfiguredWorkspaces([...config.runtime.workspaceGrants,...sharedProfiles],[...protectedRoots,...(config.runtime.linuxUsers?Object.values(this.memoryRoots):[])]),!!(config.runtime.docker||config.runtime.linuxUsers),verifiedWorkspaces?.capacityByRoot);
      const linuxBackend=config.runtime.linuxUsers?new LinuxUserBackend(config.runtime.linuxUsers):undefined;
      const linuxProcesses=config.runtime.linuxUsers?new LinuxProcessManager(Object.fromEntries(Object.entries(config.runtime.linuxUsers).map(([agentId,user])=>[agentId,user.uid]))):undefined;
      const rawFiles:ExecutionBackend=linuxBackend??(this.container&&process.platform==='linux'?this.container:new SandboxBackend()),rawCommands:ExecutionBackend=linuxBackend??this.container??{ execute: async () => { throw new Error('Execution backend is not configured'); } };
      const files=verifiedWorkspaces?new DeploymentBoundaryBackend(rawFiles,config,deploymentEnvironment,verifiedWorkspaces):rawFiles,commands=verifiedWorkspaces?new DeploymentBoundaryBackend(rawCommands,config,deploymentEnvironment,verifiedWorkspaces):rawCommands;
      const backendAdmission=new FairAdmission(config.runtime.limits.maxBackendOperations),admittedFiles=new AdmittedBackend(files,backendAdmission);
      this.backend = new AdmittedBackend(new ControlledBackend(files,commands),backendAdmission);
      this.broker = new Broker(this.store, this.collaboration, this.backend, privateForbidden,Date.now,!linuxBackend,config.runtime.linuxUsers?this.memoryRoots:{});
      const workspaceAccess=this.workspaceAccess=new WorkspaceAccess(this.collaboration,this.broker,profiles,!!linuxBackend);
      const research = new Research(config.runtime.researchHosts);
      let artifacts!: Artifacts;
      const attachments=transport?new Attachments(this.collaboration,this.broker,transport.clients):undefined;
      const environment=new EnvironmentCapabilities(this.collaboration,this.broker,profiles,{image:config.runtime.docker?.image??null,network:linuxBackend?'host':config.runtime.docker?.network??'none',linuxUser:!!linuxBackend,researchHosts:config.runtime.researchHosts,attachmentConfigured:actor=>attachments?.configured(actor)??false,artifactConfigured:actor=>artifacts?.configured(actor)??false,artifactSupported:(actor,target)=>artifacts?.supports(actor,target)??false});
      const router = new ToolRouter(this.collaboration, this.broker, { attachment:(...args)=>{if(!attachments)throw new Error('Attachment adapter unavailable');return attachments.save(...args);},environment:(run,workId)=>environment.read(run,workId),...(linuxProcesses?{processes:linuxProcesses}:{}),system:this.system,research: (url, signal) => research.read(url, signal), publish: (...args) => artifacts.publish(...args) }, new TeamDirectory(messages,transport?new Directory(messages,transport.clients,transport.mapper):undefined), (actor,workId)=>workspaceAccess.provision(actor,workId),value=>slackApp?.argumentsCodec.args(value)??value,transport?new SlackHistory(messages,transport):undefined);
      this.supervisor = new Supervisor(this.collaboration, router, c, undefined, async (agentId, workId, signal) => {
        workspaceAccess.provision(agentId, workId);
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
    for(const dir of ['notes','artifacts']){const path=join(root,dir);if(lstatSync(path).isSymbolicLink()||readdirSync(path).length)throw new Error('Review workspace contains prior material');}
    const memory=join(root,'MEMORY.md');if(lstatSync(memory).isSymbolicLink()||lstatSync(memory).nlink!==1||readFileSync(memory,'utf8')!==`# ${agent.name}\n\nPrivate memory entry. Keep durable lessons and links to notes here.\n`)throw new Error('Review memory contains prior material');
    return root;
  }
  start(): Promise<void> {
    if(!this.startPromise){this.opening=this.open();this.startPromise=this.opening.catch(async error=>{await this.close();throw error;});}
    return this.startPromise;
  }
  private async open(): Promise<void> {
    if (this.stopping) return;
    if(this.managedWorkspaceBoundary)verifyDeploymentWorkspaces(this.config,this.deploymentEnvironment);
    if(this.container){const roots=this.containerProbeRoots.length?this.containerProbeRoots:[Object.values(this.memoryRoots)[0]!];if(!roots[0])throw new Error('Container probe requires an Agent workspace');for(const root of roots)await this.container.probe(root);}if(this.stopping)return;
    this.store.recover();this.system.recover();this.adapter?.recover();this.supervisor.recoverSessions();
    const models=builtinModels();for(const agent of this.config.mate.agents){requireSecret(process.env,agent.model.apiKeyEnv);if(!models.getModel(agent.model.provider,agent.model.id))throw new Error(`Unknown provider/model for ${agent.id}`);}
    const slackConfig=slackRuntimeConfig(this.config);if(slackConfig&&this.slackRuntime)this.slackRuntime.transport.configure(Object.fromEntries(slackConfig.agents.map(agent=>[agent.id,requireSecret(process.env,agent.botTokenEnv)])));
    await this.adapter?.start(this.abort.signal);if(this.stopping)return;
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
      // A failed adapter close must not bypass execution cleanup or release the lock early.
      await settle(()=>this.container?.recover());
    }finally{try{this.store.close();}finally{this.release();}}
    if(failures.length)throw new AggregateError(failures,'Daemon cleanup failed after draining owned work');
  }
}
