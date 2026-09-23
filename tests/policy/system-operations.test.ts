import {expect,it,vi} from 'vitest';
import {Store} from '../../src/storage/store.js';
import {configSchema} from '../../src/config.js';
import {configFixture} from '../helpers/config.js';
import {Messages,Output,migrateCurrentRuntime,fixtureTarget} from '../helpers/canonical-slack.js';
import {Collaboration} from '../../src/collaboration/service.js';
import {SystemOperations} from '../../src/policy/system-operations.js';

function setup(){
  const store=new Store(':memory:'),config=configSchema.parse(configFixture),messages=new Messages(store,config);migrateCurrentRuntime(store);
  const collaboration=new Collaboration(store,messages,new Output(messages,{post:async()=>({ts:'200.000001'})}),config);
  store.register('research','v1',[]);messages.membership('research','CTEST',true);
  const work=collaboration.createWork('system-test',fixtureTarget('CTEST','100.000001'));collaboration.enqueue('research',work,'start',{});
  const run=store.beginRun('research')!;store.input(run,{});
  const execute=vi.fn(async()=>({code:0,stdout:'installed',stderr:'',truncated:false}));
  const system=new SystemOperations(store,collaboration,['research'],{execute},()=>1000);
  return{store,collaboration,work,run,execute,system};
}
const command={program:'/usr/bin/apt-get',args:['install','-y','example'],cwd:'/tmp'};

it('requires an exact one-time human decision before dispatching a system command',async()=>{
  const {store,work,run,execute,system}=setup();
  try{
    const pending=system.request(run,work,'request-1',command);
    expect(pending).toMatchObject({id:'request-1',agentId:'research',status:'pending',expires:601000});
    expect(pending.warning).toContain('not freeze');
    await system.dispatchApproved();expect(execute).not.toHaveBeenCalled();
    expect(()=>system.request(run,work,'request-1',{...command,args:['remove','example']})).toThrow('identity');
    expect(system.decide('UOWNER','request-1','approve')).toMatchObject({status:'approved'});
    expect(system.decide('UOWNER','request-1','approve')).toMatchObject({status:'approved'});
    await system.dispatchApproved();expect(execute).toHaveBeenCalledOnce();
    expect(system.status('research','request-1')).toMatchObject({status:'succeeded',receipt:{code:0,stdout:'installed',warning:expect.stringContaining('not freeze')}});
    await system.dispatchApproved();expect(execute).toHaveBeenCalledOnce();
  }finally{store.close();}
});

it('refuses non-owner decisions, rejected and expired requests without execution',async()=>{
  const {store,work,run,execute,system}=setup();
  try{
    system.request(run,work,'denied',command);
    expect(()=>system.decide('UOTHER','denied','approve')).toThrow('Owner');
    expect(system.decide('UOWNER','denied','reject')).toMatchObject({status:'rejected'});
    expect(()=>system.decide('UOWNER','denied','approve')).toThrow('already decided');
    system.request(run,work,'expired',command);
    system.expire(601001);
    expect(system.status('research','expired').status).toBe('expired');
    expect(()=>system.decide('UOWNER','expired','approve')).toThrow('already decided');
    await system.dispatchApproved();expect(execute).not.toHaveBeenCalled();
  }finally{store.close();}
});

it('recovers approved requests but never replays an uncertain executing request after restart',async()=>{
  const {store,collaboration,work,run,execute,system}=setup();
  try{
    system.request(run,work,'ready',command);system.decide('UOWNER','ready','approve');
    const fresh=new SystemOperations(store,collaboration,['research'],{execute},()=>1000);
    fresh.recover();await fresh.dispatchApproved();expect(execute).toHaveBeenCalledOnce();
    system.request(run,work,'in-flight',command);system.decide('UOWNER','in-flight','approve');
    store.db.prepare("UPDATE system_requests SET status='executing' WHERE id='in-flight'").run();
    const before=(store.db.prepare('SELECT count(*) n FROM deliveries').get() as {n:number}).n;
    fresh.recover();expect(fresh.status('research','in-flight').status).toBe('unknown');
    expect((store.db.prepare('SELECT count(*) n FROM deliveries').get() as {n:number}).n).toBe(before+1);
    await fresh.dispatchApproved();expect(execute).toHaveBeenCalledOnce();
  }finally{store.close();}
});

it('rechecks review-seat and system eligibility immediately before privileged dispatch',async()=>{
  const {store,collaboration,work,run,execute,system}=setup();
  try{
    system.request(run,work,'seat-change',command);system.decide('UOWNER','seat-change','approve');
    store.db.prepare('INSERT INTO review_seats VALUES(?,?,?,?,1)').run('research','{}','brief','/tmp/clean');
    await system.dispatchApproved();expect(system.status('research','seat-change')).toMatchObject({status:'failed',receipt:{reason:'system_eligibility_unavailable'}});
    store.db.prepare('DELETE FROM review_seats WHERE agent_id=?').run('research');
    system.request(run,work,'eligibility-change',command);system.decide('UOWNER','eligibility-change','approve');
    await new SystemOperations(store,collaboration,[],{execute},()=>1000).dispatchApproved();
    expect(system.status('research','eligibility-change').status).toBe('failed');expect(execute).not.toHaveBeenCalled();
  }finally{store.close();}
});

it('fails an uncertain approval notice visibly and invalidates any stale button',async()=>{
  const {store,collaboration,work,run,execute,system}=setup();
  try{
    system.request(run,work,'notice-lost',command);expect(system.claimNotice('notice-lost')).toBe(true);
    system.settleNotice('notice-lost','unknown');
    expect(system.status('research','notice-lost')).toMatchObject({status:'failed',receipt:{reason:expect.stringContaining('request again')}});
    expect(()=>system.decide('UOWNER','notice-lost','approve')).toThrow('already decided');
    system.request(run,work,'notice-crash',command);expect(system.claimNotice('notice-crash')).toBe(true);
    const fresh=new SystemOperations(store,collaboration,['research'],{execute},()=>1000);
    fresh.recover();expect(fresh.status('research','notice-crash')).toMatchObject({status:'failed',receipt:{reason:expect.stringContaining('request again')}});
    expect(fresh.pendingNotices()).toEqual([]);await fresh.dispatchApproved();expect(execute).not.toHaveBeenCalled();
  }finally{store.close();}
});

it('denies unqualified or independently reviewing Agents',()=>{
  const {store,collaboration,work,run,execute}=setup();
  try{
    const unqualified=new SystemOperations(store,collaboration,[],{execute},()=>1000);
    expect(()=>unqualified.request(run,work,'not-qualified',command)).toThrow('not authorized');
    store.db.prepare('INSERT INTO review_seats VALUES(?,?,?,?,1)').run('research','{}','brief','/tmp/clean');
    expect(()=>new SystemOperations(store,collaboration,['research'],{execute},()=>1000).request(run,work,'review',command)).toThrow('review');
  }finally{store.close();}
});
