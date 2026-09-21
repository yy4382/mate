import {afterEach,expect,it,vi} from 'vitest';
import {chmodSync,existsSync,mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseMountInfo,verifyWorkspaceManifest,type MountFacts,type PathFacts,type WorkspaceHost,type WorkspaceManifest} from '../../src/deployment/workspaces.js';
import {Daemon} from '../../src/daemon/app.js';
import {ContainerBackend} from '../../src/execution/container.js';
import {configSchema} from '../../src/config.js';
import {daemonConfigSchema} from '../../src/daemon/config.js';
import {DeploymentBoundaryBackend} from '../../src/deployment/runtime.js';
import {configFixture} from '../helpers/config.js';

const capacity=512*1024*1024,manifestPath='/etc/mate/workspaces.json',data='/var/lib/mate',state=`${data}/state`;
function entry(kind:'private'|'external',root:string,backingFile:string,agentId?:string):WorkspaceManifest['mounts'][number]{return{kind,...(kind==='private'?{agentId:agentId!}:{}),root,backingFile,capacityBytes:capacity,ownerUid:1000,ownerGid:1000} as WorkspaceManifest['mounts'][number];}
function fixture(){
 const manifest:WorkspaceManifest={version:1,mounts:[entry('private',`${data}/agents/research`,'/var/lib/mate-volumes/research.ext4','research'),entry('private',`${data}/agents/writer`,'/var/lib/mate-volumes/writer.ext4','writer'),entry('external','/srv/project','/var/lib/mate-volumes/project.ext4')]};
 const pathFacts=new Map<string,PathFacts>([[manifestPath,{kind:'file',uid:0,gid:1000,dev:1,ino:1,nlink:1,size:100,blocks:8,mode:0o100640}],[data,{kind:'directory',uid:1000,gid:1000,dev:1,ino:2,nlink:1,size:0,blocks:0,mode:0o40700}],[state,{kind:'directory',uid:1000,gid:1000,dev:1,ino:3,nlink:1,size:0,blocks:0,mode:0o40700}]]);
 const mounts:MountFacts[]=[];let dev=100;
 for(const mount of manifest.mounts){dev++;pathFacts.set(mount.root,{kind:'directory',uid:1000,gid:1000,dev,ino:dev,nlink:1,size:0,blocks:0,mode:0o40700});pathFacts.set(mount.backingFile,{kind:'file',uid:0,gid:0,dev:1,ino:dev,nlink:1,size:capacity,blocks:capacity/512,mode:0o100600});mounts.push({target:mount.root,root:'/',filesystem:'ext4',source:`/dev/loop${dev}`,majorMinor:`7:${dev}`,options:['rw','nosuid','nodev'],backingFile:mount.backingFile});}
 const host:WorkspaceHost={read:path=>{if(path===manifestPath)return JSON.stringify(manifest);throw new Error(`unexpected read ${path}`);},readProtected:path=>{const value=pathFacts.get(path);if(!value)throw new Error('missing');return{text:JSON.stringify(manifest),facts:value};},realpath:path=>path,lstat:path=>{const value=pathFacts.get(path);if(!value)throw Object.assign(new Error('missing'),{code:'ENOENT'});return value;},stat:path=>{const value=pathFacts.get(path);if(!value)throw Object.assign(new Error('missing'),{code:'ENOENT'});return value;},statfs:()=>({type:0xef53,bsize:4096,blocks:Math.floor(capacity*.95/4096),bavail:Math.floor(capacity*.9/4096),files:16384,ffree:16000}),mounts:()=>mounts,uid:()=>1000,gid:()=>1000};
 return{manifest,pathFacts,mounts,host};
}
afterEach(()=>vi.restoreAllMocks());

it('accepts exact independent preallocated ext4 loopback mounts and returns their control paths',()=>{
 const f=fixture(),verified=verifyWorkspaceManifest(manifestPath,{dataDir:data,stateDir:state,agentIds:['research','writer'],externalRoots:['/srv/project']},f.host);
 expect([...verified.roots]).toEqual([['research',`${data}/agents/research`],['writer',`${data}/agents/writer`]]);expect(verified.externalRoots).toEqual(['/srv/project']);expect(verified.protectedPaths).toEqual([manifestPath,...f.manifest.mounts.map(item=>item.backingFile)]);
});

