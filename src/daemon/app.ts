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
import {TeamDirectory} from '../conversations/team-directory.js';
import {migrateInternalConversations} from '../storage/internal-schema.js';
import { migrateCanonicalConversations } from '../slack/canonical-migration.js';
import { slackApplication } from '../slack/application.js';

import { CanonicalOutput as Output } from '../conversations/output.js';
import { storedConfiguration,saveConfiguration } from './migrate.js';
import {Attachments}from '../slack/attachments.js';
import { Directory } from '../slack/directory.js';
import { mkdirSync, writeFileSync, existsSync, realpathSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
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
import { canonicalRoot, within } from '../execution/paths.js';
import { Supervisor } from '../runtime/supervisor.js';
import { ToolRouter } from '../runtime/tools.js';
import { acquireLock } from './lock.js';
import { Controls } from './control.js';
import { Research } from './research.js';
import { Artifacts } from './artifacts.js';
import {EnvironmentCapabilities} from '../capabilities/environment.js';
import {normalizeConfiguredWorkspaces,workspaceProfiles,WorkspaceAccess} from '../capabilities/workspaces.js';
import { executionScope } from './paths.js';
import { backup } from './backup.js';
export interface Log { info(data: object, message: string): void; error(data: object, message: string): void }
export class Daemon {
  readonly store: Store;
  readonly collaboration: Collaboration;
  readonly broker: Broker;
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
  private readonly abort=new AbortController();
  private background?:Promise<void>;
  private opening?:Promise<void>;
  private stopping = false;
  private paused = false;
  private runs = new Set<Promise<unknown>>();
  private loopPromise?: Promise<void>;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  readonly config:DaemonConfig;
  constructor(input: unknown, readonly log: Log, readonly projectRoot = resolve('.')) {
    const config=this.config=daemonConfigSchema.parse(input);
    const slackConfig=slackRuntimeConfig(config);
    const data = config.runtime.dataDir;
    mkdirSync(data, { recursive: true, mode: 0o700 });
    if (lstatSync(data).isSymbolicLink() || within(realpathSync(projectRoot), realpathSync(data))) throw new Error('Data directory must be outside the application checkout and not a symlink');
    const state = join(data, 'state'); mkdirSync(state, { recursive: true, mode: 0o700 });
    if (lstatSync(state).isSymbolicLink()) throw new Error('State path must not be a symlink');
    this.release = acquireLock(join(state, 'daemon.lock'));
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
      migrateInternalConversations(this.store);migrateProjections(this.store);migrateProjectionImports(this.store);migrateHistoryIndexes(this.store);migrateCoordinationRecovery(this.store);migrateOperationsView(this.store);
      const slackApp=slackConfig?slackApplication(this.store,slackConfig,c):undefined;
      const messages=slackApp?.messages??localConversations(this.store,c);
      messages.writes.assertFormat();
      const transport=slackApp&&slackConfig?new WebSlackTransport(this.store,slackApp.mapper,Object.fromEntries(slackConfig.agents.map(a=>[a.id,requireSecret(process.env,a.botTokenEnv)]))):undefined;
      const output=new Output(messages,transport??{post:async()=>{throw new Error('External transport unavailable');},pendingInput:()=>false,classify:()=>({kind:'rejected',reason:'External transport unavailable'})});
      this.collaboration = new Collaboration(this.store, messages, output, c);
      const agentsDir = join(data, 'agents'); mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
      if (lstatSync(agentsDir).isSymbolicLink()) throw new Error('Agents directory must not be a symlink');
      for (const agent of this.collaboration.agents.list()) {
        const root = join(data, 'agents', agent.id); mkdirSync(root, { recursive: true, mode: 0o700 });
        if (lstatSync(root).isSymbolicLink()) throw new Error('Agent memory must not be a symlink');
        this.memoryRoots[agent.id] = canonicalRoot(root, [projectRoot, state]);
        for (const dir of ['notes','artifacts']) mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
        if (!existsSync(join(root, 'MEMORY.md'))) writeFileSync(join(root, 'MEMORY.md'), `# ${agent.name}\n\nPrivate memory entry. Keep durable lessons and links to notes here.\n`, { flag: 'wx', mode: 0o600 });
      }
      const profiles=workspaceProfiles(this.memoryRoots,normalizeConfiguredWorkspaces(config.runtime.workspaceGrants,[projectRoot,state,agentsDir]),!!config.runtime.docker);
      const files = new SandboxBackend();
      if (config.runtime.docker) this.container = new ContainerBackend({ ...config.runtime.docker, scope: executionScope(data) });
      this.backend = new ControlledBackend(files, this.container ?? { execute: async () => { throw new Error('Container execution is not configured'); } });
      this.broker = new Broker(this.store, this.collaboration, this.backend, [projectRoot, state]);
      const workspaceAccess=this.workspaceAccess=new WorkspaceAccess(this.collaboration,this.broker,profiles);
      const research = new Research(config.runtime.researchHosts);
      let artifacts!: Artifacts;
      const attachments=transport?new Attachments(this.collaboration,this.broker,transport.clients):undefined;
      const environment=new EnvironmentCapabilities(this.collaboration,this.broker,profiles,{image:config.runtime.docker?.image??null,network:config.runtime.docker?.network??'none',researchHosts:config.runtime.researchHosts,attachmentConfigured:actor=>attachments?.configured(actor)??false,artifactConfigured:actor=>artifacts?.configured(actor)??false,artifactSupported:(actor,target)=>artifacts?.supports(actor,target)??false});
      const router = new ToolRouter(this.collaboration, this.broker, { attachment:(...args)=>{if(!attachments)throw new Error('Attachment adapter unavailable');return attachments.save(...args);},environment:(run,workId)=>environment.read(run,workId),research: (url, signal) => research.read(url, signal), publish: (...args) => artifacts.publish(...args) }, new TeamDirectory(messages,transport?new Directory(messages,transport.clients,transport.mapper):undefined), (actor,workId)=>workspaceAccess.provision(actor,workId),value=>slackApp?.argumentsCodec.args(value)??value,transport?new SlackHistory(messages,transport):undefined);
      this.supervisor = new Supervisor(this.collaboration, router, c, undefined, async (agentId, workId, signal) => {
        workspaceAccess.provision(agentId, workId);
        const result = await files.execute({ root: this.memoryRoots[agentId]!, operation: { kind: 'read', path: 'MEMORY.md' }, timeoutMs: 10000 }, signal);
        if (result.code !== 0 || result.truncated) throw new Error('Private memory recovery read failed'); return result.stdout;
      });
      this.supervisor.register();
      this.controls=new Controls(this.collaboration,this.supervisor,this.broker,actor=>this.verifyReviewWorkspace(actor),(user,command,id,args)=>this.slackRuntime?.projections.control(user,command,id,args));
      this.adapter=this.slackRuntime=transport?new SlackRuntime(this.collaboration,transport,this.controls,message=>this.log.error({},message)):undefined;
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
    const models = builtinModels();
    for (const agent of this.config.mate.agents) { requireSecret(process.env, agent.model.apiKeyEnv); if (!models.getModel(agent.model.provider, agent.model.id)) throw new Error(`Unknown provider/model for ${agent.id}`); }
    await this.container?.recover(); if (this.stopping) return;
    this.store.recover();this.adapter?.recover();this.supervisor.recoverSessions();
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
  async checkpoint(destination: string): Promise<void> {
    this.paused = true;
    try { await this.background;await Promise.allSettled([...this.runs]); await this.supervisor.drain(); await backup(this.store, this.config.runtime.dataDir, destination); }
    finally { this.paused = false; }
  }
  close(): Promise<void> { return this.closePromise ??= this.shutdown(); }
  private async shutdown(): Promise<void> {
    this.stopping=true;this.abort.abort();
    const failures:unknown[]=[];
    const settle=async(action:()=>unknown)=>{try{await action();}catch(error){failures.push(error);}};
    try{
      await settle(()=>this.supervisor.close());await settle(()=>this.adapter?.close());
      await settle(()=>this.opening?.catch(()=>{}));await settle(()=>this.loopPromise);await settle(()=>this.background);
      await Promise.allSettled([...this.runs]);await settle(()=>this.supervisor.drain());
      // A failed adapter close must not bypass execution cleanup or release the lock early.
      await settle(()=>this.container?.recover());
    }finally{try{this.store.close();}finally{this.release();}}
    if(failures.length)throw new AggregateError(failures,'Daemon cleanup failed after draining owned work');
  }
}
