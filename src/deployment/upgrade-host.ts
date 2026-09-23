import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,readdirSync,statfsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import Database from 'better-sqlite3';
import {daemonConfigSchema} from '../daemon/config.js';
import {acquireLock} from '../daemon/lock.js';
import {resumeCheckpointSealForService,verifyCheckpoint,resetIncompleteCheckpoint} from '../daemon/checkpoint-format.js';
import {configurationIdentity,createDeploymentTopology,deploymentJournalPath,replaceUncommittedDeploymentAttempt,type DeploymentJournal,type RootUpgrade} from './upgrade.js';
import {workspaceManifestSchema} from './workspaces.js';
import {assertSafeUnitName,managedLayout,transientUnitProperties} from './systemd.js';
import {finalizeRetention,type UpgradeHost} from './upgrade-orchestrator.js';
import {upgradeCheckpointPath,upgradePaths} from './upgrade-layout.js';
import {currentReleaseRuntime} from './release.js';

function run(binary:string,args:readonly string[]):string{const r=spawnSync(binary,[...args],{encoding:'utf8',env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C.UTF-8'},maxBuffer:4*1024*1024});if(r.status!==0)throw new Error(`Upgrade command failed: ${binary} ${args[0]??''}`);return r.stdout.trim();}
export function isServiceReadyState(value:string):boolean{return value.trim()==='active';}
function active():boolean{const r=spawnSync('/usr/bin/systemctl',['show','--property=ActiveState','--value','mate.service'],{encoding:'utf8'});if(r.status!==0)throw new Error('Cannot inspect mate.service');return isServiceReadyState(r.stdout);}
function protectedFile(path:string):Buffer{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==0||(s.mode&0o022))throw new Error(`Unprotected deployment file: ${path}`);return readFileSync(path);}
const digest=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
interface CopyFootprint{bytes:number;inodes:number}
function copyFootprint(path:string,blockSize:number):CopyFootprint{const stat=lstatSync(path),own={bytes:Math.max(blockSize,Math.ceil(stat.size/blockSize)*blockSize),inodes:1};if(!stat.isDirectory())return own;return readdirSync(path).reduce((sum,name)=>{const child=copyFootprint(join(path,name),blockSize);return{bytes:sum.bytes+child.bytes,inodes:sum.inodes+child.inodes};},own);}
export function requiredUpgradeCheckpointBytes(snapshotBytes:number):number{if(!Number.isSafeInteger(snapshotBytes)||snapshotBytes<0)throw new Error('Invalid checkpoint size');return snapshotBytes*2+64*1024*1024;}
export function assertUpgradeCheckpointCapacity(snapshot:CopyFootprint,free:{bytes:number;inodes:number}):void{const required=requiredUpgradeCheckpointBytes(snapshot.bytes),inodes=snapshot.inodes*2+64;if(free.bytes<required||free.inodes<inodes)throw new Error(`Insufficient checkpoint capacity for candidate and rollback snapshots (${required} bytes and ${inodes} inodes required)`);}
export function checkpointPath(state:RootUpgrade,kind:'rollback'|'candidate'):string{return upgradeCheckpointPath(state.upgradeId,kind);}
export type UpgradeHelperAction='checkpoint-rollback'|'checkpoint-candidate'|'migrate'|'probe'|'restore'|'finish-restore';
export function upgradeHelperRelease(state:RootUpgrade,action:UpgradeHelperAction):string{return ['checkpoint-rollback','checkpoint-candidate','restore','finish-restore'].includes(action)?state.controller.releasePath:state.next.releasePath;}
function helper(state:RootUpgrade,action:UpgradeHelperAction,release=upgradeHelperRelease(state,action)):void{
 const checkpoint=['checkpoint-rollback','checkpoint-candidate'].includes(action)?[checkpointPath(state,action==='checkpoint-rollback'?'rollback':'candidate')]:[];
 const properties=transientUnitProperties(release,state.nextConfig.runtime.workspaceGrants.map(g=>g.root),{writablePaths:checkpoint});
 run('/usr/bin/systemd-run',[...properties,'/usr/bin/node',join(release,'dist/src/deployment/upgrade-helper.js'),action]);
}
function withDatabase<T>(journal:Pick<DeploymentJournal,'topology'>,fn:(db:Database.Database)=>T):T{
 const state=join(journal.topology.dataDir,'state'),lockPath=join(state,'daemon.lock'),stat=lstatSync(lockPath),mount=journal.topology.workspaceManifest.value.mounts[0]!;
 if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==mount.ownerUid||stat.gid!==mount.ownerGid)throw new Error('Deployment daemon lock owner changed');
 const unlock=acquireLock(lockPath);let db:Database.Database|undefined;try{const path=join(state,'mate.sqlite'),file=lstatSync(path);if(!file.isFile()||file.isSymbolicLink()||file.uid!==mount.ownerUid||file.gid!==mount.ownerGid)throw new Error('Deployment database owner changed');db=new Database(path,{readonly:true,fileMustExist:true});return fn(db);}finally{db?.close();unlock();}
}
export function nodeUpgradeHost():UpgradeHost{
 if(process.geteuid?.()!==0||process.platform!=='linux')throw new Error('Managed upgrades require root on Linux');
 const serviceUid=Number(run('/usr/bin/id',['-u','mate'])),serviceGid=Number(run('/usr/bin/id',['-g','mate']));if(!Number.isSafeInteger(serviceUid)||serviceUid<1||!Number.isSafeInteger(serviceGid)||serviceGid<1)throw new Error('Invalid mate service identity');
 const host:UpgradeHost={uid:0,gid:0,serviceUid,serviceGid,runtime:currentReleaseRuntime(),active,
  capacity:state=>{if(state.mode==='fix-forward')return;const filesystem=statfsSync(managedLayout.checkpoints,{bigint:true}),blockSize=Number(filesystem.bsize),database=join(state.topology.dataDir,'state','mate.sqlite'),privateRoots=state.topology.workspaceManifest.value.mounts.filter(m=>m.kind==='private').map(m=>m.root),items=[copyFootprint(database,blockSize),...privateRoots.map(path=>copyFootprint(path,blockSize))],snapshot=items.reduce((sum,item)=>({bytes:sum.bytes+item.bytes,inodes:sum.inodes+item.inodes}),{bytes:0,inodes:4});assertUpgradeCheckpointCapacity(snapshot,{bytes:Number(filesystem.bavail*filesystem.bsize),inodes:Number(filesystem.ffree)});},
  retention:(state,paths)=>finalizeRetention(state,paths,host),
  stop:async()=>{run('/usr/bin/systemctl',['stop','mate.service']);if(active())throw new Error('Mate service did not stop');},
  start:async()=>{run('/usr/bin/systemctl',['start','mate.service']);if(!active())throw new Error('Mate service did not start');},
  topology:config=>{
   const manifestPath=config.runtime.workspaceManifest!,manifestBytes=protectedFile(manifestPath),manifest=workspaceManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8'))),serviceBytes=protectedFile(managedLayout.service),match=serviceBytes.toString('utf8').match(/^MemoryMax=(\d+)M$/m);if(!match)throw new Error('Unsupported service memory contract');
   return createDeploymentTopology(config,{manifest,manifestPath,manifestSha256:digest(manifestBytes),service:{unitPath:managedLayout.service,sha256:digest(serviceBytes),memoryMaxMiB:Number(match[1])},mountUnits:manifest.mounts.map(m=>{const name=run('/usr/bin/systemd-escape',['--path','--suffix=mount',m.root]);assertSafeUnitName(name);const unitPath=join('/etc/systemd/system',name),backing=lstatSync(m.backingFile);return{root:m.root,backingFile:m.backingFile,backingDevice:backing.dev,backingInode:backing.ino,capacityBytes:m.capacityBytes,unitPath,sha256:digest(protectedFile(unitPath))};})});
  },
  databaseEvidence:journal=>withDatabase(journal,db=>{const marker=!!db.prepare('SELECT 1 FROM runtime_meta WHERE key=?').get(`deployment_upgrade_v1:${journal.attempt.id}`),row=db.prepare("SELECT value FROM runtime_meta WHERE key='configuration'").get() as {value:string}|undefined;if(!row)throw new Error('Persisted configuration missing');return{marker,configurationHash:configurationIdentity(daemonConfigSchema.parse(JSON.parse(row.value)))};}),
  replaceAttempt:journal=>withDatabase(journal,db=>replaceUncommittedDeploymentAttempt(deploymentJournalPath(journal.topology.dataDir),journal,db,{uid:0,gid:serviceGid})),
  checkpoint:async(kind,state)=>{
   const path=checkpointPath(state,kind),config=kind==='rollback'?state.previousConfig:state.rollbackConfig??state.nextConfig,bound=state.checkpointStages?.[kind];if(!bound||bound.path!==path||bound.device===undefined||bound.inode===undefined)throw new Error('Checkpoint lacks a durable staging identity');const identity={path:bound.path,device:bound.device,inode:bound.inode},current=lstatSync(path);if(current.dev!==identity.device||current.ino!==identity.inode)throw new Error('Checkpoint staging identity changed');
   const parent=lstatSync(dirname(path));if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==0||parent.gid!==serviceGid||(parent.mode&0o777)!==0o750)throw new Error('Checkpoint parent is not protected');
   if(existsSync(path)){
    if(existsSync(join(path,'COMPLETE.json'))){await verifyCheckpoint(path,config);return(await resumeCheckpointSealForService(path,serviceUid,serviceGid,identity)).identity;}
    // Only a service-owned incomplete checkpoint under the root-owned transaction name may be discarded.
    const stat=lstatSync(path);if(stat.uid!==serviceUid||stat.gid!==serviceGid)throw new Error('Incomplete upgrade checkpoint owner changed');await resetIncompleteCheckpoint(identity);
   }
   helper(state,`checkpoint-${kind}`);
   return(await resumeCheckpointSealForService(path,serviceUid,serviceGid,identity)).identity;
  },
  migrate:async(state)=>helper(state,'migrate'),probe:async state=>helper(state,'probe'),restore:async state=>helper(state,'restore'),finishRestore:async state=>helper(state,'finish-restore'),
 };
 return host;
}