it('accepts equivalent systemd hardening mount layers but rejects a conflicting stack',()=>{
 const f=fixture();f.mounts.push({...f.mounts[0]!});
 expect(()=>verifyWorkspaceManifest(manifestPath,{dataDir:data,stateDir:state,agentIds:['research','writer'],externalRoots:['/srv/project']},f.host)).not.toThrow();
 f.mounts.push({...f.mounts[0]!,source:'/dev/loop999',majorMinor:'7:999'});
 expect(()=>verifyWorkspaceManifest(manifestPath,{dataDir:data,stateDir:state,agentIds:['research','writer'],externalRoots:['/srv/project']},f.host)).toThrow('conflicting mount layers');
});

it('accepts ext4 metadata overhead at the 64 MiB minimum and enforces the 16 MiB allowance',()=>{
 const minimum=64*1024*1024,prepare=(usable:number)=>{const f=fixture();for(const entry of f.manifest.mounts){entry.capacityBytes=minimum;const backing=f.pathFacts.get(entry.backingFile)!;backing.size=minimum;backing.blocks=minimum/512;}f.host.statfs=()=>({type:0xef53,bsize:4096,blocks:usable/4096,bavail:Math.max(0,usable/4096-1024),files:16384,ffree:16000});return f;};
 const representative=prepare(55*1024*1024);expect(()=>verifyWorkspaceManifest(manifestPath,{dataDir:data,stateDir:state,agentIds:['research','writer'],externalRoots:['/srv/project']},representative.host)).not.toThrow();
 const boundary=prepare(minimum-16*1024*1024);expect(()=>verifyWorkspaceManifest(manifestPath,{dataDir:data,stateDir:state,agentIds:['research','writer'],externalRoots:['/srv/project']},boundary.host)).not.toThrow();
 const undersized=prepare(minimum-16*1024*1024-4096);expect(()=>verifyWorkspaceManifest(manifestPath,{dataDir:data,stateDir:state,agentIds:['research','writer'],externalRoots:['/srv/project']},undersized.host)).toThrow('capacity');
});

it.each([
 ['missing mount',(f:ReturnType<typeof fixture>)=>f.mounts.pop(),'exact mountpoint'],
 ['shared device',(f:ReturnType<typeof fixture>)=>{f.pathFacts.get(`${data}/agents/writer`)!.dev=101;},'distinct filesystem'],
 ['sparse image',(f:ReturnType<typeof fixture>)=>{f.pathFacts.get('/var/lib/mate-volumes/research.ext4')!.blocks=1;},'sparse'],
 ['untrusted manifest',(f:ReturnType<typeof fixture>)=>{f.pathFacts.get(manifestPath)!.uid=1000;},'root-owned'],
 ['wrong owner',(f:ReturnType<typeof fixture>)=>{f.pathFacts.get(`${data}/agents/research`)!.uid=0;},'owner'],
 ['unsafe mount',(f:ReturnType<typeof fixture>)=>{f.mounts[0]!.options=['rw'];},'ext4 loopback'],
 ['undersized filesystem',(f:ReturnType<typeof fixture>)=>{f.host.statfs=()=>({type:0xef53,bsize:4096,blocks:(capacity-52*1024*1024)/4096,bavail:(capacity-60*1024*1024)/4096,files:16384,ffree:16000});},'capacity'],
 ['oversized filesystem',(f:ReturnType<typeof fixture>)=>{f.host.statfs=()=>({type:0xef53,bsize:4096,blocks:capacity/4096+1,bavail:capacity/4096,files:16384,ffree:16000});},'capacity']
] as const)('rejects %s instead of accepting an ordinary or unbounded directory',(_name,mutate,message)=>{
 const f=fixture();mutate(f);expect(()=>verifyWorkspaceManifest(manifestPath,{dataDir:data,stateDir:state,agentIds:['research','writer'],externalRoots:['/srv/project']},f.host)).toThrow(message);
});

it('rejects nested roots and reused backing identities before a parent bind can expose a peer mount',()=>{
 const nested=fixture(),external=nested.manifest.mounts[2]!;external.root=`${data}/agents`;nested.pathFacts.set(external.root,{kind:'directory',uid:1000,gid:1000,dev:103,ino:103,nlink:1,size:0,blocks:0,mode:0o40700});
 expect(()=>verifyWorkspaceManifest(manifestPath,{dataDir:data,stateDir:state,agentIds:['research','writer'],externalRoots:[external.root]},nested.host)).toThrow('must not overlap');
 const repeated=fixture();repeated.manifest.mounts[1]!.backingFile=repeated.manifest.mounts[0]!.backingFile;
 expect(()=>verifyWorkspaceManifest(manifestPath,{dataDir:data,stateDir:state,agentIds:['research','writer'],externalRoots:['/srv/project']},repeated.host)).toThrow('distinct backing');
 const inodeAlias=fixture(),alias='/var/lib/mate-volumes/writer-alias.ext4',original=inodeAlias.pathFacts.get('/var/lib/mate-volumes/research.ext4')!;inodeAlias.manifest.mounts[1]!.backingFile=alias;inodeAlias.pathFacts.set(alias,{...original});inodeAlias.mounts[1]!.backingFile=alias;
 expect(()=>verifyWorkspaceManifest(manifestPath,{dataDir:data,stateDir:state,agentIds:['research','writer'],externalRoots:['/srv/project']},inodeAlias.host)).toThrow('distinct backing');
});

