import {createHash,randomUUID} from 'node:crypto';
import {closeSync,constants,existsSync,fchmodSync,fchownSync,fstatSync,fsyncSync,lstatSync,openSync,readFileSync,realpathSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,resolve} from 'node:path';
import {z} from 'zod';
import type {DaemonConfig} from '../daemon/config.js';
import {encode,hash} from '../storage/store.js';
import {verifyRelease} from './release.js';
import {workspaceManifestSchema,type WorkspaceManifest} from './workspaces.js';

const digestPattern=/^[a-f0-9]{64}$/;
const absolute=z.string().refine(value=>isAbsolute(value)&&resolve(value)===value,'Canonical absolute path required');
const checkpointIdentitySchema=z.object({path:absolute,device:z.number().int().nonnegative(),inode:z.number().int().positive(),manifestDevice:z.number().int().nonnegative(),manifestInode:z.number().int().positive(),manifestHash:z.string().regex(digestPattern)}).strict();
const releaseIdentitySchema=z.object({configurationHash:z.string().regex(digestPattern),releaseId:z.string().regex(digestPattern),releasePath:absolute}).strict();
const mountUnitSchema=z.object({root:absolute,backingFile:absolute,backingDevice:z.number().int().nonnegative(),backingInode:z.number().int().positive(),capacityBytes:z.number().int().positive(),unitPath:absolute,sha256:z.string().regex(digestPattern)}).strict();
const topologySchema=z.object({
 version:z.literal(1),identity:z.string().regex(digestPattern),dataDir:absolute,agentIds:z.array(z.string()).min(1),
 workspaceManifest:z.object({path:absolute,sha256:z.string().regex(digestPattern),value:workspaceManifestSchema}).strict(),
 execution:z.object({binary:absolute,host:z.string().startsWith('unix:///'),network:z.enum(['none','bridge']),resources:z.object({memoryMb:z.number().int(),cpus:z.number(),pids:z.number().int(),tmpfsMb:z.number().int()}).strict()}).strict(),
 service:z.object({unitPath:absolute,sha256:z.string().regex(digestPattern),user:z.literal('mate'),group:z.literal('mate'),supplementaryGroups:z.tuple([z.literal('docker')]),memoryMaxMiB:z.number().int().min(128)}).strict(),
 mountUnits:z.array(mountUnitSchema).min(1),
}).strict();
export type DeploymentTopology=z.infer<typeof topologySchema>;

export const deploymentJournalSchema=z.object({
 version:z.literal(1),upgradeId:z.string().uuid(),attempt:z.object({id:z.string().uuid(),previous:releaseIdentitySchema}).strict(),phase:z.enum(['preparing','candidate','rollback','activated','fix-forward']),everActivated:z.boolean(),
 old:releaseIdentitySchema,next:releaseIdentitySchema,topology:topologySchema,
 checkpoints:z.object({rollback:checkpointIdentitySchema,candidate:checkpointIdentitySchema.optional()}).strict(),
}).strict();
export type DeploymentJournal=z.infer<typeof deploymentJournalSchema>;
export type DeploymentOperation='start'|'offline-probe'|'backup'|'restore'|'migrate'|'checkpoint-seal'|'install'|'disable';
export interface DeploymentJournalTrust{requiredOwnerUid?:number;requiredOwnerGid?:number}
export interface RuntimeDeploymentIdentity{config:DaemonConfig;releaseRoot:string}

