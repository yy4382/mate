import {LocalConsole} from './local/console.js';
import { migrateConfiguration } from './daemon/migrate.js';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { daemonConfigSchema } from './daemon/config.js';
import { Daemon } from './daemon/app.js';
import { acquireLock } from './daemon/lock.js';
import { Store, hash } from './storage/store.js';
import { ContainerBackend } from './execution/container.js';
import { assertDockerControlIsolation,executionScope } from './daemon/paths.js';
import { backup } from './daemon/backup.js';
import {restoreCheckpoint} from './daemon/restore.js';
import {sealCheckpointForService} from './daemon/checkpoint-format.js';
import {requiredSlackBotScopes} from './slack/protocol.js';
import {verifyDeploymentWorkspaces} from './deployment/runtime.js';
import {runDoctor} from './deployment/doctor.js';
import {runOfflineProbe} from './deployment/probe.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, configPath, destination] = args;
  if (command === 'models') { process.stdout.write(JSON.stringify(builtinModels().getModels(configPath).map(m => ({ provider: m.provider, id: m.id, contextWindow: m.contextWindow })), null, 2) + '\n'); return; }
  if (!['check','doctor','offline-probe','start','local','backup','restore','checkpoint-seal','migrate'].includes(command ?? '') || !configPath) throw new Error('Usage: mate check|doctor|offline-probe|start|local CONFIG; mate backup CONFIG DESTINATION; mate checkpoint-seal CONFIG CHECKPOINT SERVICE_UID SERVICE_GID; mate restore CONFIG BACKUP [--replace CURRENT_CHECKPOINT]; mate models [PROVIDER]');
  const config = daemonConfigSchema.parse(JSON.parse(readFileSync(resolve(configPath), 'utf8')));
  const releaseRoot=process.argv[1]?dirname(dirname(dirname(resolve(process.argv[1])))):resolve('.');
  if(command==='doctor'){
    if(destination&&destination!=='--allow-missing-secrets')throw new Error('Unknown doctor option');if(args[3])throw new Error('Unknown doctor option');
    const report=await runDoctor(config,undefined,{releaseRoot,requireSecrets:destination!=='--allow-missing-secrets'});process.stdout.write(`${JSON.stringify(report,null,2)}\n`);if(!report.healthy)process.exitCode=1;return;
  }
  if(command==='offline-probe'){
    if(destination)throw new Error('Unknown offline-probe option');const report=await runOfflineProbe(config,releaseRoot);process.stdout.write(`${JSON.stringify(report,null,2)}\n`);return;
  }
  if(command==='checkpoint-seal'){
    if(!destination||!/^\d+$/.test(args[3]??'')||!/^\d+$/.test(args[4]??'')||args[5])throw new Error('Usage: mate checkpoint-seal CONFIG CHECKPOINT SERVICE_UID SERVICE_GID');
    const serviceUid=Number(args[3]),serviceGid=Number(args[4]);if(!Number.isSafeInteger(serviceUid)||!Number.isSafeInteger(serviceGid))throw new Error('Service uid/gid must be safe integers');
    const data=lstatSync(resolve(config.runtime.dataDir));if(!data.isDirectory()||data.isSymbolicLink())throw new Error('Managed data directory must be a directory');
    if(data.uid!==serviceUid||data.gid!==serviceGid)throw new Error('Managed data directory owner does not match the deployment identity');
    const lockPath=join(config.runtime.dataDir,'state','daemon.lock'),lock=lstatSync(lockPath);if(!lock.isFile()||lock.isSymbolicLink()||lock.uid!==serviceUid||lock.gid!==serviceGid||(lock.mode&0o777)!==0o600)throw new Error('Managed daemon lock identity does not match the deployment identity');
    const release=acquireLock(lockPath);try{await sealCheckpointForService(destination,serviceUid,serviceGid);}finally{release();}process.stdout.write('Checkpoint sealed for managed restore.\n');return;
  }
  if(command==='migrate'){
    if(!destination||!args[3])throw new Error('Usage: mate migrate OLD_CONFIG NEW_CONFIG BACKUP [--accept-legacy-identity]');
    if(args[4]&&args[4]!=='--accept-legacy-identity')throw new Error('Unknown migration option');
    const next=daemonConfigSchema.parse(JSON.parse(readFileSync(resolve(destination),'utf8')));
    process.stdout.write(JSON.stringify(await migrateConfiguration(config,next,args[3],args[4]==='--accept-legacy-identity'),null,2)+'\n');return;
  }
  if (command === 'check') {
    const models = builtinModels();
    const report = config.mate.agents.map(a => ({ agent: a.id, modelKnown: !!models.getModel(a.model.provider, a.model.id), missingEnv: [a.model.apiKeyEnv,...(config.adapters.slack?.bindings.filter(b=>b.agentId===a.id).flatMap(b=>[b.botTokenEnv,b.appTokenEnv])??[])].filter(ref => !process.env[ref]) }));
    process.stdout.write(JSON.stringify({ checkScope: 'configuration_model_and_secret_references', externalConnectivityChecked: false,
      adapters: { slackConfigured: !!config.adapters.slack, localConfigured: !!config.adapters.local },
      requiredSlackBotScopes:config.adapters.slack?[...requiredSlackBotScopes]:[],agents: report, containerConfigured: !!config.runtime.docker,
      containerFileIsolation:process.platform==='linux'&&!!config.runtime.docker,workspaceManifest:config.runtime.workspaceManifest??null,containerResources:config.runtime.docker?.resources??null,runtimeLimits:config.runtime.limits }, null, 2) + '\n');
    if (report.some(r => !r.modelKnown || r.missingEnv.length)) process.exitCode = 1; return;
  }
  if (command === 'restore') {
    if (!destination) throw new Error('Backup directory required');
    if(args[3]&&args[3]!=='--replace')throw new Error('Unknown restore option');if(args[3]==='--replace'&&!args[4])throw new Error('Current checkpoint required after --replace');if(args[5])throw new Error('Unknown restore option');
    await restoreCheckpoint(config,destination,{...(args[4]?{currentCheckpoint:args[4]}:{})});
    process.stdout.write('Checkpoint restored; start performs fenced recovery before scheduling.\n'); return;
  }
  if (command === 'backup') {
    if (!destination) throw new Error('Backup destination required');
    const state=join(config.runtime.dataDir,'state'),agentsDir=join(config.runtime.dataDir,'agents'),release = acquireLock(join(state, 'daemon.lock'));let store:Store|undefined;
    try {
      assertDockerControlIsolation(resolve('.'),state,agentsDir,config.runtime.workspaceGrants,config.runtime.docker,config.runtime.workspaceManifest?[config.runtime.workspaceManifest]:[]);
      if (config.runtime.docker) await new ContainerBackend({ ...config.runtime.docker, scope: executionScope(config.runtime.dataDir) }).recover();
      verifyDeploymentWorkspaces(config);
      store=new Store(join(state, 'mate.sqlite'));
      store.recover(); await backup(store, config.runtime.dataDir, resolve(destination),config);
    } finally { store?.close(); release(); }
    process.stdout.write('Consistent database and memory checkpoint created.\n'); return;
  }
  const log = pino({ level: 'info', redact: ['token','apiKey','authorization','*.token','*.apiKey','*.authorization'] },pino.destination(2));
  const daemon = await Daemon.create(config, log);
  const consoleAbort=new AbortController();
  let closing: Promise<void> | undefined;
  const close = () => { consoleAbort.abort();closing ??= daemon.close(); return closing; };
  process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
  try {
    if(command==='local'&&!daemon.local)throw new Error('Configure adapters.local before using the local console');
    await daemon.start();
    if(command==='local'){await new LocalConsole(daemon.local!,daemon.controls).serve(process.stdin,process.stdout,consoleAbort.signal);await close();}
  } catch { await close(); throw new Error('Daemon startup failed; check installation identities, credentials and sandbox configuration'); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Mate failed'}\n`); process.exitCode = 1; });
