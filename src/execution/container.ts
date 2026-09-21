import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {accessSync,constants,existsSync,lstatSync,readFileSync,realpathSync,unlinkSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {z} from 'zod';
import {checkedPath} from './paths.js';
import {operationSchema,type ExecutionBackend,type ExecutionRequest,type ExecutionResult,type Operation} from './backend.js';

export interface ContainerResources {memoryMb:number;cpus:number;pids:number;tmpfsMb:number}
export interface ContainerConfig {binary:string;image:string;host:string;scope:string;network?:'none'|'bridge'|undefined;resources?:ContainerResources|undefined}
export type ContainerCommandRunner=(args:string[],timeoutMs:number,signal?:AbortSignal,input?:string)=>Promise<ExecutionResult>;
export interface ContainerBackendOptions {runner?:ContainerCommandRunner|undefined;helperPath?:string|undefined;nodeBinary?:string|undefined}

const resourceSchema=z.object({memoryMb:z.number().int().min(64).max(4096),cpus:z.number().min(0.1).max(8),pids:z.number().int().min(8).max(512),tmpfsMb:z.number().int().min(1).max(1024)}).strict();
const defaultResources:ContainerResources={memoryMb:512,cpus:1,pids:64,tmpfsMb:64};

/** One short-lived, read-only container per operation. Cleanup uncertainty fences all later operations. */
export class ContainerBackend implements ExecutionBackend {
  private readonly resources:ContainerResources;
  private readonly helperPath:string;
  private readonly nodeBinary:string;
  private readonly binaryPath:string;
  private fused:string|undefined;
  constructor(private readonly config:ContainerConfig,private readonly options:ContainerBackendOptions={}){
    z.enum(['none','bridge']).parse(config.network??'none');
    z.string().startsWith('/').parse(config.binary);z.string().regex(/^sha256:[a-f0-9]{64}$/).parse(config.image);
    z.string().startsWith('unix:///').parse(config.host);z.string().regex(/^[a-z0-9-]{1,80}$/).parse(config.scope);
    this.resources=resourceSchema.parse(config.resources??defaultResources);
    this.binaryPath=realpathSync(config.binary);if(!lstatSync(this.binaryPath).isFile())throw new Error('Docker binary must be a fixed regular file');accessSync(this.binaryPath,constants.X_OK);
    const adjacent=fileURLToPath(new URL('./file-operation.mjs',import.meta.url));
    this.helperPath=realpathSync(options.helperPath??(existsSync(adjacent)?adjacent:resolve(dirname(adjacent),'../../dist/src/execution/file-operation.mjs')));
    if(!lstatSync(this.helperPath).isFile()||this.helperPath.includes(','))throw new Error('Invalid fixed file helper');
    this.nodeBinary=z.string().startsWith('/').parse(options.nodeBinary??'/usr/local/bin/node');
  }
  status():{fused:boolean;reason?:string}{return this.fused?{fused:true,reason:this.fused}:{fused:false};}

  /** Startup/offline only, after the daemon lock: remove this scope and clear the execution fuse only on confirmed success. */
  async recover():Promise<void>{
    try{
      const list=await this.command(['ps','--all','--filter',`label=mate.execution=${this.config.scope}`,'--format','{{.ID}}'],10000);
      if(list.code!==0)throw new Error('Cannot inspect orphaned containers');
      for(const id of list.stdout.trim().split('\n').filter(Boolean)){
        if(!/^[a-f0-9]{12,64}$/.test(id))throw new Error('Invalid container identity');
        const result=await this.command(['rm','--force','--volumes',id],10000);
        if(result.code!==0&&!/No such container/i.test(result.stderr))throw new Error('Cannot remove orphaned execution');
      }
      this.fused=undefined;
    }catch(error){this.fused=`Recovery failed: ${message(error)}`;throw new Error(this.fused,{cause:error});}
  }

  /** Actual startup exercise: fixed helper I/O, helper-side escape rejection and PID namespace cleanup. */
  async probe(inputRoot:string):Promise<void>{
    if(this.fused)throw new Error(`Container execution is fenced: ${this.fused}`);
    const root=realpathSync(inputRoot),name=`.mate-probe-${randomUUID()}`,outside=resolve(root,'..',name),hostPath=resolve(root,name),containerNonce=`container-${randomUUID()}`,hostNonce=`host-${randomUUID()}`;
    try{
      const write=await this.execute({root,operation:{kind:'write',path:name,content:containerNonce},timeoutMs:15000});
      if(write.code!==0)throw new Error(`File write probe failed: ${write.stderr.slice(0,500)}`);
      if(!existsSync(hostPath)||lstatSync(hostPath).isSymbolicLink()||!lstatSync(hostPath).isFile()||readFileSync(hostPath,'utf8')!==containerNonce){
        const cleanup=await this.run(root,{kind:'remove',path:name},'none',15000,false);if(cleanup.code!==0)throw new Error(`Mismatched workspace cleanup failed: ${cleanup.stderr.slice(0,500)}`);
        throw new Error('Container write is not visible in the host workspace');
      }
      writeFileSync(hostPath,hostNonce,{encoding:'utf8',flag:'w'});
      const read=await this.execute({root,operation:{kind:'read',path:name},timeoutMs:15000});
      if(read.code!==0||read.stdout!==hostNonce)throw new Error('Host write is not visible in the container workspace');
      const escape=await this.run(root,{kind:'write',path:`../${name}`,content:'escape'},'none',15000,false);
      if(escape.code===0||existsSync(outside))throw new Error('File escape probe was not rejected');
      const remove=await this.execute({root,operation:{kind:'remove',path:name},timeoutMs:15000});
      if(remove.code!==0)throw new Error(`File cleanup probe failed: ${remove.stderr.slice(0,500)}`);
      const namespace=await this.execute({root,operation:{kind:'exec',cwd:'.',command:'(/bin/sleep 30) >/dev/null 2>&1 & exit 0'},network:'none',timeoutMs:15000});
      if(namespace.code!==0)throw new Error(`PID namespace probe failed: ${namespace.stderr.slice(0,500)}`);
      const remaining=await this.command(['ps','--all','--filter',`label=mate.execution=${this.config.scope}`,'--format','{{.ID}}'],10000);
      if(remaining.code!==0||remaining.stdout.trim())throw new Error('PID namespace cleanup probe left a container');
    }catch(error){this.fused=`Startup probe failed: ${message(error)}`;throw new Error(this.fused,{cause:error});}
    finally{
      if(existsSync(resolve(root,name))){const stat=lstatSync(resolve(root,name));if(stat.isFile()&&!stat.isSymbolicLink())unlinkSync(resolve(root,name));}
    }
  }

  async execute(request:ExecutionRequest,signal?:AbortSignal):Promise<ExecutionResult>{
    if(this.fused)throw new Error(`Container execution is fenced: ${this.fused}`);
    z.literal('none').optional().parse(request.network);const op=operationSchema.parse(request.operation);
    z.number().int().min(1).max(300000).parse(request.timeoutMs);
    const root=realpathSync(request.root);if(root!==request.root||root.includes(','))throw new Error('Invalid container mount root');
    if(op.kind==='exec')checkedPath(root,op.cwd);else{checkedPath(root,op.path);if(op.kind==='move')checkedPath(root,op.destination);}
    return this.run(root,op,op.kind==='exec'?(request.network??this.config.network??'none'):'none',request.timeoutMs,true,signal);
  }

  private async run(root:string,op:Operation,network:'none'|'bridge',timeoutMs:number,_hostPathsChecked:boolean,signal?:AbortSignal):Promise<ExecutionResult>{
    const name=`mate-exec-${randomUUID()}`,deadline=Date.now()+timeoutMs,isExec=op.kind==='exec';
    const workdir=isExec?`/workspace/${relative(root,checkedPath(root,op.cwd))}`:'/workspace';
    const helperRelative=relative(root,this.helperPath);
    if(helperRelative===''||(!isAbsolute(helperRelative)&&helperRelative!=='..'&&!helperRelative.startsWith(`..${sep}`)))throw new Error('Fixed helper cannot be loaded from the writable workspace');
    const args=['create','--name',name,'--pull','never','--network',network,'--read-only','--log-driver','none','--cap-drop','ALL','--security-opt','no-new-privileges',
      '--pids-limit',String(this.resources.pids),'--memory',`${this.resources.memoryMb}m`,'--cpus',String(this.resources.cpus),
      '--user',`${process.getuid?.()??1000}:${process.getgid?.()??1000}`,'--tmpfs',`/tmp:rw,nosuid,nodev,size=${this.resources.tmpfsMb*1024*1024}`,
      '--mount',`type=bind,src=${root},dst=/workspace`,'--workdir',workdir,'--label',`mate.execution=${this.config.scope}`];
    if(!isExec)args.push('--interactive','--mount',`type=bind,src=${this.helperPath},dst=/mate-file-operation.mjs,readonly`);
    args.push(this.config.image,...(isExec?['/bin/sh','-c',op.command]:[this.nodeBinary,'/mate-file-operation.mjs','/workspace']));
    let result:ExecutionResult|undefined,failure:unknown,createOutcomeConfirmed=false;
    try{
      const create=await this.command(args,Math.max(1,deadline-Date.now()),signal);
      if(create.code!==0)throw new Error(`Container creation failed: ${create.stderr.slice(0,2000)}`);
      createOutcomeConfirmed=true;
      result=await this.command(['start','--attach',...(isExec?[]:['--interactive']),name],Math.max(1,deadline-Date.now()),signal,isExec?undefined:JSON.stringify(op));
    }catch(error){failure=error;}
    await this.cleanup(name,createOutcomeConfirmed);
    if(failure)throw failure;
    return result!;
  }

  private async cleanup(name:string,allowMissing:boolean):Promise<void>{
    try{
      const cleanup=await this.command(['rm','--force','--volumes',name],10000);
      if(cleanup.code!==0&&(!allowMissing||!/No such container/i.test(cleanup.stderr)))throw new Error(cleanup.stderr.slice(0,500));
    }catch(error){this.fused=`Container cleanup unconfirmed: ${name}: ${message(error)}`;throw new Error(this.fused,{cause:error});}
  }

  private command(args:string[],timeoutMs:number,signal?:AbortSignal,input?:string):Promise<ExecutionResult>{
    if(this.options.runner)return this.options.runner(args,timeoutMs,signal,input);
    return new Promise((resolvePromise,reject)=>{
      if(signal?.aborted){reject(new Error('Container command aborted'));return;}
      const child=spawn(this.binaryPath,['--host',this.config.host,...args],{argv0:this.config.binary,env:{PATH:'/usr/bin:/bin:/usr/local/bin',LANG:'C.UTF-8'},stdio:[input===undefined?'ignore':'pipe','pipe','pipe']});
      const stdout:Buffer[]=[],stderr:Buffer[]=[];let stdoutBytes=0,stderrBytes=0,truncated=false,interrupted=false,settled=false;
      const append=(parts:Buffer[],bytes:number,data:Buffer):number=>{const remaining=65536-bytes;if(remaining<=0){truncated=true;return bytes;}const part=data.subarray(0,remaining);parts.push(part);if(part.length<data.length)truncated=true;return bytes+part.length;};
      child.stdout!.on('data',(value:Buffer)=>{stdoutBytes=append(stdout,stdoutBytes,value);});child.stderr!.on('data',(value:Buffer)=>{stderrBytes=append(stderr,stderrBytes,value);});
      const stop=()=>{interrupted=true;child.kill('SIGKILL');};const timer=setTimeout(stop,timeoutMs);signal?.addEventListener('abort',stop,{once:true});
      const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);};
      child.once('error',error=>{if(settled)return;settled=true;finish();reject(error);});
      child.once('close',code=>{if(settled)return;settled=true;finish();if(interrupted)reject(new Error('Container command aborted or timed out'));else resolvePromise({code:code??1,stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8'),truncated});});
      if(input!==undefined){child.stdin!.on('error',()=>{});child.stdin!.end(input);}
    });
  }
}

export class ControlledBackend implements ExecutionBackend {
  constructor(private files:ExecutionBackend,private commands:ExecutionBackend){}
  execute(request:ExecutionRequest,signal?:AbortSignal):Promise<ExecutionResult>{return(request.operation.kind==='exec'?this.commands:this.files).execute(request,signal);}
}
function message(error:unknown):string{return error instanceof Error?error.message:String(error);}