it('parses escaped Linux mountinfo and resolves loop backing identity through sysfs',()=>{
 const line='42 31 7:4 / /var/lib/mate/agents/research rw,nosuid,nodev - ext4 /dev/loop4 rw\n43 31 8:1 / /srv/project\\040one rw - xfs /dev/sda1 rw\n';
 expect(parseMountInfo(line,path=>{expect(path).toBe('/sys/dev/block/7:4/loop/backing_file');return '/var/lib/mate-volumes/research.ext4\n';})).toEqual([
  {target:'/var/lib/mate/agents/research',root:'/',filesystem:'ext4',source:'/dev/loop4',majorMinor:'7:4',options:['rw','nosuid','nodev'],backingFile:'/var/lib/mate-volumes/research.ext4'},
  {target:'/srv/project one',root:'/',filesystem:'xfs',source:'/dev/sda1',majorMinor:'8:1',options:['rw'],backingFile:''}
 ]);
});

it('revalidates the deployment boundary before every operation and fails after an unmount',async()=>{
 const f=fixture();f.manifest.mounts=f.manifest.mounts.filter(item=>item.kind!=='private'||item.agentId==='research');f.mounts.splice(1,1);
 const execute=vi.fn(async()=>({code:0,stdout:'ok',stderr:'',truncated:false})),config=daemonConfigSchema.parse({mate:configFixture,runtime:{dataDir:data,workspaceManifest:manifestPath,docker:{binary:'/usr/bin/docker',host:'unix:///var/run/docker.sock',image:`sha256:${'a'.repeat(64)}`},workspaceGrants:[{agentId:'research',root:'/srv/project',operations:['read']}],researchHosts:[]}}),environment={platform:'linux' as const,workspaceHost:f.host},startup=verifyWorkspaceManifest(manifestPath,{dataDir:data,stateDir:state,agentIds:['research'],externalRoots:['/srv/project']},f.host),backend=new DeploymentBoundaryBackend({execute},config,environment,startup),request={root:`${data}/agents/research`,operation:{kind:'read' as const,path:'MEMORY.md'},timeoutMs:1000};
 await expect(backend.execute(request)).resolves.toMatchObject({code:0});f.mounts.shift();await expect(backend.execute(request)).rejects.toThrow('exact mountpoint');expect(execute).toHaveBeenCalledOnce();
});

it('requires restart when a newly valid manifest changes the startup boundary identity',async()=>{
 const f=fixture();f.manifest.mounts=f.manifest.mounts.filter(item=>item.kind!=='private'||item.agentId==='research');f.mounts.splice(1,1);
 const config=daemonConfigSchema.parse({mate:configFixture,runtime:{dataDir:data,workspaceManifest:manifestPath,docker:{binary:'/usr/bin/docker',host:'unix:///var/run/docker.sock',image:`sha256:${'a'.repeat(64)}`},workspaceGrants:[{agentId:'research',root:'/srv/project',operations:['read']}],researchHosts:[]}}),environment={platform:'linux' as const,workspaceHost:f.host},startup=verifyWorkspaceManifest(manifestPath,{dataDir:data,stateDir:state,agentIds:['research'],externalRoots:['/srv/project']},f.host),execute=vi.fn(async()=>({code:0,stdout:'ok',stderr:'',truncated:false})),backend=new DeploymentBoundaryBackend({execute},config,environment,startup),replacement='/var/lib/mate-volumes/research-replacement.ext4',original=f.pathFacts.get('/var/lib/mate-volumes/research.ext4')!;
 f.manifest.mounts[0]!.backingFile=replacement;f.pathFacts.set(replacement,{...original,ino:999});f.mounts[0]!.backingFile=replacement;
 await expect(backend.execute({root:`${data}/agents/research`,operation:{kind:'read',path:'MEMORY.md'},timeoutMs:1000})).rejects.toThrow('changed since startup');expect(execute).not.toHaveBeenCalled();
});

