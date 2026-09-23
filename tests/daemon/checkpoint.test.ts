import {lstat as lstatAsync,open as openAsync} from 'node:fs/promises';
import {afterEach,expect,it,vi} from 'vitest';
import {chmodSync,existsSync,lstatSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {backup,backupDeploymentSnapshot} from '../../src/daemon/backup.js';
import {resumeCheckpointSealForTesting,type CheckpointSealingHost,inspectIncompleteCheckpoint,removeIncompleteCheckpoint,restoreRegularFile,sealCheckpointForService,validateCheckpointManifest,verifyCheckpoint} from '../../src/daemon/checkpoint-format.js';
import {restoreCheckpointForTesting as restoreCheckpoint} from '../../src/daemon/restore.js';
import {daemonConfigSchema,type DaemonConfig} from '../../src/daemon/config.js';
import {Store} from '../../src/storage/store.js';
import {configFixture} from '../helpers/config.js';
import {nodeWorkspaceHost,type MountFacts,type PathFacts,type WorkspaceHost,type WorkspaceManifest} from '../../src/deployment/workspaces.js';
import type {DeploymentEnvironment} from '../../src/deployment/runtime.js';
import {Daemon} from '../../src/daemon/app.js';
import {ContainerBackend} from '../../src/execution/container.js';

const cleanups:(()=>void|Promise<void>)[]=[];afterEach(async()=>{vi.restoreAllMocks();for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
const capacity=64*1024*1024;
function secondAgent(){return{...configFixture.agents[0],id:'writer',name:'Writer',role:'Write evidence',slackAppId:'ATWO',slackUserId:'UTWO',slackBotId:'BTWO',botTokenEnv:'WRITER_BOT',appTokenEnv:'WRITER_APP'};}
function pathFacts(path:string):PathFacts{const value=lstatSync(path);return{kind:value.isFile()?'file':value.isDirectory()?'directory':value.isSymbolicLink()?'symlink':'other',uid:value.uid,gid:value.gid,dev:value.dev,ino:value.ino,nlink:value.nlink,size:value.size,blocks:value.blocks,mode:value.mode};}
function managedFixture(agentIds=['research','writer']){
 const root=realpathSync(mkdtempSync('/tmp/mate-v2-checkpoint-')),data=join(root,'data'),state=join(data,'state'),control=join(data,'control'),agents=join(data,'agents'),external=join(root,'external'),volumes=join(root,'volumes'),manifestPath=join(root,'workspaces.json'),docker=join(root,'docker');
 for(const path of [state,control,agents,external,volumes])mkdirSync(path,{recursive:true,mode:0o700});writeFileSync(docker,'synthetic');chmodSync(docker,0o700);
 const definitions=[configFixture.agents[0]!,secondAgent()].filter(agent=>agentIds.includes(agent.id));const mounts:WorkspaceManifest['mounts']=[];const mountFacts:MountFacts[]=[];const overrides=new Map<string,PathFacts>();let device=100;
 for(const agent of definitions){const workspace=join(agents,agent.id),backing=join(volumes,`${agent.id}.ext4`);mkdirSync(workspace,{mode:0o700});writeFileSync(backing,'x');const stat=pathFacts(workspace),backingStat=pathFacts(backing);device++;overrides.set(workspace,{...stat,dev:device,uid:process.getuid!(),gid:process.getgid!(),mode:0o40700});overrides.set(backing,{...backingStat,uid:0,gid:0,size:capacity,blocks:capacity/512,nlink:1,mode:0o100600});mounts.push({kind:'private',agentId:agent.id,root:workspace,backingFile:backing,capacityBytes:capacity,ownerUid:process.getuid!(),ownerGid:process.getgid!()});mountFacts.push({target:workspace,root:'/',filesystem:'ext4',source:`/dev/loop${device}`,majorMinor:`7:${device}`,options:['rw','nosuid','nodev'],backingFile:backing});}
 const externalBacking=join(volumes,'external.ext4');writeFileSync(externalBacking,'x');device++;overrides.set(external,{...pathFacts(external),dev:device,uid:process.getuid!(),gid:process.getgid!(),mode:0o40700});overrides.set(externalBacking,{...pathFacts(externalBacking),uid:0,gid:0,size:capacity,blocks:capacity/512,nlink:1,mode:0o100600});mounts.push({kind:'external',root:external,backingFile:externalBacking,capacityBytes:capacity,ownerUid:process.getuid!(),ownerGid:process.getgid!()});mountFacts.push({target:external,root:'/',filesystem:'ext4',source:`/dev/loop${device}`,majorMinor:`7:${device}`,options:['rw','nosuid','nodev'],backingFile:externalBacking});
 const manifest:WorkspaceManifest={version:1,mounts};writeFileSync(manifestPath,JSON.stringify(manifest));overrides.set(manifestPath,{...pathFacts(manifestPath),uid:0,gid:process.getgid!(),nlink:1,mode:0o100640});
 const base=nodeWorkspaceHost();let available=capacity*.75,stateAvailable=capacity,stateInodes=16000,stateAvailability=()=>stateAvailable;const host:WorkspaceHost={...base,read:path=>readFileSync(path,'utf8'),readProtected:path=>({text:readFileSync(path,'utf8'),facts:overrides.get(path)??pathFacts(path)}),lstat:path=>overrides.get(path)??pathFacts(path),stat:path=>overrides.get(path)??pathFacts(path),statfs:path=>path===state?{type:0xef53,bsize:4096,blocks:Math.floor(capacity/4096),bavail:Math.floor(stateAvailability()/4096),files:16384,ffree:stateInodes}:overrides.has(path)?{type:0xef53,bsize:4096,blocks:Math.floor(capacity*.8/4096),bavail:Math.floor(available/4096),files:16384,ffree:16000}:base.statfs(path),mounts:()=>mountFacts,uid:()=>process.getuid!(),gid:()=>process.getgid!()};
 const config=daemonConfigSchema.parse({mate:{...configFixture,agents:definitions},runtime:{dataDir:data,workspaceManifest:manifestPath,docker:{binary:docker,host:'unix:///var/run/docker.sock',image:`sha256:${'a'.repeat(64)}`},workspaceGrants:[{agentId:'research',root:external,operations:['read']}],researchHosts:[]}}),environment:DeploymentEnvironment={platform:'linux',workspaceHost:host};
 cleanups.push(()=>rmSync(root,{recursive:true,force:true}));return{root,data,state,control,agents,external,config,environment,setAvailable:(bytes:number)=>{available=bytes;},setStateCapacity:(bytes:number,inodes=stateInodes)=>{stateAvailable=bytes;stateInodes=inodes;stateAvailability=()=>stateAvailable;},setStateCapacityProbe:(probe:()=>number)=>{stateAvailability=probe;}};
}
function seed(f:ReturnType<typeof managedFixture>,label:string):Store{
 for(const agent of f.config.mate.agents){const root=join(f.agents,agent.id);writeFileSync(join(root,'MEMORY.md'),`${label}-${agent.id}`,{mode:0o640});mkdirSync(join(root,'notes'),{mode:0o750});writeFileSync(join(root,'notes','one.txt'),label,{mode:0o600});symlinkSync('../MEMORY.md',join(root,'notes','memory-link'));mkdirSync(join(root,'lost+found'),{mode:0o700});writeFileSync(join(root,'lost+found','filesystem-private'),'ignore');}
 writeFileSync(join(f.external,'sentinel'),'external');const store=new Store(join(f.state,'mate.sqlite'));for(const agent of f.config.mate.agents)store.register(agent.id,'v1',[{role:'user',content:label}]);return store;
}
async function take(store:Store,f:ReturnType<typeof managedFixture>,name:string){const destination=join(f.root,name);mkdirSync(destination,{mode:0o700});await backup(store,f.data,destination,f.config);return destination;}
function checkpointTrust(path:string){const stat=lstatSync(path);return{checkpointOwnerUid:stat.uid,checkpointOwnerGid:stat.gid};}

it('creates a strict v2 inventory without following symlinks or including external and filesystem control data',async()=>{
 const f=managedFixture(),store=seed(f,'target'),externalAlias=join(f.root,'external-alias');symlinkSync(f.external,externalAlias);f.config.runtime.workspaceGrants[0]!.root=externalAlias;const checkpoint=await take(store,f,'target-checkpoint');await expect(backup(store,f.data,join(f.external,'checkpoint'),f.config)).rejects.toThrow('outside live and granted roots');store.close();const verified=await verifyCheckpoint(checkpoint,f.config);
 expect(verified.manifest).toMatchObject({version:2,containerImage:`sha256:${'a'.repeat(64)}`,excludedExternalRoots:[f.external]});expect(verified.manifest.agents.map(agent=>agent.agentId)).toEqual(['research','writer']);
 const research=verified.manifest.agents[0]!.entries;expect(research).toContainEqual(expect.objectContaining({path:'notes/memory-link',type:'symlink',target:'../MEMORY.md'}));expect(research.some(entry=>entry.path.startsWith('lost+found'))).toBe(false);expect(JSON.stringify(verified.manifest)).not.toContain('sentinel');expect(readFileSync(join(f.external,'sentinel'),'utf8')).toBe('external');
 expect(lstatSync(checkpoint).mode&0o022).toBe(0);expect(lstatSync(join(checkpoint,'mate.sqlite')).mode&0o022).toBe(0);
 writeFileSync(join(checkpoint,'agents','research','extra'),'tamper');await expect(verifyCheckpoint(checkpoint,f.config)).rejects.toThrow('inventory');
});

it('takes a deployment recovery snapshot without constructing Store or migrating an unknown candidate schema',async()=>{
 const f=managedFixture(['research']),store=seed(f,'candidate');store.db.pragma('user_version = 999');store.close();const checkpoint=join(f.root,'raw-candidate');mkdirSync(checkpoint,{mode:0o700});await backupDeploymentSnapshot(f.data,checkpoint,f.config);expect((await verifyCheckpoint(checkpoint,f.config)).manifest.database.path).toBe('mate.sqlite');expect(()=>new Store(join(f.state,'mate.sqlite'))).toThrow('Unsupported database version');
});

it('rejects special workspace files and malformed inventory paths instead of broadening the snapshot',async()=>{
 const f=managedFixture(['research']),store=seed(f,'target'),fifo=join(f.agents,'research','agent.fifo');expect(spawnSync('mkfifo',[fifo]).status).toBe(0);
 const incomplete=join(f.root,'bad-checkpoint');await expect(take(store,f,'bad-checkpoint')).rejects.toThrow('unsupported special file');expect(existsSync(join(incomplete,'COMPLETE.json'))).toBe(false);await expect(backup(store,f.data,incomplete,f.config)).rejects.toThrow('absent or one empty directory');rmSync(fifo,{force:true});const checkpoint=await take(store,f,'good-checkpoint');store.close();
 const incompleteIdentity=await inspectIncompleteCheckpoint(incomplete);if(process.geteuid?.()===0){await removeIncompleteCheckpoint(incompleteIdentity);expect(existsSync(incomplete)).toBe(false);}else await expect(removeIncompleteCheckpoint(incompleteIdentity)).rejects.toThrow('must run as root');await expect(inspectIncompleteCheckpoint(checkpoint)).rejects.toThrow('must never be removed');
 const complete=join(checkpoint,'COMPLETE.json'),manifest=JSON.parse(readFileSync(complete,'utf8'));manifest.agents[0].entries[0].path='.';writeFileSync(complete,JSON.stringify(manifest));await expect(verifyCheckpoint(checkpoint,f.config)).rejects.toThrow('Canonical relative path');
});

it('exposes a root-only sealing boundary and managed restore rejects service-owned checkpoints',async()=>{
 const f=managedFixture(['research']),store=seed(f,'target'),checkpoint=await take(store,f,'checkpoint');store.close();
 const mismatchedOwner=process.getuid?.()===0?{checkpointOwnerUid:1}:{};await expect(restoreCheckpoint(f.config,checkpoint,{environment:f.environment,...mismatchedOwner})).rejects.toThrow('root-owned service-group');expect(existsSync(join(f.control,'restore.json'))).toBe(false);
 if(process.geteuid?.()===0){chmodSync(f.root,0o750);const identity=await sealCheckpointForService(checkpoint,process.getuid!(),process.getgid!());expect(identity.root).toBe(checkpoint);await verifyCheckpoint(checkpoint,f.config,{requiredOwnerUid:0,requiredOwnerGid:process.getgid!()});}
 else await expect(sealCheckpointForService(checkpoint,process.getuid!(),process.getgid!())).rejects.toThrow('must run as root');
});

it('recovers the execution scope and validates control isolation before making a restore decision',async()=>{
 const f=managedFixture(['research']),store=seed(f,'target'),target=await take(store,f,'target-checkpoint');store.close();const before=readFileSync(join(f.agents,'research','MEMORY.md'));
 const recover=vi.spyOn(ContainerBackend.prototype,'recover').mockRejectedValue(new Error('orphan cleanup failed'));
 await expect(restoreCheckpoint(f.config,target,{environment:f.environment,...checkpointTrust(target)})).rejects.toThrow('orphan cleanup failed');expect(recover).toHaveBeenCalledOnce();expect(existsSync(join(f.control,'restore.json'))).toBe(false);expect(readFileSync(join(f.agents,'research','MEMORY.md'))).toEqual(before);
 recover.mockResolvedValue();await expect(restoreCheckpoint(f.config,target,{environment:f.environment,projectRoot:f.external,...checkpointTrust(target)})).rejects.toThrow('Protected root overlap');expect(recover).toHaveBeenCalledOnce();expect(existsSync(join(f.control,'restore.json'))).toBe(false);
});

it('rejects parent path substitution while copying a checkpoint file',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mate-restore-parent-'))),sourceDir=join(root,'source'),destinationDir=join(root,'destination'),other=join(root,'other');for(const path of [sourceDir,destinationDir,other])mkdirSync(path);const source=join(sourceDir,'file'),destination=join(destinationDir,'file');writeFileSync(source,'payload');const inventory=await import('../../src/daemon/checkpoint-format.js').then(module=>module.inventoryRegularFile(source));rmSync(destinationDir,{recursive:true});symlinkSync(other,destinationDir);cleanups.push(()=>rmSync(root,{recursive:true,force:true}));await expect(restoreRegularFile(source,destination,inventory)).rejects.toThrow('canonical directories');expect(existsSync(join(other,'file'))).toBe(false);
});

it('rejects duplicate, unsorted, prefix-colliding, and configuration-drifted inventories',async()=>{
 const f=managedFixture(['research']),store=seed(f,'target'),checkpoint=await take(store,f,'checkpoint');store.close();const manifest=JSON.parse(readFileSync(join(checkpoint,'COMPLETE.json'),'utf8'));
 const duplicate=structuredClone(manifest);duplicate.agents[0].entries.splice(1,0,structuredClone(duplicate.agents[0].entries[0]));expect(()=>validateCheckpointManifest(duplicate)).toThrow('uniquely sorted');
 const unsorted=structuredClone(manifest),entries=unsorted.agents[0].entries,last=entries.length-1;[entries[last-1],entries[last]]=[entries[last],entries[last-1]];expect(()=>validateCheckpointManifest(unsorted)).toThrow('sorted');
 const collision=structuredClone(manifest);collision.agents[0].entries=[{path:'blocked',type:'file',mode:0o600,size:1,allocatedBytes:4096,sha256:'a'.repeat(64)},{path:'blocked/child',type:'file',mode:0o600,size:1,allocatedBytes:4096,sha256:'b'.repeat(64)}];expect(()=>validateCheckpointManifest(collision)).toThrow('parent');
 const supportedId=structuredClone(manifest);supportedId.agents[0].agentId='peer_one';expect(()=>validateCheckpointManifest(supportedId)).not.toThrow();
 const changed=daemonConfigSchema.parse({...f.config,runtime:{...f.config.runtime,docker:{...f.config.runtime.docker!,image:`sha256:${'b'.repeat(64)}`}}});await expect(verifyCheckpoint(checkpoint,changed)).rejects.toThrow('configuration');
});

it('persists the decision, resumes across Agent roots, gates daemon startup, and replaces SQLite last',async()=>{
 const recover=vi.spyOn(ContainerBackend.prototype,'recover').mockResolvedValue(),f=managedFixture(),store=seed(f,'target'),target=await take(store,f,'target-checkpoint');store.audit('newer',{value:1});for(const agent of f.config.mate.agents)writeFileSync(join(f.agents,agent.id,'MEMORY.md'),`current-${agent.id}`);const current=await take(store,f,'current-checkpoint');store.close();writeFileSync(join(f.state,'mate.sqlite-wal'),'');writeFileSync(join(f.state,'mate.sqlite-shm'),'');
 await expect(restoreCheckpoint(f.config,target,{currentCheckpoint:current,environment:f.environment,...checkpointTrust(target),afterPhase:phase=>{if(phase==='agent:research')throw new Error('synthetic crash');}})).rejects.toThrow('synthetic crash');
 expect(existsSync(join(f.control,'restore.json'))).toBe(true);expect(readFileSync(join(f.agents,'research','MEMORY.md'),'utf8')).toBe('target-research');expect(readFileSync(join(f.agents,'writer','MEMORY.md'),'utf8')).toBe('current-writer');expect(existsSync(join(f.state,'mate.sqlite-wal'))).toBe(true);
 recover.mockClear();await expect(Daemon.create(f.config,{info:()=>{},error:()=>{}},process.cwd(),f.environment)).rejects.toThrow('restore is incomplete');expect(recover).not.toHaveBeenCalled();
 writeFileSync(join(f.agents,'research','MEMORY.md'),'tampered-after-complete');await expect(restoreCheckpoint(f.config,target,{environment:f.environment,...checkpointTrust(target)})).rejects.toThrow('Completed restore workspace changed');expect(existsSync(join(f.control,'restore.json'))).toBe(true);writeFileSync(join(f.agents,'research','MEMORY.md'),'target-research');
 await restoreCheckpoint(f.config,target,{currentCheckpoint:current,environment:f.environment,...checkpointTrust(target)});expect(existsSync(join(f.control,'restore.json'))).toBe(false);expect(existsSync(join(f.state,'mate.sqlite-wal'))).toBe(false);expect(existsSync(join(f.state,'mate.sqlite-shm'))).toBe(false);expect(readFileSync(join(f.agents,'writer','MEMORY.md'),'utf8')).toBe('target-writer');expect(readFileSync(join(f.external,'sentinel'),'utf8')).toBe('external');
 expect(lstatSync(join(f.agents,'writer','MEMORY.md')).mode&0o7777).toBe(0o640);expect(lstatSync(join(f.agents,'writer','notes')).mode&0o7777).toBe(0o750);expect(lstatSync(join(f.agents,'writer','notes','one.txt')).mode&0o7777).toBe(0o600);
 const restored=new Store(join(f.state,'mate.sqlite'));expect(restored.db.prepare("SELECT count(*) n FROM audit WHERE kind='newer'").get()).toEqual({n:0});restored.close();
});

it('makes no data decision on missing current proof or insufficient capacity and only resumes from the bound source',async()=>{
 vi.spyOn(ContainerBackend.prototype,'recover').mockResolvedValue();const f=managedFixture(['research']),store=seed(f,'target'),target=await take(store,f,'target-checkpoint');store.audit('newer',{});writeFileSync(join(f.agents,'research','MEMORY.md'),'current');const current=await take(store,f,'current-checkpoint');store.close();
 await expect(restoreCheckpoint(f.config,target,{environment:f.environment,...checkpointTrust(target)})).rejects.toThrow('requires its verified current checkpoint');expect(readFileSync(join(f.agents,'research','MEMORY.md'),'utf8')).toBe('current');expect(existsSync(join(f.control,'restore.json'))).toBe(false);
 writeFileSync(join(f.state,'mate.sqlite-wal'),'uncheckpointed');await expect(restoreCheckpoint(f.config,target,{currentCheckpoint:current,environment:f.environment,...checkpointTrust(target)})).rejects.toThrow('live database');expect(existsSync(join(f.control,'restore.json'))).toBe(false);rmSync(join(f.state,'mate.sqlite-wal'));
 f.setStateCapacity(0);await expect(restoreCheckpoint(f.config,target,{currentCheckpoint:current,environment:f.environment,...checkpointTrust(target)})).rejects.toThrow('state filesystem capacity');expect(existsSync(join(f.control,'restore.json'))).toBe(false);f.setStateCapacity(capacity);
 f.setAvailable(0);await expect(restoreCheckpoint(f.config,target,{currentCheckpoint:current,environment:f.environment,...checkpointTrust(target)})).rejects.toThrow('capacity');expect(readFileSync(join(f.agents,'research','MEMORY.md'),'utf8')).toBe('current');expect(existsSync(join(f.control,'restore.json'))).toBe(false);f.setAvailable(capacity*.75);
 await expect(restoreCheckpoint(f.config,target,{currentCheckpoint:current,environment:f.environment,...checkpointTrust(target),afterPhase:phase=>{if(phase==='decision')throw new Error('stop after decision');}})).rejects.toThrow('stop after decision');expect(readFileSync(join(f.agents,'research','MEMORY.md'),'utf8')).toBe('current');
 const stale=join(f.state,'.mate.sqlite.restore-stale');writeFileSync(stale,'partial');f.setStateCapacityProbe(()=>existsSync(stale)?0:capacity);
 const originalRoot=`${target}.original`;renameSync(target,originalRoot);mkdirSync(target,{mode:0o750});for(const name of readdirSync(originalRoot))renameSync(join(originalRoot,name),join(target,name));await expect(restoreCheckpoint(f.config,target,{environment:f.environment,...checkpointTrust(target)})).rejects.toThrow('replaced checkpoint');expect(existsSync(stale)).toBe(false);for(const name of readdirSync(target))renameSync(join(target,name),join(originalRoot,name));rmSync(target,{recursive:true});renameSync(originalRoot,target);
 const payload=join(target,'agents','research','MEMORY.md'),original=readFileSync(payload);writeFileSync(payload,'corrupt');
 await expect(restoreCheckpoint(f.config,target,{environment:f.environment,...checkpointTrust(target)})).rejects.toThrow('inventory');expect(existsSync(join(f.control,'restore.json'))).toBe(true);writeFileSync(payload,original);rmSync(current,{recursive:true});await restoreCheckpoint(f.config,target,{environment:f.environment,...checkpointTrust(target)});expect(readFileSync(join(f.agents,'research','MEMORY.md'),'utf8')).toBe('target-research');
});

it.each([true,false])('finishes a database-complete=%s decided resume without requiring room for another database copy',async(databaseComplete)=>{
 vi.spyOn(ContainerBackend.prototype,'recover').mockResolvedValue();const f=managedFixture(['research']),store=seed(f,'target'),target=await take(store,f,'target-checkpoint');store.audit('newer',{});writeFileSync(join(f.agents,'research','MEMORY.md'),'current');const current=await take(store,f,'current-checkpoint');store.close();
 await expect(restoreCheckpoint(f.config,target,{currentCheckpoint:current,environment:f.environment,...checkpointTrust(target),afterPhase:phase=>{if(phase==='database')throw new Error('crash after database');}})).rejects.toThrow('crash after database');const journalPath=join(f.control,'restore.json'),journal=JSON.parse(readFileSync(journalPath,'utf8'));expect(journal.databaseComplete).toBe(true);if(!databaseComplete){journal.databaseComplete=false;writeFileSync(journalPath,JSON.stringify(journal));}
 f.setStateCapacity(0);await restoreCheckpoint(f.config,target,{environment:f.environment,...checkpointTrust(target)});expect(existsSync(journalPath)).toBe(false);expect(readFileSync(join(f.agents,'research','MEMORY.md'),'utf8')).toBe('target-research');
});

it('keeps version 1 on its original absent-dataDir compatibility path',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mate-v1-restore-'))),data=join(root,'data'),checkpoint=join(root,'checkpoint');mkdirSync(join(checkpoint,'agents','research'),{recursive:true});writeFileSync(join(checkpoint,'agents','research','MEMORY.md'),'legacy');const database=new Store(join(checkpoint,'mate.sqlite'));database.register('research','v1',[]);database.close();writeFileSync(join(checkpoint,'COMPLETE.json'),JSON.stringify({version:1,dataDir:data,at:new Date().toISOString()}));
 const config=daemonConfigSchema.parse({mate:configFixture,runtime:{dataDir:data,workspaceGrants:[],researchHosts:[]}});cleanups.push(()=>rmSync(root,{recursive:true,force:true}));expect(await restoreCheckpoint(config,checkpoint)).toBe('v1');expect(readFileSync(join(data,'agents','research','MEMORY.md'),'utf8')).toBe('legacy');await expect(restoreCheckpoint(config,checkpoint)).rejects.toThrow('absent destination');
});

it('resumes partial checkpoint ownership sealing only for the root-journal-pinned directory',async()=>{
 const f=managedFixture(['research']),store=seed(f,'target'),checkpoint=await take(store,f,'checkpoint');store.close();chmodSync(f.root,0o750);const actual=lstatSync(checkpoint),bound={path:checkpoint,device:actual.dev,inode:actual.ino},uid=actual.uid,gid=actual.gid,owners=new Map<string,number>();let writes=0,interrupt=true;
 const facts=async(path:string)=>{const stat=await lstatAsync(path);return Object.assign(stat,{uid:path===f.root?0:owners.get(path)??uid,gid});};
 const host:CheckpointSealingHost={uid:()=>0,lstat:facts,lchown:async(path,owner)=>{owners.set(path,owner);},open:async(path,flags)=>{
  const handle=await openAsync(path,flags);return{stat:async()=>{const stat=await handle.stat();return Object.assign(stat,{uid:owners.get(path)??uid,gid});},chown:async(owner)=>{if(interrupt&&++writes===2)throw new Error('sealing interrupted');owners.set(path,owner);},chmod:mode=>handle.chmod(mode),sync:()=>handle.sync(),close:()=>handle.close()};
 }};
 await expect(resumeCheckpointSealForTesting(checkpoint,uid,gid,bound,host)).rejects.toThrow('sealing interrupted');expect(owners.get(checkpoint)).toBe(0);interrupt=false;
 await expect(resumeCheckpointSealForTesting(checkpoint,uid,gid,{...bound,inode:bound.inode+1},host)).rejects.toThrow('resume identity changed');
 const verified=await resumeCheckpointSealForTesting(checkpoint,uid,gid,bound,host);expect(verified.identity.inode).toBe(bound.inode);expect([...owners.values()].every(owner=>owner===0)).toBe(true);await verifyCheckpoint(checkpoint,f.config);
});
