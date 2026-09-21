import {realpathSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {acquireLock} from '../daemon/lock.js';
import {Store} from '../storage/store.js';
import {backupDeploymentSnapshot} from '../daemon/backup.js';
import {applyOfflineConfigurationMigration} from '../daemon/migrate.js';
import {restoreDeploymentCheckpoint,finishDeploymentRestoreCheckpoint} from '../daemon/restore.js';
import {assertDockerControlIsolation,executionScope} from '../daemon/paths.js';
import {ContainerBackend} from '../execution/container.js';
import {verifyDeploymentWorkspaces} from './runtime.js';
import {runDoctor} from './doctor.js';
import {runOfflineProbe} from './probe.js';
import {readRootUpgrade} from './upgrade.js';
import {upgradePaths,upgradeCheckpointPath} from './upgrade-layout.js';
import {assertConfigurationTopology,deploymentMigrationAttempt,readDeploymentJournal} from './upgrade.js';
import {verifyRelease} from './release.js';
import {assertNoRestoreInProgress} from '../daemon/restore.js';

/** Fixed-command, service-user entry. Deliberately has no Daemon, Slack or provider transport construction. */
export async function upgradeHelper(action:string,releaseRoot:string):Promise<void>{
 if(!['checkpoint-rollback','checkpoint-candidate','migrate','probe','restore','finish-restore'].includes(action))throw new Error('Unknown upgrade helper operation');
 const state=readRootUpgrade(upgradePaths.data);if(!state)throw new Error('Root upgrade journal required');
 const recoveryAction=['checkpoint-rollback','checkpoint-candidate','restore','finish-restore'].includes(action),identity=recoveryAction?state.controller:state.next;if(realpathSync(releaseRoot)!==identity.releasePath)throw new Error('Upgrade helper release mismatch');await verifyRelease(releaseRoot,identity.releaseId);
 const config=action==='checkpoint-rollback'?state.previousConfig:action==='checkpoint-candidate'?state.rollbackConfig??state.nextConfig:state.nextConfig;
 const journal=readDeploymentJournal(upgradePaths.data,{requiredOwnerUid:0,requiredOwnerGid:process.getgid?.()??-1});
 if(action!=='checkpoint-rollback'&&(!journal||journal.upgradeId!==state.upgradeId||journal.attempt.id!==state.attemptId))throw new Error('Upgrade helper journal identity mismatch');
 if(action==='checkpoint-rollback'&&state.step!=='prepared'||action==='migrate'&&state.step!=='release'||action==='probe'&&state.step!=='current'||action==='checkpoint-candidate'&&state.step!=='rollback-checkpoint'||action==='restore'&&state.step!=='rollback'||action==='finish-restore'&&state.step!=='restored')throw new Error('Upgrade helper operation does not match durable phase');
 if(action==='finish-restore'){await finishDeploymentRestoreCheckpoint(state.oldConfig,state.rollbackConfig??state.nextConfig);return;}
 if(action==='restore'){await restoreDeploymentCheckpoint(state.oldConfig,state.rollbackConfig??state.nextConfig,{projectRoot:releaseRoot});return;}
 await assertNoRestoreInProgress(config.runtime.dataDir);
 if(action==='probe'){
  const report=await runDoctor(config,undefined,{releaseRoot,requireSecrets:false});if(!report.healthy)throw new Error(`Candidate doctor failed: ${report.checks.filter(c=>c.status==='fail').map(c=>c.name).join(', ')}`);
  await runOfflineProbe(config,releaseRoot);return;
 }
 const data=config.runtime.dataDir,unlock=acquireLock(join(data,'state','daemon.lock'));let store:Store|undefined;
 try{
  assertDockerControlIsolation(releaseRoot,join(data,'state'),join(data,'agents'),config.runtime.workspaceGrants,config.runtime.docker,[config.runtime.workspaceManifest!]);
  const workspaces=verifyDeploymentWorkspaces(config);if(!workspaces)throw new Error('Managed workspace boundary unavailable');
  if(journal)assertConfigurationTopology(config,journal.topology);
  const backend=new ContainerBackend({...config.runtime.docker!,scope:executionScope(data)});await backend.recover();
  if(action==='migrate'){store=new Store(join(data,'state','mate.sqlite'));store.recover();applyOfflineConfigurationMigration(store,state.previousConfig,state.nextConfig,{projectRoot:releaseRoot,verifiedWorkspaces:workspaces,legacyIdentityAttested:false,auditSource:'deployment_upgrade',deployment:deploymentMigrationAttempt(journal!,state.previousConfig,state.nextConfig)});}
  else await backupDeploymentSnapshot(data,upgradeCheckpointPath(state.upgradeId,action==='checkpoint-rollback'?'rollback':'candidate'),config);
 }finally{store?.close();unlock();}
}
if(process.argv[1]&&pathToFileURL(realpathSync(process.argv[1])).href===import.meta.url){
 if(process.argv.length!==3)throw new Error('Usage: upgrade-helper OPERATION');
 upgradeHelper(process.argv[2]!,dirname(dirname(dirname(dirname(realpathSync(process.argv[1])))))).catch(error=>{process.stderr.write(`${error instanceof Error?error.message:'Offline upgrade failed'}\n`);process.exitCode=1;});
}
