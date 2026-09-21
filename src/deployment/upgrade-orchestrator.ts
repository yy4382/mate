import {randomUUID,createHash} from 'node:crypto';
import {chownSync,chmodSync,readdirSync,closeSync,constants,fchmodSync,fchownSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,renameSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {daemonConfigSchema,type DaemonConfig} from '../daemon/config.js';
import {acquireLock} from '../daemon/lock.js';
import type {CheckpointIdentity} from '../daemon/checkpoint-format.js';
import {verifyRelease} from './release.js';
import {syncPayloadTree} from './installer.js';
import {upgradePaths,type UpgradePaths} from './upgrade-layout.js';
import {parseRootUpgrade,readRootUpgrade,rootUpgradePath,type RootUpgrade,assertConfigurationTopology,configurationIdentity,deploymentJournalPath,parseDeploymentJournal,readDeploymentJournal,releaseIdentity,writeDeploymentJournal,type DeploymentJournal,type DeploymentTopology} from './upgrade.js';

export type UpgradeCommand='candidate'|'resume'|'rollback'|'activate'|'finalize'|'fix-forward';
export interface UpgradeHost{
 uid:number;gid:number;serviceUid:number;serviceGid:number;
 stop():Promise<void>;start():Promise<void>;active():boolean;
 checkpoint(kind:'rollback'|'candidate',state:RootUpgrade):Promise<CheckpointIdentity>;
 migrate(state:RootUpgrade,journal:DeploymentJournal):Promise<void>;
 probe(state:RootUpgrade):Promise<void>;
 restore(state:RootUpgrade):Promise<void>;
 finishRestore(state:RootUpgrade):Promise<void>;
 /** Root holds the daemon lock; inspect only, never create or migrate the DB. */
 databaseEvidence(journal:Pick<DeploymentJournal,'topology'|'attempt'>):{marker:boolean;configurationHash:string};
 topology(config:DaemonConfig):DeploymentTopology;
 replaceAttempt(journal:DeploymentJournal):void;
 boundary?(name:string):void;
}
function present(path:string):boolean{try{lstatSync(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
function syncDir(path:string):void{const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY);try{fsyncSync(fd);}finally{closeSync(fd);}}
function bytes(path:string,uid:number):Buffer{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==uid||(s.mode&0o022))throw new Error(`Unprotected upgrade input: ${path}`);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{return readFileSync(fd);}finally{closeSync(fd);}}
function atomic(path:string,content:string,host:UpgradeHost,label:string):void{
 const temp=join(dirname(path),`.upgrade-${randomUUID()}`),fd=openSync(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o640);
 try{writeFileSync(fd,content);fchownSync(fd,host.uid,host.serviceGid);fchmodSync(fd,0o640);fsyncSync(fd);}finally{closeSync(fd);}
 host.boundary?.(`${label}:file-sync`);renameSync(temp,path);host.boundary?.(`${label}:rename`);syncDir(dirname(path));host.boundary?.(`${label}:directory-sync`);
}
function write(state:RootUpgrade,paths:UpgradePaths,host:UpgradeHost):RootUpgrade{parseRootUpgrade(state);atomic(rootUpgradePath(paths.data),`${JSON.stringify(state,null,2)}\n`,host,'root-journal');return state;}
function journalFor(state:RootUpgrade):DeploymentJournal{return parseDeploymentJournal({version:1,upgradeId:state.upgradeId,attempt:{id:state.attemptId,previous:state.previous},phase:state.mode==='candidate'?'preparing':'fix-forward',everActivated:state.mode==='fix-forward',old:state.old,next:state.next,topology:state.topology,checkpoints:{rollback:state.rollback,...(state.candidate?{candidate:state.candidate}:{})}});}
function configFrom(path:string,host:UpgradeHost):DaemonConfig{return daemonConfigSchema.parse(JSON.parse(bytes(path,host.uid).toString('utf8')));}
function ensureDirectory(path:string,uid:number):void{const stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(path)!==resolve(path)||stat.uid!==uid||(stat.mode&0o022))throw new Error(`Unsafe upgrade directory: ${path}`);}
async function protectedRelease(path:string,host:UpgradeHost,id?:string){ensureDirectory(path,host.uid);const manifest=await verifyRelease(path,id);bytes(join(path,'RELEASE.json'),host.uid);for(const entry of manifest.inventory){const s=lstatSync(join(path,entry.path));if(s.uid!==host.uid||(entry.type!=='symlink'&&(s.mode&0o022)))throw new Error('Release is writable by another principal');}return manifest;}
function sourceConfig(state:RootUpgrade,paths:UpgradePaths,host:UpgradeHost):void{const raw=bytes(paths.stagedConfig,host.uid),stat=lstatSync(paths.stagedConfig);if(stat.dev!==state.source.config.device||stat.ino!==state.source.config.inode||createHash('sha256').update(raw).digest('hex')!==state.source.config.sha256)throw new Error('Staged configuration was replaced');}
async function sourceRelease(state:RootUpgrade,paths:UpgradePaths,host:UpgradeHost):Promise<void>{
 const location=present(paths.stagedRelease)?paths.stagedRelease:state.next.releasePath,stat=lstatSync(location);
 if(stat.dev!==state.source.releaseDevice||stat.ino!==state.source.releaseInode)throw new Error('Staged release was replaced');await protectedRelease(location,host,state.next.releaseId);
}
function linkedRelease(path:string,host:UpgradeHost,label:string):string{const stat=lstatSync(path);if(!stat.isSymbolicLink()||stat.uid!==host.uid)throw new Error(`${label} must be a root-owned release symlink`);return realpathSync(path);}
function currentIdentity(paths:UpgradePaths,host:UpgradeHost):string{return linkedRelease(paths.current,host,'Current');}
function publishConfig(config:DaemonConfig,allowed:readonly string[],paths:UpgradePaths,host:UpgradeHost,label:string):void{const current=configFrom(paths.config,host);if(!allowed.includes(configurationIdentity(current)))throw new Error('Published configuration is outside the upgrade transaction');atomic(paths.config,`${JSON.stringify(config,null,2)}\n`,host,label);}
function publishCurrent(next:string,allowed:readonly string[],paths:UpgradePaths,host:UpgradeHost,label:string):void{if(!allowed.includes(currentIdentity(paths,host)))throw new Error('Published current release is outside the upgrade transaction');const temp=join(dirname(paths.current),`.current-${randomUUID()}`);symlinkSync(next,temp);host.boundary?.(`${label}:symlink`);renameSync(temp,paths.current);host.boundary?.(`${label}:rename`);syncDir(dirname(paths.current));host.boundary?.(`${label}:directory-sync`);}
async function prepare(paths:UpgradePaths,host:UpgradeHost,previousJournal?:DeploymentJournal,oldConfig?:DaemonConfig):Promise<RootUpgrade>{
 const previousConfig=configFrom(paths.config,host),nextConfig=configFrom(paths.stagedConfig,host),previousPath=currentIdentity(paths,host),controllerPath=linkedRelease(paths.controller,host,'Recovery controller'),controllerRelease=await protectedRelease(controllerPath,host),nextRelease=await protectedRelease(paths.stagedRelease,host),previousRelease=previousJournal?undefined:await protectedRelease(previousPath,host);
 if(controllerRelease.recoveryProtocol!==nextRelease.recoveryProtocol)throw new Error('Candidate recovery protocol is incompatible with the trusted controller');
 const topology=previousJournal?.topology??host.topology(previousConfig);assertConfigurationTopology(previousConfig,topology);assertConfigurationTopology(nextConfig,topology);
 const old=previousJournal?.old??releaseIdentity(previousConfig,previousPath,previousRelease!.releaseId),previous=releaseIdentity(previousConfig,previousPath,previousJournal?.next.releaseId??previousRelease!.releaseId),next=releaseIdentity(nextConfig,join(paths.releases,nextRelease.releaseId),nextRelease.releaseId),controller=releaseIdentity(oldConfig??previousConfig,controllerPath,controllerRelease.releaseId);
 if(previous.configurationHash===next.configurationHash&&previous.releaseId===next.releaseId)throw new Error('Upgrade does not describe a change');
 if(previousJournal&&JSON.stringify(previous)!==JSON.stringify(previousJournal.next))throw new Error('Fix-forward must begin at the published active candidate');
 if(!previousJournal&&JSON.stringify(controller)!==JSON.stringify(previous))throw new Error('Initial upgrade controller must match the active release');
 const source=lstatSync(paths.stagedRelease),config=lstatSync(paths.stagedConfig),state:RootUpgrade={version:1,upgradeId:previousJournal?.upgradeId??randomUUID(),attemptId:randomUUID(),step:'prepared',mode:previousJournal?'fix-forward':'candidate',oldConfig:oldConfig??previousConfig,previousConfig,nextConfig,old,previous,next,controller,topology,source:{releaseDevice:source.dev,releaseInode:source.ino,config:{device:config.dev,inode:config.ino,sha256:createHash('sha256').update(bytes(paths.stagedConfig,host.uid)).digest('hex')}},...(previousJournal?{rollback:previousJournal.checkpoints.rollback}: {})};
 return write(state,paths,host);
}
function deploymentWrite(journal:DeploymentJournal,paths:UpgradePaths,host:UpgradeHost):void{writeDeploymentJournal(deploymentJournalPath(paths.data),journal,{uid:host.uid,gid:host.serviceGid});host.boundary?.('deployment-journal');}
function cleanup(paths:UpgradePaths,host:UpgradeHost):void{
 // The remaining root journal fails closed until both durable removals finish.
 if(present(deploymentJournalPath(paths.data)))unlinkSync(deploymentJournalPath(paths.data));syncDir(dirname(deploymentJournalPath(paths.data)));host.boundary?.('cleanup:deployment');
 if(present(rootUpgradePath(paths.data)))unlinkSync(rootUpgradePath(paths.data));syncDir(dirname(rootUpgradePath(paths.data)));host.boundary?.('cleanup:root');
}
function publishController(next:string,allowed:readonly string[],paths:UpgradePaths,host:UpgradeHost):void{if(!allowed.includes(linkedRelease(paths.controller,host,'Recovery controller')))throw new Error('Recovery controller is outside the upgrade transaction');const temp=join(dirname(paths.controller),`.controller-${randomUUID()}`);symlinkSync(next,temp);host.boundary?.('controller:symlink');renameSync(temp,paths.controller);host.boundary?.('controller:rename');syncDir(dirname(paths.controller));host.boundary?.('controller:directory-sync');}

/** Root-only orchestration. Host seams perform the existing service-user maintenance boundaries. */
export async function runUpgrade(command:UpgradeCommand,host:UpgradeHost,paths:UpgradePaths=upgradePaths):Promise<void>{
 if(host.uid!==0&&!process.env.VITEST)throw new Error('Upgrade orchestration requires root');
 for(const path of [dirname(paths.config),dirname(paths.current),paths.releases])ensureDirectory(path,host.uid);
 ensureDirectory(join(paths.data,'control'),host.serviceUid);
 const unlock=acquireLock(join(dirname(paths.config),'upgrade.lock'));
 try{
  let state=readRootUpgrade(paths.data,host.uid),journal=readDeploymentJournal(paths.data,{requiredOwnerUid:host.uid,requiredOwnerGid:host.serviceGid});
  if(command==='candidate'){
   if(journal||state)throw new Error('Upgrade already in progress; use resume');state=await prepare(paths,host);
  }else if(command==='fix-forward'){
   if(!journal?.everActivated)throw new Error('Fix-forward requires an activated upgrade');
   let preparationJournal=journal;
   if(state&&state.step!=='activated'&&state.step!=='checked'){
    if(journal.phase!=='fix-forward')throw new Error('Unfinished candidate must be resumed');await host.stop();
    const evidence=host.databaseEvidence(journal);
    if(!evidence.marker&&evidence.configurationHash===journal.attempt.previous.configurationHash)preparationJournal={...journal,next:journal.attempt.previous};
    else if(!evidence.marker||evidence.configurationHash!==journal.next.configurationHash||configurationIdentity(configFrom(paths.config,host))!==journal.next.configurationHash||currentIdentity(paths,host)!==journal.next.releasePath)throw new Error('Cannot replace committed or unproven fix-forward attempt; resume publication first');
   }
   const oldConfig=state?.oldConfig;state=await prepare(paths,host,preparationJournal,oldConfig);
  }
  if(!state)throw new Error('No resumable root upgrade transaction');
  if(state.topology.dataDir!==paths.data||[state.old,state.previous,state.next].some(identity=>dirname(identity.releasePath)!==paths.releases))throw new Error('Root upgrade paths escaped the fixed managed layout');
  if(journal&&(journal.upgradeId!==state.upgradeId||journal.topology.identity!==state.topology.identity||JSON.stringify(journal.old)!==JSON.stringify(state.old)))throw new Error('Root and deployment upgrade identities disagree');
  if(command==='rollback'&&!journal&&['prepared','checkpoint'].includes(state.step)&&state.mode==='candidate'){
   await host.stop();const evidence=host.databaseEvidence({topology:state.topology,attempt:{id:state.attemptId,previous:state.previous}});
   if(evidence.marker||evidence.configurationHash!==state.old.configurationHash||configurationIdentity(configFrom(paths.config,host))!==state.old.configurationHash||currentIdentity(paths,host)!==state.old.releasePath)throw new Error('Cannot prove an untouched pre-migration candidate');cleanup(paths,host);return;
  }
  if(host.topology(configFrom(paths.config,host)).identity!==state.topology.identity)throw new Error('Live deployment topology changed');
  const advance=(step:RootUpgrade['step'])=>{state=write({...state!,step},paths,host);};
  const checkpoint=async(kind:'rollback'|'candidate')=>{
   const path=join(paths.checkpoints,`upgrade-${state!.upgradeId}-${kind}`),bound=state!.checkpointStages?.[kind];
   if(!present(path)){if(bound)throw new Error('Bound checkpoint directory disappeared');mkdirSync(path,{mode:0o700});chownSync(path,host.serviceUid,host.serviceGid);chmodSync(path,0o700);syncDir(paths.checkpoints);}
   const stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Invalid checkpoint staging directory');
   if(bound){if(stat.dev!==bound.device||stat.ino!==bound.inode)throw new Error('Checkpoint staging identity changed');}
   else{if(stat.uid!==host.serviceUid||stat.gid!==host.serviceGid||readdirSync(path).length)throw new Error('Cannot adopt nonempty checkpoint stage');state=write({...state!,checkpointStages:{...state!.checkpointStages,[kind]:{path,device:stat.dev,inode:stat.ino}}},paths,host);}
   return host.checkpoint(kind,state!);
  };
  if(!journal&&['old-current','finalizing'].includes(state.step)){
   const identity=state.step==='old-current'?state.old:state.next;
   if(configurationIdentity(configFrom(paths.config,host))!==identity.configurationHash||currentIdentity(paths,host)!==identity.releasePath)throw new Error('Upgrade cleanup identity mismatch');cleanup(paths,host);return;
  }
  if(command==='finalize'){
   if(!journal?.everActivated||!['activated','checked','finalizing'].includes(state.step)||!host.active())throw new Error('Finalize requires a successfully activated running candidate');
   if(configurationIdentity(configFrom(paths.config,host))!==journal.next.configurationHash||currentIdentity(paths,host)!==journal.next.releasePath)throw new Error('Finalize identity mismatch');await protectedRelease(journal.next.releasePath,host,journal.next.releaseId);if(state.step!=='finalizing')advance('finalizing');publishController(journal.next.releasePath,[state.controller.releasePath,journal.next.releasePath],paths,host);cleanup(paths,host);return;
  }
  if(command==='activate'){
   if(!journal||!['checked','activated'].includes(state.step))throw new Error('Candidate has not completed offline checks');
   if(configurationIdentity(configFrom(paths.config,host))!==journal.next.configurationHash||currentIdentity(paths,host)!==journal.next.releasePath)throw new Error('Activation identity mismatch');
   await protectedRelease(journal.next.releasePath,host,journal.next.releaseId);
   if(!journal.everActivated){journal=parseDeploymentJournal({...journal,phase:'activated',everActivated:true});deploymentWrite(journal,paths,host);}advance('activated');await host.start();host.boundary?.('service-start');return;
  }
  if(command==='rollback'||['rollback-checkpoint','rollback','restored','old-config','old-current'].includes(state.step)){
   if(journal?.everActivated||state.mode==='fix-forward')throw new Error('Activated upgrade is fix-forward only; checkpoint rollback is permanently denied');
   if(!journal)throw new Error('Resume checkpoint preparation before rollback');
   await host.stop();
   if(!['rollback-checkpoint','rollback','restored','old-config','old-current'].includes(state.step))advance('rollback-checkpoint');
   if(state.step==='rollback-checkpoint'){
    if(!state.rollbackConfig){const evidence=host.databaseEvidence(journal);const rollbackConfig=evidence.configurationHash===state.old.configurationHash?state.oldConfig:evidence.configurationHash===state.next.configurationHash?state.nextConfig:undefined;if(!rollbackConfig)throw new Error('Cannot identify current database for rollback checkpoint');state=write({...state,rollbackConfig},paths,host);}
    const candidate=await checkpoint('candidate');state=write({...state,candidate},paths,host);journal=parseDeploymentJournal({...journal,phase:'rollback',rollbackCurrent:configurationIdentity(state.rollbackConfig!)===state.old.configurationHash?state.old:state.next,checkpoints:{...journal.checkpoints,candidate:state.candidate}});deploymentWrite(journal,paths,host);advance('rollback');}
   if(state.step==='rollback'){await host.restore(state);host.boundary?.('restore');advance('restored');}
   if(state.step==='restored'){await host.finishRestore(state);publishConfig(state.oldConfig,[state.next.configurationHash,state.old.configurationHash],paths,host,'rollback-config');advance('old-config');}
   if(state.step==='old-config'){publishCurrent(state.old.releasePath,[state.next.releasePath,state.old.releasePath],paths,host,'rollback-current');advance('old-current');}
   cleanup(paths,host);return;
  }
  if(journal?.everActivated&&state.mode==='candidate'&&state.step==='checked'){advance('activated');return;}
  if(state.step==='finalizing'){
   if(!journal?.everActivated||!host.active())throw new Error('Finalization recovery requires the activated service');
   if(configurationIdentity(configFrom(paths.config,host))!==journal.next.configurationHash||currentIdentity(paths,host)!==journal.next.releasePath)throw new Error('Finalize identity mismatch');await protectedRelease(journal.next.releasePath,host,journal.next.releaseId);publishController(journal.next.releasePath,[state.controller.releasePath,journal.next.releasePath],paths,host);cleanup(paths,host);return;
  }
  if(state.step==='activated')return;
  await host.stop();host.boundary?.('service-stop');if(host.active())throw new Error('Service is still active');
  if(['prepared','checkpoint','journal'].includes(state.step)){sourceConfig(state,paths,host);await sourceRelease(state,paths,host);}else await protectedRelease(state.next.releasePath,host,state.next.releaseId);
  if(state.step==='prepared'){if(!state.rollback){const rollback=await checkpoint('rollback');state=write({...state,rollback},paths,host);}advance('checkpoint');}
  if(state.step==='checkpoint'){const previous=journal;journal=journalFor(state);if(previous&&previous.attempt.id!==journal.attempt.id&&JSON.stringify(previous.next)!==JSON.stringify(journal.attempt.previous))host.replaceAttempt(journal);else deploymentWrite(journal,paths,host);advance('journal');}
  journal=readDeploymentJournal(paths.data,{requiredOwnerUid:host.uid,requiredOwnerGid:host.serviceGid});if(!journal||journal.attempt.id!==state.attemptId)throw new Error('Root and deployment journals disagree');
  if(state.step==='journal'){
   if(present(paths.stagedRelease)){if(present(state.next.releasePath)){await protectedRelease(state.next.releasePath,host,state.next.releaseId);}else{syncPayloadTree(paths.stagedRelease);renameSync(paths.stagedRelease,state.next.releasePath);host.boundary?.('release:rename');syncDir(paths.releases);syncDir(dirname(paths.stagedRelease));host.boundary?.('release:directory-sync');}}syncDir(paths.releases);syncDir(dirname(paths.stagedRelease));advance('release');
  }
  if(state.step==='release'){await host.migrate(state,journal);host.boundary?.('database-commit');advance('migrated');}
  if(state.step==='migrated'){publishConfig(state.nextConfig,[state.previous.configurationHash,state.next.configurationHash],paths,host,'config');advance('config');}
  if(state.step==='config'){publishCurrent(state.next.releasePath,[state.previous.releasePath,state.next.releasePath],paths,host,'current');advance('current');}
  if(state.step==='current'){if(!journal.everActivated){journal=parseDeploymentJournal({...journal,phase:'candidate'});deploymentWrite(journal,paths,host);}await host.probe(state);host.boundary?.('offline-checks');advance('checked');}
 }finally{unlock();}
}

export {readRootUpgrade,rootUpgradePath} from './upgrade.js';
export {upgradePaths} from './upgrade-layout.js';
export type {UpgradePaths} from './upgrade-layout.js';
export type {RootUpgrade} from './upgrade.js';