function stable(value:unknown):string{
 if(Array.isArray(value))return`[${value.map(stable).join(',')}]`;
 if(value&&typeof value==='object')return`{${Object.entries(value).sort(([left],[right])=>left.localeCompare(right)).map(([key,item])=>`${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
 return JSON.stringify(value);
}
function digest(value:string|Buffer):string{return createHash('sha256').update(value).digest('hex');}
function lstatIfPresent(path:string){try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}}
function protectedBytes(path:string):Buffer{
 const before=lstatSync(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||(before.mode&0o022)!==0)throw new Error(`Deployment identity file is not protected: ${path}`);
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const opened=fstatSync(fd),bytes=readFileSync(fd),after=fstatSync(fd);if(opened.dev!==before.dev||opened.ino!==before.ino||after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs)throw new Error(`Deployment identity file changed while reading: ${path}`);return bytes;}finally{closeSync(fd);}
}
function fileDigest(path:string):string{return digest(protectedBytes(path));}
function syncDirectory(path:string):void{const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY);try{fsyncSync(fd);}finally{closeSync(fd);}}
function topologyPayload(value:Omit<DeploymentTopology,'identity'>):Omit<DeploymentTopology,'identity'>{return value;}

export function configurationIdentity(config:DaemonConfig):string{return hash(encode(config));}
export function deploymentJournalPath(dataDir:string):string{return join(resolve(dataDir),'control','deployment-v1.json');}

export function createDeploymentTopology(config:DaemonConfig,input:{manifest:WorkspaceManifest;manifestPath:string;manifestSha256:string;service:{unitPath:string;sha256:string;memoryMaxMiB:number};mountUnits:readonly z.input<typeof mountUnitSchema>[]}):DeploymentTopology{
 const docker=config.runtime.docker;if(!docker||!config.runtime.workspaceManifest)throw new Error('Deployment topology requires managed Docker and workspace configuration');
 const payload=topologyPayload({version:1,dataDir:resolve(config.runtime.dataDir),agentIds:config.mate.agents.map(agent=>agent.id).sort(),workspaceManifest:{path:resolve(input.manifestPath),sha256:input.manifestSha256,value:workspaceManifestSchema.parse(input.manifest)},execution:{binary:resolve(docker.binary),host:docker.host,network:docker.network??'none',resources:docker.resources},service:{unitPath:resolve(input.service.unitPath),sha256:input.service.sha256,user:'mate',group:'mate',supplementaryGroups:['docker'],memoryMaxMiB:input.service.memoryMaxMiB},mountUnits:input.mountUnits.map(item=>mountUnitSchema.parse(item)).sort((left,right)=>left.root.localeCompare(right.root))});
 const topology=topologySchema.parse({...payload,identity:digest(stable(payload))});assertConfigurationTopology(config,topology);return topology;
}

export function assertConfigurationTopology(config:DaemonConfig,topology:DeploymentTopology):void{
 const value=topologySchema.parse(topology),{identity,...payload}=value;if(digest(stable(payload))!==identity)throw new Error('Deployment topology identity does not match its contents');
 const docker=config.runtime.docker;if(!docker||!config.runtime.workspaceManifest)throw new Error('Deployment topology requires managed Docker and workspace configuration');
 if(resolve(config.runtime.dataDir)!==value.dataDir||resolve(config.runtime.workspaceManifest)!==value.workspaceManifest.path)throw new Error('Deployment data or workspace manifest topology changed');
 const agents=config.mate.agents.map(agent=>agent.id).sort();if(encode(agents)!==encode(value.agentIds))throw new Error('Deployment Agent topology changed');
 const execution={binary:resolve(docker.binary),host:docker.host,network:docker.network??'none',resources:docker.resources};if(stable(execution)!==stable(value.execution))throw new Error('Deployment execution topology changed');
 const mounts=[...value.workspaceManifest.value.mounts].sort((left,right)=>`${left.kind}:${'agentId'in left?left.agentId:left.root}`.localeCompare(`${right.kind}:${'agentId'in right?right.agentId:right.root}`));
 const privateExpected=agents.map(agentId=>({agentId,root:join(value.dataDir,'agents',agentId)}));
 const privateActual=mounts.filter((item):item is Extract<WorkspaceManifest['mounts'][number],{kind:'private'}>=>item.kind==='private').map(item=>({agentId:item.agentId,root:resolve(item.root)})).sort((left,right)=>left.agentId.localeCompare(right.agentId));
 if(stable(privateActual)!==stable(privateExpected))throw new Error('Deployment private workspace topology changed');
 const externalExpected=[...new Set(config.runtime.workspaceGrants.map(grant=>resolve(grant.root)))].sort(),externalActual=mounts.filter(item=>item.kind==='external').map(item=>resolve(item.root)).sort();
 if(encode(externalActual)!==encode(externalExpected))throw new Error('Deployment external workspace topology changed');
 const units=value.mountUnits.map(item=>({root:item.root,backingFile:item.backingFile,capacityBytes:item.capacityBytes})).sort((left,right)=>left.root.localeCompare(right.root));
 const declared=mounts.map(item=>({root:resolve(item.root),backingFile:resolve(item.backingFile),capacityBytes:item.capacityBytes})).sort((left,right)=>left.root.localeCompare(right.root));
 if(stable(units)!==stable(declared)||new Set(value.mountUnits.map(item=>item.unitPath)).size!==value.mountUnits.length)throw new Error('Deployment mount unit topology changed');
 const owners=new Set(mounts.map(item=>`${item.ownerUid}:${item.ownerGid}`));if(owners.size!==1)throw new Error('Deployment workspace service identity changed');
}

