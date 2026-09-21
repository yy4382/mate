import {closeSync,constants,fstatSync,openSync,readFileSync,lstatSync,realpathSync,statSync,statfsSync,type Stats} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {z} from 'zod';
import {within} from '../execution/paths.js';

const absolute=z.string().refine(isAbsolute,'Absolute path required');
const capacity=z.number().int().min(64*1024*1024).max(1024*1024*1024*1024).refine(value=>value%(1024*1024)===0,'MiB-aligned capacity required');
const common={root:absolute,backingFile:absolute,capacityBytes:capacity,ownerUid:z.number().int().nonnegative(),ownerGid:z.number().int().nonnegative()};
const privateMount=z.object({kind:z.literal('private'),agentId:z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),...common}).strict();
const externalMount=z.object({kind:z.literal('external'),...common}).strict();
export const workspaceManifestSchema=z.object({version:z.literal(1),mounts:z.array(z.discriminatedUnion('kind',[privateMount,externalMount])).min(1)}).strict();
export type WorkspaceManifest=z.infer<typeof workspaceManifestSchema>;

export interface PathFacts {kind:'file'|'directory'|'symlink'|'other';uid:number;gid:number;dev:number;ino:number;nlink:number;size:number;blocks:number;mode:number}
export interface FilesystemFacts {type:number;bsize:number;blocks:number;bavail:number;files:number;ffree:number}
export interface MountFacts {target:string;root:string;filesystem:string;source:string;majorMinor:string;options:readonly string[];backingFile:string}
export interface WorkspaceHost {
  read(path:string):string;
  readProtected(path:string):{text:string;facts:PathFacts};
 realpath(path:string):string;
 lstat(path:string):PathFacts;
 stat(path:string):PathFacts;
 statfs(path:string):FilesystemFacts;
 mounts():readonly MountFacts[];
 uid():number;
 gid():number;
}
export interface WorkspaceExpectation {dataDir:string;stateDir:string;agentIds:readonly string[];externalRoots:readonly string[]}
export interface VerifiedWorkspaces {manifestPath:string;roots:ReadonlyMap<string,string>;externalRoots:readonly string[];capacityByRoot:ReadonlyMap<string,number>;filesystemByRoot:ReadonlyMap<string,FilesystemFacts>;protectedPaths:readonly string[];boundaryIdentity:string}

function statFacts(value:Stats):PathFacts{
 const kind=value.isFile()?'file':value.isDirectory()?'directory':value.isSymbolicLink()?'symlink':'other';
 return{kind,uid:value.uid,gid:value.gid,dev:value.dev,ino:value.ino,nlink:value.nlink,size:value.size,blocks:value.blocks,mode:value.mode};
}
function facts(path:string,follow:boolean):PathFacts{return statFacts(follow?statSync(path):lstatSync(path));}
function decodeMount(value:string):string{return value.replace(/\\([0-7]{3})/g,(_match,digits)=>String.fromCharCode(Number.parseInt(digits,8)));}
export function parseMountInfo(text:string,read:(path:string)=>string):MountFacts[]{
 const mounts:MountFacts[]=[];
 for(const line of text.split('\n').filter(Boolean)){
  const fields=line.split(' '),separator=fields.indexOf('-');if(separator<6||fields.length<separator+4)throw new Error('Invalid Linux mountinfo');
  const majorMinor=fields[2]!,root=decodeMount(fields[3]!),target=decodeMount(fields[4]!),options=fields[5]!.split(','),filesystem=fields[separator+1]!,source=decodeMount(fields[separator+2]!);
  let backingFile='';if(source.startsWith('/dev/loop'))backingFile=decodeMount(read(`/sys/dev/block/${majorMinor}/loop/backing_file`).trim());
  mounts.push({target,root,filesystem,source,majorMinor,options,backingFile});
 }
 return mounts;
}
export function nodeWorkspaceHost():WorkspaceHost{return{
 read:path=>readFileSync(path,'utf8'),readProtected:path=>{const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const before=fstatSync(fd),text=readFileSync(fd,'utf8'),after=fstatSync(fd);if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('Workspace manifest changed while reading');return{text,facts:statFacts(after)};}finally{closeSync(fd);}},realpath:path=>realpathSync(path),lstat:path=>facts(path,false),stat:path=>facts(path,true),
 statfs:path=>{const value=statfsSync(path);return{type:value.type,bsize:value.bsize,blocks:value.blocks,bavail:value.bavail,files:value.files,ffree:value.ffree};},
 mounts:()=>parseMountInfo(readFileSync('/proc/self/mountinfo','utf8'),path=>readFileSync(path,'utf8')),
 uid:()=>process.getuid?.()??-1,gid:()=>process.getgid?.()??-1
};}

function overlap(left:string,right:string):boolean{return within(left,right)||within(right,left);}
function key(entry:WorkspaceManifest['mounts'][number]):string{return entry.kind==='private'?`private:${entry.agentId}`:`external:${resolve(entry.root)}`;}

