import {afterEach, expect, it} from 'vitest';
import {mkdtempSync, readFileSync, realpathSync, rmSync, statSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {join} from 'node:path';
import {LinuxUserBackend} from '../../src/execution/linux-user.js';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function workspace(){const root=realpathSync(mkdtempSync(join(tmpdir(),'mate-linux-user-')));roots.push(root);return root;}
const identity={uid:process.getuid!(),gid:process.getgid!(),home:homedir()};

it('runs file tools and shell under one stable host identity and path',async()=>{
  const root=workspace(),backend=new LinuxUserBackend({alice:identity});
  const request={agentId:'alice',root,timeoutMs:5000};
  const write=await backend.execute({...request,operation:{kind:'write',path:'note.txt',content:'from file tool'}});
  expect(write.code).toBe(0);
  const shell=await backend.execute({...request,operation:{kind:'exec',cwd:'.',command:'printf "%s\\n" "$HOME" "$PWD" "$(id -u)"; cat note.txt'}});
  expect(shell).toMatchObject({code:0,stdout:`${identity.home}\n${root}\n${identity.uid}\nfrom file tool`});
  const created=await backend.execute({...request,operation:{kind:'exec',cwd:'.',command:'printf from-shell > shell.txt'}});
  expect(created.code).toBe(0);
  expect((await backend.execute({...request,operation:{kind:'read',path:'shell.txt'}})).stdout).toBe('from-shell');
  expect(readFileSync(join(root,'shell.txt'),'utf8')).toBe('from-shell');
});

it('rejects missing identity, forbidden review networking and escaped cwd before spawn',async()=>{
  const root=workspace(),backend=new LinuxUserBackend({alice:identity});
  await expect(backend.execute({agentId:'bob',root,timeoutMs:1000,operation:{kind:'exec',cwd:'.',command:'id'}})).rejects.toThrow('Linux user');
  await expect(backend.execute({agentId:'alice',root,timeoutMs:1000,network:'none',operation:{kind:'exec',cwd:'.',command:'id'}})).rejects.toThrow('network isolation');
  await expect(backend.execute({agentId:'alice',root,timeoutMs:1000,operation:{kind:'exec',cwd:'..',command:'id'}})).rejects.toThrow('escapes root');
});

it('does not inherit the Mate process environment',async()=>{
  const root=workspace(),backend=new LinuxUserBackend({alice:identity});
  process.env.MATE_LINUX_USER_SECRET_TEST='control-secret';
  try{
    const result=await backend.execute({agentId:'alice',root,timeoutMs:5000,operation:{kind:'exec',cwd:'.',command:'printf "%s" "${MATE_LINUX_USER_SECRET_TEST-unset}"'}});
    expect(result).toMatchObject({code:0,stdout:'unset'});
  }finally{delete process.env.MATE_LINUX_USER_SECRET_TEST;}
});

it('creates peer-readable work products without making private home files peer-readable',async()=>{
  const privateRoot=workspace(),shared=workspace(),backend=new LinuxUserBackend({alice:{...identity,home:privateRoot}});
  for(const root of [privateRoot,shared]){
    expect((await backend.execute({agentId:'alice',root,timeoutMs:5000,operation:{kind:'write',path:'file.txt',content:'work'}})).code).toBe(0);
    expect((await backend.execute({agentId:'alice',root,timeoutMs:5000,operation:{kind:'exec',cwd:'.',command:'printf work > shell.txt'}})).code).toBe(0);
  }
  expect(statSync(join(privateRoot,'file.txt')).mode&0o777).toBe(0o600);
  expect(statSync(join(privateRoot,'shell.txt')).mode&0o777).toBe(0o600);
  expect(statSync(join(shared,'file.txt')).mode&0o777).toBe(0o644);
  expect(statSync(join(shared,'shell.txt')).mode&0o777).toBe(0o644);
});

it('keeps a user-installed CLI in PATH on the next call',async()=>{
  const home=workspace(),backend=new LinuxUserBackend({alice:{...identity,home}}),request={agentId:'alice',root:home,timeoutMs:5000};
  const install=await backend.execute({...request,operation:{kind:'exec',cwd:'.',command:'mkdir -p "$HOME/.local/bin"; printf "#!/bin/sh\\nprintf cli-ready\\n" > "$HOME/.local/bin/mate-test-cli"; chmod 700 "$HOME/.local/bin/mate-test-cli"'}});
  expect(install.code).toBe(0);
  expect(await backend.execute({...request,operation:{kind:'exec',cwd:'.',command:'mate-test-cli'}})).toMatchObject({code:0,stdout:'cli-ready'});
});