export function parseDeploymentJournal(input:unknown):DeploymentJournal{
 const journal=deploymentJournalSchema.parse(input);
 if(basename(journal.old.releasePath)!==journal.old.releaseId||basename(journal.next.releasePath)!==journal.next.releaseId)throw new Error('Deployment release path does not match its release identity');
 assertConfigurationTopologyHash(journal.topology);
 if(journal.everActivated!==(journal.phase==='activated'||journal.phase==='fix-forward'))throw new Error('Deployment activation history is inconsistent');
 if(journal.phase!=='fix-forward'&&encode(journal.attempt.previous)!==encode(journal.old))throw new Error('Initial deployment attempt must start from the rollback identity');
 if(journal.phase==='rollback'&&!journal.checkpoints.candidate)throw new Error('Deployment rollback requires a bound candidate checkpoint');
 if(journal.old.configurationHash===journal.next.configurationHash&&journal.old.releaseId===journal.next.releaseId)throw new Error('Deployment journal does not describe a change');
 return journal;
}
function assertConfigurationTopologyHash(topology:DeploymentTopology):void{const{identity,...payload}=topology;if(digest(stable(payload))!==identity)throw new Error('Deployment topology identity does not match its contents');}

function readDeploymentJournalFile(path:string,trust:DeploymentJournalTrust={}):DeploymentJournal|undefined{
 const stat=lstatIfPresent(path);if(!stat)return undefined;
 const control=dirname(path),controlStat=lstatSync(control);if(!controlStat.isDirectory()||controlStat.isSymbolicLink()||realpathSync(control)!==resolve(control))throw new Error('Deployment control directory must be canonical');
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o022)!==0)throw new Error('Deployment journal must be one protected regular file');
 if(trust.requiredOwnerUid!==undefined&&stat.uid!==trust.requiredOwnerUid)throw new Error('Deployment journal owner changed');
 if(trust.requiredOwnerGid!==undefined&&stat.gid!==trust.requiredOwnerGid)throw new Error('Deployment journal group changed');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const opened=fstatSync(fd);if(opened.dev!==stat.dev||opened.ino!==stat.ino)throw new Error('Deployment journal changed while opening');const bytes=readFileSync(fd),after=fstatSync(fd);if(after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs)throw new Error('Deployment journal changed while reading');return parseDeploymentJournal(JSON.parse(bytes.toString('utf8')));}finally{closeSync(fd);}
}
export function readDeploymentJournal(dataDir:string,trust:DeploymentJournalTrust={}):DeploymentJournal|undefined{return readDeploymentJournalFile(deploymentJournalPath(dataDir),trust);}

