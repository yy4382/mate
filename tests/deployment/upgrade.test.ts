import {createHash} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {existsSync,lstatSync,mkdtempSync,mkdirSync,readFileSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {daemonConfigSchema,type DaemonConfig} from '../../src/daemon/config.js';
import {Daemon} from '../../src/daemon/app.js';
import {ContainerBackend} from '../../src/execution/container.js';
import {createReleaseManifest} from '../../src/deployment/release.js';
import {nodeWorkspaceHost,type WorkspaceManifest} from '../../src/deployment/workspaces.js';
import {assertDeploymentOperationAllowed,createDeploymentTopology,deploymentJournalPath,deploymentMigrationAttempt,parseDeploymentJournal,readDeploymentJournal,releaseIdentity,writeDeploymentJournal,type DeploymentJournal} from '../../src/deployment/upgrade.js';
import {restoreCheckpoint} from '../../src/daemon/restore.js';
import {configFixture} from '../helpers/config.js';

const cleanups:string[]=[];afterEach(()=>{vi.restoreAllMocks();for(const root of cleanups.splice(0))rmSync(root,{recursive:true,force:true});});
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function writeCandidate(path:string,journal:DeploymentJournal){writeDeploymentJournal(path,parseDeploymentJournal({...journal,phase:'preparing',everActivated:false}));writeDeploymentJournal(path,journal);}

async function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mate-upgrade-')));cleanups.push(root);const data=join(root,'data'),control=join(data,'control'),agents=join(data,'agents'),workspace=join(agents,'research'),volumes=join(root,'volumes');for(const path of [control,workspace,volumes])mkdirSync(path,{recursive:true});
 const manifestPath=join(root,'workspaces.json'),backing=join(volumes,'research.ext4'),manifest:WorkspaceManifest={version:1,mounts:[{kind:'private',agentId:'research',root:workspace,backingFile:backing,capacityBytes:64*1024*1024,ownerUid:process.getuid!(),ownerGid:process.getgid!()}]},manifestText=`${JSON.stringify(manifest,null,2)}\n`;writeFileSync(manifestPath,manifestText);writeFileSync(backing,'synthetic');
 const docker=join(root,'docker');writeFileSync(docker,'synthetic');const oldConfig=daemonConfigSchema.parse({mate:configFixture,runtime:{dataDir:data,workspaceManifest:manifestPath,docker:{binary:docker,host:'unix:///var/run/docker.sock',image:`sha256:${'a'.repeat(64)}`},workspaceGrants:[],researchHosts:[]}}),nextConfig=structuredClone(oldConfig);nextConfig.mate.agents[0]!.role='Candidate role';
 const servicePath=join(root,'mate.service'),unitPath=join(root,'research.mount');writeFileSync(servicePath,'synthetic fixed service');writeFileSync(unitPath,'synthetic fixed mount');
 const backingStat=lstatSync(backing),topology=createDeploymentTopology(oldConfig,{manifest,manifestPath,manifestSha256:digest(manifestText),service:{unitPath:servicePath,sha256:digest(readFileSync(servicePath)),memoryMaxMiB:384},mountUnits:[{root:workspace,backingFile:backing,backingDevice:backingStat.dev,backingInode:backingStat.ino,capacityBytes:64*1024*1024,unitPath,sha256:digest(readFileSync(unitPath))}]});
 const releases=join(root,'releases'),stage=join(root,'stage');mkdirSync(join(stage,'dist'),{recursive:true});mkdirSync(join(stage,'node_modules'));mkdirSync(releases);writeFileSync(join(stage,'dist','main.js'),'');writeFileSync(join(stage,'package.json'),'{}');writeFileSync(join(stage,'pnpm-lock.yaml'),'lockfileVersion: 9\n');
 const release=await createReleaseManifest(stage,'abcdef1',{platform:'linux',arch:'x64',node:'v24.21.0',modulesAbi:'137',packageManager:'pnpm@10.33.0'});writeFileSync(join(stage,'RELEASE.json'),`${JSON.stringify(release,null,2)}\n`);const nextReleasePath=join(releases,release.releaseId);renameSync(stage,nextReleasePath);
 const oldReleaseId='b'.repeat(64),rollback=join(root,'rollback'),candidate=join(root,'candidate');
 const checkpoint=(path:string,seed:number)=>({path,device:seed,inode:seed+1,manifestDevice:seed+2,manifestInode:seed+3,manifestHash:String(seed).padStart(64,'c').slice(-64)});
 const old=releaseIdentity(oldConfig,join(releases,oldReleaseId),oldReleaseId),journal=parseDeploymentJournal({version:1,upgradeId:'11111111-1111-4111-8111-111111111111',attempt:{id:'11111111-1111-4111-8111-111111111111',previous:old},phase:'candidate',everActivated:false,old,next:releaseIdentity(nextConfig,nextReleasePath,release.releaseId),topology,checkpoints:{rollback:checkpoint(rollback,1),candidate:checkpoint(candidate,5)}});
 return{root,data,oldConfig,nextConfig,nextReleasePath,journal,topology};
}

