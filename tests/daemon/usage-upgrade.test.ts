import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Store} from '../../src/storage/store.js';
import {Daemon} from '../../src/daemon/app.js';
import {daemonConfigSchema} from '../../src/daemon/config.js';
import {migrateModelUsage} from '../../src/storage/model-usage-schema.js';
import {UsageLedger} from '../../src/usage/ledger.js';
import {answer} from '../helpers/pi.js';

const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
const log={info:()=>{},error:()=>{}};

it('upgrades a paused v24 Agent without treating reservations as usage or dropping its pending input',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'mate-usage-upgrade-')));roots.push(root);
  const raw=JSON.parse(readFileSync(resolve('mate.local.example.json'),'utf8'));
  raw.runtime.dataDir=join(root,'data');raw.mate.agents=raw.mate.agents.slice(0,1);
  raw.adapters.local.rooms[0].agents=['research'];
  const config=daemonConfigSchema.parse(raw);
  const first=await Daemon.create(config,log);
  const store=first.store,work=first.collaboration.createWork('old-work',{conversationId:'team-room'});
  const delivery=first.collaboration.enqueue('research',work,'pending-from-v24',{text:'CONTINUE_THIS_REQUEST'});
  const run=store.beginRun('research',Date.now(),true)!;
  store.input(run,{role:'user',content:'CONTINUE_THIS_REQUEST',timestamp:0});
  first.collaboration.bindRunWork(run,work);
  store.appendMessage(run,'message:0',answer([{type:'text',text:'earlier model output'}]));
  store.db.exec(`
    ALTER TABLE works ADD COLUMN max_runs INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE works ADD COLUMN max_tokens INTEGER NOT NULL DEFAULT 50000;
    ALTER TABLE works ADD COLUMN max_cost REAL NOT NULL DEFAULT 2;
    ALTER TABLE works ADD COLUMN runs INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE works ADD COLUMN tokens INTEGER NOT NULL DEFAULT 50000;
    ALTER TABLE works ADD COLUMN cost REAL NOT NULL DEFAULT 2;
    ALTER TABLE work_runs ADD COLUMN token_cap INTEGER NOT NULL DEFAULT 50000;
    ALTER TABLE work_runs ADD COLUMN cost_cap REAL NOT NULL DEFAULT 2;
    ALTER TABLE work_runs ADD COLUMN settled INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE budget_accounts(agent_id TEXT PRIMARY KEY REFERENCES agents(id),max_runs INTEGER NOT NULL,max_tokens INTEGER NOT NULL,max_cost REAL NOT NULL,runs INTEGER NOT NULL DEFAULT 0,tokens INTEGER NOT NULL DEFAULT 0,cost REAL NOT NULL DEFAULT 0);
    CREATE TABLE budget_runs(run_id TEXT PRIMARY KEY REFERENCES runs(id),agent_id TEXT NOT NULL REFERENCES agents(id),token_cap INTEGER NOT NULL,cost_cap REAL NOT NULL,settled INTEGER NOT NULL DEFAULT 0);
  `);
  store.db.prepare('INSERT INTO budget_accounts(agent_id,max_runs,max_tokens,max_cost,runs,tokens,cost) VALUES(?,?,?,?,?,?,?)').run('research',1,50000,2,1,50000,2);
  const legacy=JSON.parse(JSON.stringify(config));
  legacy.mate.budgets={maxRuns:1,maxTokens:50000,maxCostUsd:2,runTimeoutMs:config.mate.runTimeoutMs};
  delete legacy.mate.runTimeoutMs;
  store.db.prepare("UPDATE runtime_meta SET value=? WHERE key='configuration'").run(JSON.stringify(legacy));
  store.db.prepare("UPDATE agents SET paused=1 WHERE id='research'").run();
  const oldSession=run.sessionId;
  store.db.prepare("UPDATE sessions SET config_version='old-v24-prompt' WHERE id=?").run(oldSession);
  store.db.exec('DROP TABLE model_usage; PRAGMA user_version=24');
  await first.close();

  const second=await Daemon.create(config,log);
  try{
    expect(second.store.db.pragma('user_version',{simple:true})).toBe(25);
    expect(new UsageLedger(second.store).readAgent('research')).toMatchObject({knownCalls:1,unknownCalls:0,totalTokens:12});
    const agent=second.store.db.prepare("SELECT session_id,paused FROM agents WHERE id='research'").get() as {session_id:string;paused:number};
    expect(agent.session_id).not.toBe(oldSession);expect(agent.paused).toBe(1);
    expect(JSON.stringify(second.store.context(agent.session_id))).toContain('CONTINUE_THIS_REQUEST');
    expect(second.store.delivery(delivery).status).toBe('injected');
    expect(second.store.db.prepare('SELECT work_id FROM delivery_work WHERE delivery_id=?').get(delivery)).toEqual({work_id:work});
  }finally{await second.close();}
});

it('v24 usage migration is idempotent and leaves old reservation counters out of the ledger',()=>{
  const store=new Store(':memory:');
  try{
    store.register('research','old',[]);store.enqueue('research','one',{});
    const run=store.beginRun('research')!;store.appendMessage(run,'message:0',answer([]));
    store.db.exec('PRAGMA user_version=24');
    migrateModelUsage(store);migrateModelUsage(store);
    expect(new UsageLedger(store).readAgent('research')).toMatchObject({knownCalls:1,totalTokens:12});
  }finally{store.close();}
});