/** Verify a deployment-created hard capacity boundary. This function never creates directories or mounts. */
export function verifyWorkspaceManifest(path:string,expected:WorkspaceExpectation,host:WorkspaceHost=nodeWorkspaceHost()):VerifiedWorkspaces{
 const manifestPath=resolve(path);if(host.realpath(manifestPath)!==manifestPath)throw new Error('Workspace manifest path must be canonical');const snapshot=host.readProtected(manifestPath),manifestStat=snapshot.facts;if(manifestStat.kind!=='file'||manifestStat.uid!==0||manifestStat.nlink!==1||(manifestStat.mode&0o022)!==0)throw new Error('Workspace manifest must be one root-owned protected regular file');
 const manifest=workspaceManifestSchema.parse(JSON.parse(snapshot.text)),entries=new Map<string,WorkspaceManifest['mounts'][number]>();
 for(const entry of manifest.mounts){const identity=key(entry);if(entries.has(identity))throw new Error('Duplicate workspace manifest entry');entries.set(identity,entry);}
 const privateExpected=new Map(expected.agentIds.map(agentId=>[agentId,host.realpath(join(expected.dataDir,'agents',agentId))] as const));
 const externalExpected=[...new Set(expected.externalRoots.map(root=>host.realpath(root)))].sort();
 if(entries.size!==privateExpected.size+externalExpected.length)throw new Error('Workspace manifest coverage mismatch');
 const roots=new Map<string,string>();
 for(const [agentId,root] of privateExpected){const entry=entries.get(`private:${agentId}`);if(!entry||entry.kind!=='private'||host.realpath(entry.root)!==root)throw new Error(`Missing private workspace mount for ${agentId}`);roots.set(agentId,root);}
 const manifestExternal=manifest.mounts.filter(entry=>entry.kind==='external').map(entry=>host.realpath(entry.root)).sort();
 if(JSON.stringify(manifestExternal)!==JSON.stringify(externalExpected))throw new Error('External workspace manifest coverage mismatch');
 const canonicalRoots=manifest.mounts.map(entry=>host.realpath(entry.root));for(let left=0;left<canonicalRoots.length;left++)for(let right=left+1;right<canonicalRoots.length;right++)if(overlap(canonicalRoots[left]!,canonicalRoots[right]!))throw new Error('Workspace roots must not overlap');
 const data=host.realpath(expected.dataDir),state=host.stat(expected.stateDir),mounts=host.mounts(),devices=new Set<number>(),backingIdentities=new Set<string>(),backingFiles:string[]=[],capacityByRoot=new Map<string,number>(),filesystemByRoot=new Map<string,FilesystemFacts>(),identities:string[]=[];
 for(const entry of manifest.mounts){
  const root=host.realpath(entry.root),backing=host.realpath(entry.backingFile),rootLink=host.lstat(entry.root),backingLink=host.lstat(entry.backingFile);
  if(root!==resolve(entry.root)||rootLink.kind!=='directory')throw new Error('Workspace mountpoint must be a canonical directory');
  if(backing!==resolve(entry.backingFile)||backingLink.kind!=='file'||backingLink.nlink!==1||(backingLink.mode&0o022)!==0)throw new Error('Workspace backing file must be one protected canonical regular file');
  const backingIdentity=`${backingLink.dev}:${backingLink.ino}`;if(backingFiles.includes(backing)||backingIdentities.has(backingIdentity))throw new Error('Workspace mounts must use distinct backing files');backingIdentities.add(backingIdentity);
  if(within(data,backing)||manifest.mounts.some(other=>overlap(host.realpath(other.root),backing)))throw new Error('Workspace backing file must be outside live and granted roots');
  if(backingLink.size!==entry.capacityBytes||backingLink.blocks*512<entry.capacityBytes)throw new Error('Workspace backing file is sparse or has the wrong capacity');
  const rootStat=host.stat(root);if(rootStat.uid!==entry.ownerUid||rootStat.gid!==entry.ownerGid||rootStat.uid!==host.uid()||rootStat.gid!==host.gid()||(rootStat.mode&0o077)!==0)throw new Error('Workspace mount owner or mode does not match the daemon');
  if(rootStat.dev===state.dev||devices.has(rootStat.dev))throw new Error('Workspace mount must use a distinct filesystem');devices.add(rootStat.dev);
  const matches=mounts.filter(mount=>resolve(mount.target)===root);if(matches.length!==1)throw new Error('Workspace root is not one exact mountpoint');
  const mount=matches[0]!;if(mount.root!=='/'||mount.filesystem!=='ext4'||!mount.source.startsWith('/dev/loop')||!mount.options.includes('rw')||!mount.options.includes('nodev')||!mount.options.includes('nosuid'))throw new Error('Workspace mount is not the required ext4 loopback boundary');
  if(host.realpath(mount.backingFile)!==backing)throw new Error('Workspace loopback identity does not match its manifest');
  const filesystem=host.statfs(root),total=BigInt(filesystem.bsize)*BigInt(filesystem.blocks),declared=BigInt(entry.capacityBytes),metadataAllowance=declared/10n>16n*1024n*1024n?declared/10n:16n*1024n*1024n;
  if(filesystem.type!==0xef53||total>declared||total+metadataAllowance<declared)throw new Error('Workspace filesystem capacity does not match its manifest');
  identities.push(JSON.stringify({key:key(entry),root,rootDevice:rootStat.dev,backing,backingIdentity,majorMinor:mount.majorMinor,capacityBytes:entry.capacityBytes}));
  backingFiles.push(backing);capacityByRoot.set(root,entry.capacityBytes);filesystemByRoot.set(root,filesystem);
 }
 return{manifestPath:host.realpath(manifestPath),roots,externalRoots:externalExpected,capacityByRoot,filesystemByRoot,protectedPaths:[host.realpath(manifestPath),...backingFiles],boundaryIdentity:identities.sort().join('\n')};
}
