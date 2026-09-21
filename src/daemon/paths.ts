import { accessSync,constants,existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename,dirname,join, resolve } from 'node:path';
import {within} from '../execution/paths.js';
import { hash } from '../storage/store.js';
/** Identical scope for live startup, offline recovery, and backups even through parent aliases. */
export function executionScope(dataDir: string): string { return `mate-${hash(realpathSync(dataDir)).slice(0, 24)}`; }

export interface DockerControlPaths {binary:string;host:string}
interface WorkspaceRoot {root:string}
export function dockerSocketPath(host:string):string{
 const url=new URL(host);if(url.protocol!=='unix:'||url.username||url.password||url.search||url.hash||!url.pathname.startsWith('/')||url.pathname.includes('\0'))throw new Error('Invalid Docker host socket');
 return decodeURIComponent(url.pathname);
}
/** Preserve both the configured pathname and its physical target, including symlinked existing parents. */
export function pathVariants(path:string):string[]{
 const raw=resolve(path),tail:string[]=[];let current=raw;
 while(!existsSync(current)){const parent=dirname(current);if(parent===current)return[raw];tail.unshift(basename(current));current=parent;}
 const physical=resolve(realpathSync(current),...tail);return raw===physical?[raw]:[raw,physical];
}
function overlaps(left:string,right:string):boolean{return within(left,right)||within(right,left);}
/** Must run before invoking Docker: reject lexical/canonical control overlap without requiring workspaces to exist. */
export function assertDockerControlIsolation(projectRoot:string,state:string,agentsDir:string,workspaces:readonly WorkspaceRoot[],docker?:DockerControlPaths):void{
 if(!docker)return;
 const controls=[docker.binary,dockerSocketPath(docker.host)].flatMap(pathVariants),privateRoots=pathVariants(agentsDir);
 if(privateRoots.some(root=>controls.some(control=>overlaps(root,control))))throw new Error('Protected root overlap');
 const protectedRoots=executionProtectedPaths(projectRoot,state,agentsDir,docker);
 for(const workspace of workspaces)if(pathVariants(workspace.root).some(root=>protectedRoots.some(protectedPath=>overlaps(root,protectedPath))))throw new Error('Protected root overlap');
}
/** Roots that an Agent grant must never contain or be contained by. */
export function executionProtectedPaths(projectRoot:string,state:string,agentsDir:string,docker?:DockerControlPaths):string[]{
 const home=homedir(),paths=[projectRoot,state,agentsDir,'/proc','/sys','/dev','/run','/var/run',
  join(home,'.ssh'),join(home,'.gnupg'),join(home,'.docker'),join(home,'.aws'),join(home,'.kube'),join(home,'.netrc'),join(home,'.npmrc'),join(home,'.pypirc')];
 const credentials=process.env.CREDENTIALS_DIRECTORY;if(credentials?.startsWith('/'))paths.push(credentials);
 if(docker){
  const binary=realpathSync(docker.binary);if(!lstatSync(binary).isFile())throw new Error('Docker binary must be a fixed regular file');accessSync(binary,constants.X_OK);
  paths.push(docker.binary,binary,dockerSocketPath(docker.host));
 }
 return [...new Set(paths.flatMap(pathVariants))];
}
