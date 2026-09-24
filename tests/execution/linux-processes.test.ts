import {expect,it} from 'vitest';
import {LinuxProcessManager,ProcessNotRunningError,ProcessStopRejectedError} from '../../src/execution/linux-processes.js';

const unit='mate-agent-1001-123e4567-e89b-42d3-a456-426614174000.scope';
const group=`/mate-agent-1001.slice/${unit}`;
const ok=(stdout='')=>({code:0,stdout,stderr:''});

it('lists current systemd scopes after restart without a Mate job record',()=>{
  const calls:string[][]=[];
  const manager=new LinuxProcessManager({alice:1001},args=>{calls.push(args);return args[0]==='list-units'?ok(`${unit} loaded active running Agent\n`):ok(`Id=${unit}\nActiveState=active\nSlice=mate-agent-1001.slice\nControlGroup=${group}\n`);},()=>[4101],()=>1001);
  expect(manager.list('alice')).toEqual([{unit,pids:[4101]}]);
  expect(calls.map(call=>call[0])).toEqual(['list-units','show']);
});

it('skips a scope that disappears between list-units and show',()=>{
  const manager=new LinuxProcessManager({alice:1001},args=>args[0]==='list-units'?ok(`${unit} loaded active running Agent\n`):ok(`Id=${unit}\nLoadState=not-found\nActiveState=inactive\n`));
  expect(manager.list('alice')).toEqual([]);
});

it('classifies rejection before stop separately from uncertain post-stop failure',()=>{
  let stopped=false;
  const missing=new LinuxProcessManager({alice:1001},args=>{if(args[0]==='stop')stopped=true;return ok(`Id=${unit}\nLoadState=not-found\nActiveState=inactive\n`);});
  expect(()=>missing.stop('alice',unit)).toThrow(ProcessNotRunningError);
  expect(stopped).toBe(false);
  const wrong=new LinuxProcessManager({alice:1001},()=>ok(`Id=${unit}\nActiveState=active\nSlice=other.slice\nControlGroup=${group}\n`));
  expect(()=>wrong.stop('alice',unit)).toThrow(ProcessStopRejectedError);
});

it('checks the unit, slice and actual process UID before stopping and requires an empty cgroup afterward',()=>{
  let pids=[4101,4102],stops=0;
  const manager=new LinuxProcessManager({alice:1001,bob:1002},args=>{
    if(args[0]==='show')return ok(`Id=${unit}\nActiveState=active\nSlice=mate-agent-1001.slice\nControlGroup=${group}\n`);
    if(args[0]==='stop'){stops++;pids=[];return ok();}
    return ok();
  },()=>pids,()=>1001);
  expect(()=>manager.stop('bob',unit)).toThrow('scope');expect(stops).toBe(0);
  expect(manager.stop('alice',unit)).toEqual({unit,stopped:true});expect(stops).toBe(1);
});

it('does not stop a scope containing a different UID or misleading unit metadata',()=>{
  let stopped=false;
  const runner=(args:string[])=>{if(args[0]==='stop')stopped=true;return ok(`Id=${unit}\nActiveState=active\nSlice=mate-agent-1001.slice\nControlGroup=${group}\n`);};
  const foreign=new LinuxProcessManager({alice:1001},runner,()=>[4101,4102],pid=>pid===4101?1001:0);
  expect(()=>foreign.stop('alice',unit)).toThrow('UID');expect(stopped).toBe(false);
  const wrongGroup=new LinuxProcessManager({alice:1001},()=>ok(`Id=${unit}\nActiveState=active\nSlice=system.slice\nControlGroup=/system.slice/${unit}\n`),()=>[4101],()=>1001);
  expect(()=>wrongGroup.stop('alice',unit)).toThrow('slice');
});

it('requires a bounded Agent slice before ordinary work is admitted',()=>{
  const report=(memory:string,tasks:string,cpu:string)=>ok(`LoadState=loaded\nMemoryMax=${memory}\nTasksMax=${tasks}\nCPUQuotaPerSecUSec=${cpu}\n`);
  expect(()=>new LinuxProcessManager({alice:1001},()=>report('1073741824','128','1s')).verifyQuota('alice')).not.toThrow();
  expect(()=>new LinuxProcessManager({alice:1001},()=>report('infinity','128','1s')).verifyQuota('alice')).toThrow('quota');
  expect(()=>new LinuxProcessManager({alice:1001},()=>report('1073741824','infinity','1s')).verifyQuota('alice')).toThrow('quota');
  expect(()=>new LinuxProcessManager({alice:1001},()=>report('1073741824','128','infinity')).verifyQuota('alice')).toThrow('quota');
});

it('does not report a successful stop while descendants remain in the cgroup',()=>{
  const manager=new LinuxProcessManager({alice:1001},args=>args[0]==='show'?ok(`Id=${unit}\nActiveState=active\nSlice=mate-agent-1001.slice\nControlGroup=${group}\n`):ok(),()=>[4101],()=>1001);
  expect(()=>manager.stop('alice',unit)).toThrow('left processes');
});
