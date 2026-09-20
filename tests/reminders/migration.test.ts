import {expect,it}from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,readdirSync}from 'node:fs';
import {join}from 'node:path';
import {tmpdir}from 'node:os';
import * as schemas from '../../src/storage/schema.js';
import {Store}from '../../src/storage/store.js';
it('v13 migration preserves reminder identities and inactive states without guessing legacy purpose',()=>{
 const root=mkdtempSync(join(tmpdir(),'mate-reminder-migration-')),path=join(root,'state.sqlite');try{
  const old=new Database(path);old.exec([schemas.schema,schemas.messageSchema,schemas.collaborationSchema,schemas.policySchema,schemas.runtimeSchema,schemas.daemonSchema,schemas.scopedExecutionSchema,schemas.conversationSchema,schemas.budgetSchema,schemas.attentionSchema,schemas.freshnessSchema,schemas.reviewSeatSchema,schemas.messageTaskSchema].join('\n'));
  old.exec(`INSERT INTO agents(id,session_id) VALUES('research','session');INSERT INTO sessions(id,agent_id,config_version) VALUES('session','research','v1');INSERT INTO works(id,origin,target,max_runs,max_tokens,max_cost) VALUES('work','human','{"channel":"CTEST"}',20,100000,5);INSERT INTO schedules(id,agent_id,work_id,target,next_at,timezone,active) VALUES('active','research','work','{"channel":"CTEST"}',1000,'UTC',1),('inactive','research','work','{"channel":"CTEST"}',2000,'UTC',0);`);old.close();
  const store=new Store(path);expect(store.db.pragma('user_version',{simple:true})).toBe(15);expect(store.db.prepare('SELECT id,active,legacy,version FROM schedules ORDER BY id').all()).toEqual([{id:'active',active:1,legacy:1,version:1},{id:'inactive',active:0,legacy:1,version:1}]);expect(store.db.prepare('SELECT count(*) n FROM reminder_events').get()).toEqual({n:2});store.close();
  expect(readdirSync(root).filter(name=>name.includes('.pre-v14-'))).toHaveLength(1);const again=new Store(path);again.close();expect(readdirSync(root).filter(name=>name.includes('.pre-v14-'))).toHaveLength(1);
 }finally{rmSync(root,{recursive:true,force:true});}
});
