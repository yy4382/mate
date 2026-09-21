import {afterEach,expect,it,vi} from 'vitest';
import {chmodSync,mkdtempSync,realpathSync,rmSync,writeFileSync,readFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {ContainerBackend,type ContainerCommandRunner} from '../../src/execution/container.js';

const roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const result=(stdout='',code=0,stderr='')=>({code,stdout,stderr,truncated:false});
function root(){const value=realpathSync(mkdtempSync(`${tmpdir()}/mate-container-unit-`));roots.push(value);return value;}
function config(){const directory=root(),binary=`${directory}/docker`;writeFileSync(binary,'synthetic');chmodSync(binary,0o700);return{binary,host:'unix:///var/run/docker.sock',image:`sha256:${'a'.repeat(64)}`,scope:'mate-unit',network:'bridge' as const,resources:{memoryMb:128,cpus:0.5,pids:16,tmpfsMb:8}};}
const helper=()=>resolve('dist/src/execution/file-operation.mjs');

it('runs fixed file and shell operations with one hardened resource-configured container each',async()=>{
  const calls:{args:string[];input?:string}[]=[];
  const runner:ContainerCommandRunner=async(args,_timeout,_signal,input)=>{calls.push({args,...(input===undefined?{}:{input})});return args[0]==='start'?result(input?'file-result':'shell-result'):result();};
  const backend=new ContainerBackend(config(),{runner,helperPath:helper()});const workspace=root();
  expect((await backend.execute({root:workspace,operation:{kind:'read',path:'MEMORY.md'},timeoutMs:1000})).stdout).toBe('file-result');
  expect((await backend.execute({root:workspace,operation:{kind:'exec',cwd:'.',command:'printf ok'},timeoutMs:1000})).stdout).toBe('shell-result');
  const [fileCreate,fileStart,fileRemove,execCreate,execStart,execRemove]=calls.map(call=>call.args);
  expect(fileCreate).toEqual(expect.arrayContaining(['--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','16','--memory','128m','--cpus','0.5','--tmpfs',`/tmp:rw,nosuid,nodev,size=${8*1024*1024}`,'--interactive','/usr/local/bin/node','/mate-file-operation.mjs','/workspace']));
  expect(fileCreate!.join(' ')).toContain(`src=${helper()}`);expect(calls[1]!.input).toBe(JSON.stringify({kind:'read',path:'MEMORY.md'}));
  expect(fileStart!.slice(0,3)).toEqual(['start','--attach','--interactive']);expect(fileRemove!.slice(0,3)).toEqual(['rm','--force','--volumes']);
  expect(execCreate).toEqual(expect.arrayContaining(['--network','bridge','/bin/sh','-c','printf ok']));expect(execCreate).not.toContain('--interactive');expect(calls[4]!.input).toBeUndefined();
  expect(execStart!.slice(0,2)).toEqual(['start','--attach']);expect(execRemove!.slice(0,3)).toEqual(['rm','--force','--volumes']);
});

it('always cleans after start failure and fences new work when cleanup cannot be confirmed until recover succeeds',async()=>{
  let startFails=true,cleanupFails=false,recovery=false;const calls:string[][]=[];
  const runner:ContainerCommandRunner=async args=>{calls.push(args);
    if(args[0]==='start'&&startFails)throw new Error('synthetic start loss');
    if(args[0]==='ps')return result(recovery?'abcdef123456\n':'');
    if(args[0]==='rm'&&cleanupFails)return result('',1,'daemon unavailable');
    return result('ok');
  };
  const backend=new ContainerBackend(config(),{runner,helperPath:helper()}),workspace=root(),request={root:workspace,operation:{kind:'exec' as const,cwd:'.',command:'work'},timeoutMs:1000};
  await expect(backend.execute(request)).rejects.toThrow('synthetic start loss');expect(backend.status()).toEqual({fused:false});expect(calls.at(-1)![0]).toBe('rm');
  startFails=false;cleanupFails=true;await expect(backend.execute(request)).rejects.toThrow('cleanup unconfirmed');expect(backend.status().fused).toBe(true);
  const before=calls.length;await expect(backend.execute(request)).rejects.toThrow('fenced');expect(calls).toHaveLength(before);
  cleanupFails=false;recovery=true;await backend.recover();expect(backend.status()).toEqual({fused:false});await expect(backend.execute(request)).resolves.toMatchObject({code:0});
  expect(calls.some(args=>args[0]==='rm'&&args.at(-1)==='abcdef123456')).toBe(true);
});

it('treats a missing container as unconfirmed when create threw or returned a transport-like failure',async()=>{
  for(const mode of ['throw','nonzero'] as const){
    const runner:ContainerCommandRunner=async args=>{if(args[0]==='create'){if(mode==='throw')throw new Error('create transport lost');return result('',1,'unexpected EOF from daemon');}if(args[0]==='rm')return result('',1,'No such container');return result();};
    const backend=new ContainerBackend(config(),{runner,helperPath:helper()}),workspace=root();
    await expect(backend.execute({root:workspace,operation:{kind:'exec',cwd:'.',command:'work'},timeoutMs:1000})).rejects.toThrow('cleanup unconfirmed');
    expect(backend.status().fused).toBe(true);
  }
});

it('returns deterministic OOM or ENOSPC exits after confirmed cleanup without poisoning later work',async()=>{
  const exits=[result('',137,'Killed'),result('',1,'No space left on device'),result('recovered')];
  const runner:ContainerCommandRunner=async args=>args[0]==='start'?exits.shift()!:result();
  const backend=new ContainerBackend(config(),{runner,helperPath:helper()}),workspace=root(),request={root:workspace,operation:{kind:'exec' as const,cwd:'.',command:'work'},timeoutMs:1000};
  await expect(backend.execute(request)).resolves.toMatchObject({code:137});await expect(backend.execute(request)).resolves.toMatchObject({code:1,stderr:expect.stringContaining('No space')});
  await expect(backend.execute(request)).resolves.toMatchObject({code:0,stdout:'recovered'});expect(backend.status()).toEqual({fused:false});
});

it('startup probe exercises helper I/O, helper-side traversal rejection and namespace cleanup',async()=>{
  const inputs:unknown[]=[];let currentCreate:string[]=[],workspace='';
  const runner:ContainerCommandRunner=async(args,_timeout,_signal,input)=>{
    if(args[0]==='create'){currentCreate=args;return result();}
    if(args[0]==='rm'||args[0]==='ps')return result();
    if(args[0]!=='start')return result();
    if(input===undefined){expect(currentCreate).toContain('/bin/sh');return result();}
    const op=JSON.parse(input) as any;inputs.push(op);
    if(String(op.path).startsWith('../'))return result('',1,'Path escapes root');
    if(op.kind==='write'){writeFileSync(`${workspace}/${op.path}`,op.content);return result('{"sha256":"synthetic"}');}
    if(op.kind==='read')return result(readFileSync(`${workspace}/${op.path}`,'utf8'));
    if(op.kind==='remove'){unlinkSync(`${workspace}/${op.path}`);return result('{}');}
    return result();
  };
  const backend=new ContainerBackend(config(),{runner,helperPath:helper()});await backend.recover();workspace=root();await backend.probe(workspace);
  expect(inputs.map((input:any)=>input.kind)).toEqual(['write','read','write','remove']);expect((inputs[2] as any).path).toMatch(/^\.\.\/\.mate-probe-/);expect(backend.status()).toEqual({fused:false});
});

it('startup probe rejects a Docker daemon whose bind source is not the host workspace',async()=>{
  const isolated=new Map<string,string>();
  const runner:ContainerCommandRunner=async(args,_timeout,_signal,input)=>{if(args[0]!=='start'||input===undefined)return result();const op=JSON.parse(input) as any;if(op.kind==='write'){isolated.set(op.path,op.content);return result('{}');}if(op.kind==='read')return result(isolated.get(op.path));if(op.kind==='remove'){isolated.delete(op.path);return result('{}');}return result();};
  const backend=new ContainerBackend(config(),{runner,helperPath:helper()});await backend.recover();await expect(backend.probe(root())).rejects.toThrow('not visible in the host workspace');expect(backend.status().fused).toBe(true);expect(isolated.size).toBe(0);
});