it('Linux daemon fails closed before creating ordinary Agent directories when the manifest is absent',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mate-workspace-required-'))),project=join(root,'checkout'),binary=join(root,'docker');mkdirSync(project);writeFileSync(binary,'synthetic');chmodSync(binary,0o700);vi.spyOn(ContainerBackend.prototype,'recover').mockResolvedValue();
 const config={mate:configSchema.parse(configFixture),runtime:{dataDir:join(root,'data'),docker:{binary,host:`unix://${join(root,'docker.sock')}`,image:`sha256:${'a'.repeat(64)}`},workspaceGrants:[],researchHosts:[]}};
 try{await expect(Daemon.create(config,{info:()=>{},error:()=>{}},project,{platform:'linux',workspaceHost:fixture().host})).rejects.toThrow('requires a workspace manifest');expect(existsSync(join(root,'data','agents'))).toBe(false);}
 finally{rmSync(root,{recursive:true,force:true});}
});

it('Linux daemon verifies mounts before writing Agent workspace contents',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mate-workspace-start-'))),project=join(root,'checkout'),dataDir=join(root,'data'),agents=join(dataDir,'agents'),external=join(root,'shared'),binary=join(root,'docker'),manifest=join(root,'workspaces.json');mkdirSync(project);mkdirSync(join(agents,'research'),{recursive:true});mkdirSync(external);writeFileSync(binary,'synthetic');chmodSync(binary,0o700);writeFileSync(manifest,'synthetic');
 const base=fixture(),privateEntry=entry('private',join(agents,'research'),join(root,'research.ext4'),'research'),externalEntry=entry('external',external,join(root,'shared.ext4')),deployment:WorkspaceManifest={version:1,mounts:[privateEntry,externalEntry]};for(const item of deployment.mounts)writeFileSync(item.backingFile,'synthetic');
 const rootFacts:PathFacts={kind:'directory',uid:1000,gid:1000,dev:101,ino:101,nlink:1,size:0,blocks:0,mode:0o40700},externalFacts:PathFacts={...rootFacts,dev:102,ino:102},fileFacts:PathFacts={kind:'file',uid:0,gid:0,dev:1,ino:201,nlink:1,size:capacity,blocks:capacity/512,mode:0o100600},externalFileFacts:PathFacts={...fileFacts,ino:202};
 const host:WorkspaceHost={...base.host,read:path=>path===manifest?JSON.stringify(deployment):base.host.read(path),readProtected:path=>path===manifest?{text:JSON.stringify(deployment),facts:{...fileFacts,size:10,blocks:1}}:base.host.readProtected(path),realpath:path=>path,lstat:path=>path===manifest?{...fileFacts,size:10,blocks:1}:path===join(agents,'research')?rootFacts:path===external?externalFacts:path===privateEntry.backingFile?fileFacts:path===externalEntry.backingFile?externalFileFacts:path===dataDir||path===join(dataDir,'state')?{...rootFacts,dev:1}:base.host.lstat(path),stat:path=>path===join(agents,'research')?rootFacts:path===external?externalFacts:path===join(dataDir,'state')?{...rootFacts,dev:1}:base.host.stat(path),mounts:()=>deployment.mounts.map((item,index)=>({target:item.root,root:'/',filesystem:'ext4',source:`/dev/loop${index+1}`,majorMinor:`7:${index+1}`,options:['rw','nosuid','nodev'],backingFile:item.backingFile}))};
 const recover=vi.spyOn(ContainerBackend.prototype,'recover').mockResolvedValue(),probe=vi.spyOn(ContainerBackend.prototype,'probe').mockResolvedValue();const config={mate:configSchema.parse(configFixture),runtime:{dataDir:dataDir,workspaceManifest:manifest,docker:{binary,host:`unix://${join(root,'docker.sock')}`,image:`sha256:${'a'.repeat(64)}`},workspaceGrants:[{agentId:'research',root:external,operations:['read']}],researchHosts:[]}};
 const daemon=await Daemon.create(config,{info:()=>{},error:()=>{}},project,{platform:'linux',workspaceHost:host}),saved=process.env.MODEL_API_KEY;process.env.MODEL_API_KEY='synthetic';
 try{expect(existsSync(join(agents,'research','MEMORY.md'))).toBe(true);await expect(daemon.start()).rejects.toThrow('Unknown provider/model');expect(probe.mock.calls.map(call=>call[0])).toEqual([join(agents,'research'),external]);expect(recover.mock.calls.length).toBeGreaterThanOrEqual(2);}
 finally{if(saved===undefined)delete process.env.MODEL_API_KEY;else process.env.MODEL_API_KEY=saved;await daemon.close();rmSync(root,{recursive:true,force:true});}
});