function assertJournalTransition(previous:DeploymentJournal,next:DeploymentJournal):void{
 if(previous.upgradeId!==next.upgradeId||encode(previous.old)!==encode(next.old)||previous.topology.identity!==next.topology.identity||encode(previous.checkpoints.rollback)!==encode(next.checkpoints.rollback))throw new Error('Deployment journal immutable identity changed');
 if(previous.everActivated&&!next.everActivated)throw new Error('Deployment activation history cannot be cleared');
 const allowed:Record<DeploymentJournal['phase'],readonly DeploymentJournal['phase'][]>= {preparing:['preparing','candidate'],candidate:['candidate','rollback','activated'],rollback:['rollback'],activated:['activated','fix-forward'],['fix-forward']:['fix-forward']};
 if(!allowed[previous.phase].includes(next.phase))throw new Error(`Invalid deployment journal transition: ${previous.phase} -> ${next.phase}`);
 const nextChanged=encode(previous.next)!==encode(next.next),attemptChanged=previous.attempt.id!==next.attempt.id;if(nextChanged&&next.phase!=='fix-forward')throw new Error('Deployment candidate identity changed outside fix-forward');if(nextChanged!==attemptChanged)throw new Error('Deployment migration attempt must change exactly with its candidate identity');if(nextChanged&&encode(next.attempt.previous)!==encode(previous.next))throw new Error('Fix-forward attempt must start from the active candidate identity');if(!nextChanged&&encode(previous.attempt)!==encode(next.attempt))throw new Error('Deployment migration attempt changed without a new candidate');
 if(previous.checkpoints.candidate&&encode(previous.checkpoints.candidate)!==encode(next.checkpoints.candidate))throw new Error('Deployment candidate checkpoint identity changed');
}

export function writeDeploymentJournal(path:string,input:DeploymentJournal,owner?:{uid:number;gid:number}):void{
 const journal=parseDeploymentJournal(input),parent=dirname(path),parentStat=lstatSync(parent);if(!parentStat.isDirectory()||parentStat.isSymbolicLink()||realpathSync(parent)!==resolve(parent))throw new Error('Deployment journal parent must be a canonical directory');
 const previous=readDeploymentJournalFile(path,owner?{requiredOwnerUid:owner.uid,requiredOwnerGid:owner.gid}:{});if(previous)assertJournalTransition(previous,journal);else if(journal.phase!=='preparing'||journal.everActivated)throw new Error('A deployment journal must begin in the preparing phase');
 const temporary=join(parent,`.deployment-${randomUUID()}`),fd=openSync(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o640);let renamed=false;
 try{writeFileSync(fd,`${JSON.stringify(journal,null,2)}\n`);if(owner)fchownSync(fd,owner.uid,owner.gid);fchmodSync(fd,0o640);fsyncSync(fd);closeSync(fd);renameSync(temporary,path);renamed=true;syncDirectory(parent);}finally{try{closeSync(fd);}catch{/* already closed */}if(!renamed&&existsSync(temporary))unlinkSync(temporary);}
}