it('fails closed on unknown or damaged journals and preserves activation monotonicity',async()=>{
 const f=await fixture(),path=deploymentJournalPath(f.data),trust={requiredOwnerUid:process.getuid!(),requiredOwnerGid:process.getgid!()};writeCandidate(path,f.journal);
 expect(readDeploymentJournal(f.data,trust)).toEqual(f.journal);writeFileSync(path,JSON.stringify({...f.journal,phase:'future'}));expect(()=>readDeploymentJournal(f.data,trust)).toThrow();rmSync(path);writeCandidate(path,f.journal);
 expect(()=>parseDeploymentJournal({...f.journal,phase:'candidate',everActivated:true})).toThrow('activation history');expect(()=>parseDeploymentJournal({...f.journal,phase:'activated',everActivated:false})).toThrow('activation history');
 const activated=parseDeploymentJournal({...f.journal,phase:'activated',everActivated:true});writeDeploymentJournal(path,activated);expect(()=>writeDeploymentJournal(path,f.journal)).toThrow('cannot be cleared');
 const fixedConfig=structuredClone(f.nextConfig);fixedConfig.mate.agents[0]!.role='Fix-forward role';const fixedReleaseId='d'.repeat(64),fixed=parseDeploymentJournal({...activated,phase:'fix-forward',next:releaseIdentity(fixedConfig,join(f.root,'releases',fixedReleaseId),fixedReleaseId),attempt:{id:'22222222-2222-4222-8222-222222222222',previous:activated.next}});writeDeploymentJournal(path,fixed);expect(deploymentMigrationAttempt(fixed,f.nextConfig,fixedConfig)).toEqual({upgradeId:fixed.upgradeId,attemptId:fixed.attempt.id,topologyIdentity:fixed.topology.identity});expect(()=>deploymentMigrationAttempt(fixed,f.oldConfig,fixedConfig)).toThrow('configuration identity');expect(fixed.everActivated).toBe(true);
 rmSync(path);const target=join(f.data,'dangling-target');symlinkSync(target,path);expect(()=>readDeploymentJournal(f.data,trust)).toThrow('protected regular file');expect(()=>writeDeploymentJournal(path,f.journal)).toThrow('protected regular file');
});

it('allows only an exact inactive candidate probe and exact activated start',async()=>{
 const f=await fixture(),path=deploymentJournalPath(f.data),trust={requiredOwnerUid:process.getuid!(),requiredOwnerGid:process.getgid!()};writeCandidate(path,f.journal);
 await expect(assertDeploymentOperationAllowed('start',{config:f.nextConfig,releaseRoot:f.nextReleasePath},trust)).rejects.toThrow('candidate blocks start');
 await expect(assertDeploymentOperationAllowed('offline-probe',{config:f.nextConfig,releaseRoot:f.nextReleasePath},trust)).resolves.toMatchObject({phase:'candidate'});
 for(const operation of ['backup','restore','migrate','checkpoint-seal','install','disable'] as const)await expect(assertDeploymentOperationAllowed(operation,{config:f.nextConfig,releaseRoot:f.nextReleasePath},trust)).rejects.toThrow(`blocks ${operation}`);
 const activated=parseDeploymentJournal({...f.journal,phase:'activated',everActivated:true});writeDeploymentJournal(path,activated);await expect(assertDeploymentOperationAllowed('start',{config:f.nextConfig,releaseRoot:f.nextReleasePath},trust)).resolves.toMatchObject({phase:'activated'});
 const changed=structuredClone(f.nextConfig);changed.mate.agents[0]!.role='unrecorded';await expect(assertDeploymentOperationAllowed('start',{config:changed,releaseRoot:f.nextReleasePath},trust)).rejects.toThrow('configuration');
 const backing=f.topology.mountUnits[0]!.backingFile,saved=`${backing}.saved`;renameSync(backing,saved);writeFileSync(backing,'replacement');await expect(assertDeploymentOperationAllowed('start',{config:f.nextConfig,releaseRoot:f.nextReleasePath},trust)).rejects.toThrow('backing file');rmSync(backing);renameSync(saved,backing);
 writeFileSync(f.topology.service.unitPath,'changed');await expect(assertDeploymentOperationAllowed('start',{config:f.nextConfig,releaseRoot:f.nextReleasePath},trust)).rejects.toThrow('service unit');
});

it('rejects topology drift and blocks ordinary restore even after activation',async()=>{
 const f=await fixture(),path=deploymentJournalPath(f.data),activated=parseDeploymentJournal({...f.journal,phase:'activated',everActivated:true});writeCandidate(path,f.journal);writeDeploymentJournal(path,activated);
 const drift=structuredClone(f.nextConfig) as DaemonConfig;drift.mate.agents.push({...drift.mate.agents[0]!,id:'writer',name:'Writer'});expect(()=>createDeploymentTopology(drift,{manifest:f.topology.workspaceManifest.value,manifestPath:f.topology.workspaceManifest.path,manifestSha256:f.topology.workspaceManifest.sha256,service:{unitPath:f.topology.service.unitPath,sha256:f.topology.service.sha256,memoryMaxMiB:f.topology.service.memoryMaxMiB},mountUnits:f.topology.mountUnits})).toThrow('workspace topology');
 await expect(restoreCheckpoint(f.nextConfig,join(f.root,'missing'))).rejects.toThrow('Ordinary restore is blocked');
});

it('gates candidate daemon startup before container recovery or Store creation',async()=>{
 const f=await fixture(),recover=vi.spyOn(ContainerBackend.prototype,'recover').mockResolvedValue();writeCandidate(deploymentJournalPath(f.data),f.journal);
 const environment={platform:'darwin' as const,workspaceHost:nodeWorkspaceHost(),deploymentJournalTrust:{requiredOwnerUid:process.getuid!(),requiredOwnerGid:process.getgid!()}};
 await expect(Daemon.create(f.nextConfig,{info:()=>{},error:()=>{}},f.nextReleasePath,environment)).rejects.toThrow('candidate blocks start');expect(recover).not.toHaveBeenCalled();expect(existsSync(join(f.data,'state','mate.sqlite'))).toBe(false);
});
