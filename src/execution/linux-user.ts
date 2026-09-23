import {spawn} from 'node:child_process';
import {existsSync, lstatSync, realpathSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {operationSchema,type ExecutionBackend,type ExecutionRequest,type ExecutionResult} from './backend.js';
import {checkedPath} from './paths.js';

export interface LinuxIdentity {uid:number;gid:number;home:string;username?:string|undefined}
const identitySchema=z.object({uid:z.number().int().nonnegative(),gid:z.number().int().nonnegative(),home:z.string().startsWith('/'),username:z.string().optional()}).strict();

/** Ordinary host execution under the Agent's Unix identity. The caller must have setuid privilege. */
export class LinuxUserBackend implements ExecutionBackend {
  private readonly identities:Readonly<Record<string,LinuxIdentity>>;
  private readonly helper:string;
  constructor(identities:Readonly<Record<string,LinuxIdentity>>,helperPath?:string){
    this.identities=Object.fromEntries(Object.entries(identities).map(([id,identity])=>[id,identitySchema.parse(identity)]));
    const adjacent=fileURLToPath(new URL('./file-operation.mjs',import.meta.url));
    this.helper=helperPath??(existsSync(adjacent)?adjacent:resolve(dirname(adjacent),'../../dist/src/execution/file-operation.mjs'));
  }
  async execute(request:ExecutionRequest,signal?:AbortSignal):Promise<ExecutionResult>{
    const op=operationSchema.parse(request.operation);
    z.number().int().min(1).max(300000).parse(request.timeoutMs);
    if(request.network==='none')throw new Error('Linux user execution cannot provide network isolation');
    const identity=request.agentId?this.identities[request.agentId]:undefined;
    if(!identity)throw new Error('Linux user identity is not configured for Agent');
    if(signal?.aborted)throw new Error('Execution aborted');
    const root=realpathSync(request.root);
    if(!lstatSync(root).isDirectory())throw new Error('Workspace root is not a directory');
    const path=checkedPath(root,op.kind==='exec'?op.cwd:op.path);
    if(op.kind==='move')checkedPath(root,op.destination);
    if(op.kind==='exec'&&!lstatSync(path).isDirectory())throw new Error('Invalid command cwd');
    const shell=op.kind==='exec',privateHome=root===realpathSync(identity.home),umask=privateHome?'077':'022';
    const program=shell?'/bin/sh':process.execPath;
    const programArgs=shell?['-c',`umask ${umask}; ${op.command}`]:[this.helper,root,umask];
    // Debian's setpriv clears supplementary groups before dropping root. A plain uid/gid spawn does not.
    const privileged=process.platform==='linux'&&process.getuid?.()===0;
    if(!privileged&&(process.getuid?.()!==identity.uid||process.getgid?.()!==identity.gid))throw new Error('Mate cannot switch to the configured Linux user');
    const command=privileged?'/usr/bin/setpriv':program;
    const args=privileged?[`--reuid=${identity.uid}`,`--regid=${identity.gid}`,'--clear-groups','--no-new-privs','--',program,...programArgs]:programArgs;
    const env={PATH:`${identity.home}/.local/bin:${identity.home}/bin:/usr/local/bin:/usr/bin:/bin`,HOME:identity.home,USER:identity.username??String(identity.uid),LOGNAME:identity.username??String(identity.uid),LANG:'C.UTF-8'};
    return new Promise((resolvePromise,reject)=>{
      const child=spawn(command,args,{cwd:shell?path:root,env,detached:true,stdio:[shell?'ignore':'pipe','pipe','pipe']});
      const stdout:Buffer[]=[],stderr:Buffer[]=[];let outBytes=0,errBytes=0,truncated=false,interrupted=false,settled=false;
      const collect=(parts:Buffer[],size:number,chunk:Buffer):number=>{const available=65536-size;if(available<=0){truncated=true;return size;}const part=chunk.subarray(0,available);parts.push(part);if(part.length<chunk.length)truncated=true;return size+part.length;};
      child.stdout!.on('data',(chunk:Buffer)=>{outBytes=collect(stdout,outBytes,chunk);});
      child.stderr!.on('data',(chunk:Buffer)=>{errBytes=collect(stderr,errBytes,chunk);});
      const stop=()=>{interrupted=true;if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{/* Already exited. */}};
      const timer=setTimeout(stop,request.timeoutMs);signal?.addEventListener('abort',stop,{once:true});
      const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);};
      child.once('error',error=>{if(settled)return;settled=true;finish();reject(error);});
      child.once('close',code=>{if(settled)return;settled=true;finish();if(interrupted)reject(new Error('Linux user execution aborted or timed out; outcome may be unknown'));else resolvePromise({code:code??1,stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8'),truncated});});
      if(!shell){child.stdin!.on('error',()=>{});child.stdin!.end(JSON.stringify(op));}
    });
  }
}