function assertTopologyFiles(topology:DeploymentTopology):void{
 const manifestBytes=protectedBytes(topology.workspaceManifest.path);if(digest(manifestBytes)!==topology.workspaceManifest.sha256||stable(workspaceManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8'))))!==stable(topology.workspaceManifest.value))throw new Error('Deployed workspace manifest differs from the upgrade topology');
 if(fileDigest(topology.service.unitPath)!==topology.service.sha256)throw new Error('Deployed service unit differs from the upgrade topology');
 for(const unit of topology.mountUnits){if(fileDigest(unit.unitPath)!==unit.sha256)throw new Error(`Deployed mount unit differs from the upgrade topology: ${unit.unitPath}`);const backing=lstatSync(unit.backingFile);if(!backing.isFile()||backing.isSymbolicLink()||backing.nlink!==1||backing.dev!==unit.backingDevice||backing.ino!==unit.backingInode)throw new Error(`Deployed backing file differs from the upgrade topology: ${unit.backingFile}`);}
}

export async function assertRuntimeDeploymentIdentity(journal:DeploymentJournal,runtime:RuntimeDeploymentIdentity):Promise<void>{
 const expected=journal.next;if(configurationIdentity(runtime.config)!==expected.configurationHash)throw new Error('Active configuration does not match the deployment journal');
 assertConfigurationTopology(runtime.config,journal.topology);const uid=process.getuid?.()??-1,gid=process.getgid?.()??-1;if(journal.topology.workspaceManifest.value.mounts.some(mount=>mount.ownerUid!==uid||mount.ownerGid!==gid))throw new Error('Runtime service identity does not own the deployment workspaces');assertTopologyFiles(journal.topology);
 const root=realpathSync(runtime.releaseRoot);if(root!==expected.releasePath)throw new Error('Active release path does not match the deployment journal');
 const release=await verifyRelease(root,expected.releaseId);if(release.releaseId!==expected.releaseId)throw new Error('Active release identity does not match the deployment journal');
}

export async function assertDeploymentOperationAllowed(operation:DeploymentOperation,runtime:RuntimeDeploymentIdentity,trust:DeploymentJournalTrust={}):Promise<DeploymentJournal|undefined>{
 const journal=readDeploymentJournal(runtime.config.runtime.dataDir,trust);if(!journal)return undefined;
 if(operation==='offline-probe'&&journal.phase==='candidate'&&!journal.everActivated){await assertRuntimeDeploymentIdentity(journal,runtime);return journal;}
 if((operation==='start'||operation==='offline-probe')&&(journal.phase==='activated'||journal.phase==='fix-forward')&&journal.everActivated){await assertRuntimeDeploymentIdentity(journal,runtime);return journal;}
 throw new Error(`Deployment upgrade ${journal.phase} blocks ${operation}`);
}

export function assertDeploymentRollbackAuthorization(journal:DeploymentJournal,oldConfig:DaemonConfig,newConfig:DaemonConfig,targetPath:string,currentPath:string):void{
 if(journal.everActivated||!['candidate','rollback'].includes(journal.phase))throw new Error('Activated deployment cannot restore its rollback checkpoint');
 if(configurationIdentity(oldConfig)!==journal.old.configurationHash||configurationIdentity(newConfig)!==journal.next.configurationHash)throw new Error('Deployment rollback configuration identity changed');
 assertConfigurationTopology(oldConfig,journal.topology);assertConfigurationTopology(newConfig,journal.topology);const uid=process.getuid?.()??-1,gid=process.getgid?.()??-1;if(journal.topology.workspaceManifest.value.mounts.some(mount=>mount.ownerUid!==uid||mount.ownerGid!==gid))throw new Error('Runtime service identity does not own the deployment workspaces');assertTopologyFiles(journal.topology);
 if(resolve(targetPath)!==journal.checkpoints.rollback.path||!journal.checkpoints.candidate||resolve(currentPath)!==journal.checkpoints.candidate.path)throw new Error('Deployment rollback checkpoint identity changed');
}

export function deploymentMigrationAttempt(journal:DeploymentJournal,previous:DaemonConfig,next:DaemonConfig):{upgradeId:string;attemptId:string;topologyIdentity:string}{
 if(configurationIdentity(previous)!==journal.attempt.previous.configurationHash||configurationIdentity(next)!==journal.next.configurationHash)throw new Error('Deployment migration attempt configuration identity changed');
 assertConfigurationTopology(previous,journal.topology);assertConfigurationTopology(next,journal.topology);return{upgradeId:journal.upgradeId,attemptId:journal.attempt.id,topologyIdentity:journal.topology.identity};
}

export function releaseIdentity(config:DaemonConfig,releasePath:string,releaseId:string){return releaseIdentitySchema.parse({configurationHash:configurationIdentity(config),releasePath:resolve(releasePath),releaseId});}
