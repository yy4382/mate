import {afterEach,expect,it}from 'vitest';
import {Store}from '../../src/storage/store.js';
import {initializeCanonicalStore,migrateInternalConversations}from '../../src/storage/internal-schema.js';
import {migrateProjections}from '../../src/storage/projection-schema.js';
import {migrateProjectionImports}from '../../src/storage/projection-import-schema.js';
import {migrateHistoryIndexes}from '../../src/storage/history-schema.js';
import {migrateCoordinationRecovery}from '../../src/storage/coordination-schema.js';
import {migrateOperationsView}from '../../src/storage/operations-schema.js';

const stores:Store[]=[];afterEach(()=>stores.splice(0).forEach(store=>store.close()));
function v22(){const store=new Store(':memory:');stores.push(store);initializeCanonicalStore(store);migrateInternalConversations(store);migrateProjections(store);migrateProjectionImports(store);migrateHistoryIndexes(store);migrateCoordinationRecovery(store);store.db.prepare("INSERT INTO conversation_identities VALUES('room','channel','internal')").run();return store;}

it('migrates v22 additively without inventing old effect timestamps or operational facts',()=>{
 const store=v22();store.register('agent','v1',[]);const delivery=store.enqueue('agent','old',{}),run=store.beginRun('agent')!;store.input(run,{});
 store.db.prepare("INSERT INTO works(id,origin,target,state,max_runs,max_tokens,max_cost) VALUES('work','old','{\"conversationId\":\"room\"}','active',10,1000,1)").run();
 store.db.prepare("INSERT INTO schedules(id,agent_id,work_id,target,next_at,timezone,content,version,legacy,projection) VALUES('edited-legacy','agent','work','{\"conversationId\":\"room\"}',100,'UTC','edited',2,0,'conversation_receipt')").run();
 store.db.prepare("INSERT INTO reminder_events(reminder_id,version,kind,at,payload) VALUES('edited-legacy',1,'legacy_migrated',1,'{}')").run();
 store.prepareAction(run,'old-action',{private:'PRIVATE_ACTION'});
 store.db.prepare("INSERT INTO outbox(id,agent_id,request_hash,request,state,target) VALUES('old-output','agent','hash','{\"private\":\"PRIVATE_OUTPUT\",\"target\":{\"conversationId\":\"room\"}}','unknown','{\"conversationId\":\"room\"}')").run();
 migrateOperationsView(store);migrateOperationsView(store);
 expect(store.db.pragma('user_version',{simple:true})).toBe(23);
 expect(store.db.prepare("SELECT created_at FROM actions WHERE id='old-action'").get()).toEqual({created_at:null});
 expect(store.db.prepare("SELECT created_at FROM outbox WHERE id='old-output'").get()).toEqual({created_at:null});
 expect(store.db.prepare('SELECT count(*) n FROM operational_facts').get()).toEqual({n:0});
 expect(store.db.prepare("SELECT historical_complete FROM reminder_event_baselines WHERE reminder_id='edited-legacy'").get()).toEqual({historical_complete:0});
 expect(store.db.prepare("SELECT value FROM runtime_meta WHERE key='operations_view_since'").get()).toMatchObject({value:expect.any(String)});
 expect(store.delivery(delivery).status).toBe('injected');
});

it('timestamps only new effects and supports bounded activity indexes',()=>{
 const store=v22();store.register('agent','v1',[]);migrateOperationsView(store);store.enqueue('agent','new',{});const run=store.beginRun('agent')!;store.input(run,{});
 store.prepareAction(run,'new-action',{});store.queueOutput('agent','new-output',{target:{conversationId:'room'}},JSON.stringify({conversationId:'room'}));
 expect(store.db.prepare("SELECT created_at IS NOT NULL present FROM actions WHERE id='new-action'").get()).toEqual({present:1});
 expect(store.db.prepare("SELECT created_at IS NOT NULL present FROM outbox WHERE id='new-output'").get()).toEqual({present:1});
 const plans=[
  store.db.prepare("EXPLAIN QUERY PLAN SELECT e.at,e.id FROM task_events e JOIN tasks t ON t.id=e.task_id WHERE (e.at<? OR (e.at=? AND e.id<?)) AND COALESCE(json_extract(e.body,'$.actor'),json_extract(e.body,'$.agentId'))=? AND 'task.'||json_extract(e.body,'$.action') IN (?) ORDER BY e.at DESC,e.id DESC LIMIT ?").all(10,10,10,'agent','task.done',51),
  store.db.prepare("EXPLAIN QUERY PLAN SELECT e.at,e.seq FROM reminder_events e JOIN schedules r ON r.id=e.reminder_id WHERE e.actor_id=? AND e.kind IN (?) ORDER BY e.at DESC,e.seq DESC LIMIT ?").all('agent','edited',51),
  store.db.prepare('EXPLAIN QUERY PLAN SELECT f.due_at,f.id FROM reminder_firings f JOIN schedules r ON r.id=f.reminder_id JOIN deliveries d ON d.id=f.delivery_id WHERE f.actor_id=? ORDER BY f.due_at DESC,f.id DESC LIMIT ?').all('agent',51),
  store.db.prepare('EXPLAIN QUERY PLAN SELECT r.created_at,r.id FROM runs r LEFT JOIN run_context rc ON rc.run_id=r.id WHERE r.agent_id=? ORDER BY r.created_at DESC,r.id DESC LIMIT ?').all('agent',51),
  store.db.prepare('EXPLAIN QUERY PLAN SELECT a.created_at,a.id FROM actions a WHERE a.agent_id=? AND a.created_at IS NOT NULL ORDER BY a.created_at DESC,a.id DESC LIMIT ?').all('agent',51),
  store.db.prepare('EXPLAIN QUERY PLAN SELECT o.created_at,o.id FROM outbox o LEFT JOIN output_work ow ON ow.output_id=o.id WHERE o.agent_id=? AND o.created_at IS NOT NULL ORDER BY o.created_at DESC,o.id DESC LIMIT ?').all('agent',51),
  store.db.prepare("EXPLAIN QUERY PLAN SELECT f.at,f.seq FROM operational_facts f WHERE (f.at<? OR (f.at=? AND f.seq<?)) AND f.actor_id=? AND f.kind IN (?) AND f.source=? ORDER BY f.at DESC,f.seq DESC LIMIT ?").all(10,10,10,'agent','run_completed','runtime',51),
  store.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM actions WHERE state IN ('executing','unknown') ORDER BY id DESC LIMIT ?").all(101),
  store.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM outbox WHERE state='unknown' ORDER BY id DESC LIMIT ?").all(101),
  store.db.prepare("EXPLAIN QUERY PLAN SELECT d.id FROM outbox o INDEXED BY output_held_status JOIN drafts d INDEXED BY draft_output_lookup ON d.outbox_id=o.id WHERE o.state='held' ORDER BY o.id DESC LIMIT ?").all(101),
  store.db.prepare('EXPLAIN QUERY PLAN SELECT id FROM schedules WHERE active=1 AND next_at<=? ORDER BY next_at,id LIMIT ?').all(Date.now(),101),
  store.db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM task_event_baselines WHERE historical_complete=0').all(),
  store.db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM reminder_event_baselines WHERE historical_complete=0').all(),
  store.db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM actions WHERE created_at IS NULL').all()
 ].flat() as {detail:string}[];
 const details=plans.map(row=>row.detail).join('\n');expect(details).not.toContain('USE TEMP B-TREE');
 for(const index of ['task_activity_actor_kind','reminder_activity_actor_kind','reminder_firing_activity_actor','run_activity_actor','action_activity_actor','output_activity_actor','operational_fact_actor_kind_activity','action_uncertain_status','output_unknown_status','output_held_status','schedule_due_status','task_baseline_gaps','reminder_baseline_gaps','action_missing_activity_time'])expect(details).toContain(index);
});

it('rejects facts outside the narrow source-specific privacy contract',()=>{
 const store=v22();store.register('agent','v1',[]);migrateOperationsView(store);
 expect(()=>store.atomic(()=>store.db.prepare("INSERT INTO operational_facts(at,source,source_id,kind,actor_id,subject_type,subject_id,counts) VALUES(1,'runtime','bad','internal_dm_created','agent','internal_dm','dm','{\"members\":2}')").run())).toThrow();
 expect(()=>store.atomic(()=>store.db.prepare("INSERT INTO operational_facts(at,source,source_id,kind,actor_id,subject_type,subject_id,counts) VALUES(1,'internal_dm','bad','internal_dm_created','agent','internal_dm','dm','{\"members\":2,\"private\":1}')").run())).toThrow();
});
