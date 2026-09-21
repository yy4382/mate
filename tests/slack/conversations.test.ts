import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../../src/storage/store.js';
import { Messages, Output, targetSchema,fixtureTarget } from '../helpers/canonical-slack.js';
import { Messages as LegacyMessages, Output as LegacyOutput } from '../fixtures/v16/src/slack/messages.js';
import { CanonicalOutput } from '../../src/conversations/output.js';
import {slackPrincipal} from '../../src/slack/legacy-codec.js';
import { CanonicalSlackTransport as WebSlackTransport } from '../../src/slack/transport.js';
import { Directory } from '../../src/slack/directory.js';
import { configFixture } from '../helpers/config.js';
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach(s => s.close()));
function setup() {
  const s = new Store(':memory:'); stores.push(s); s.register('research','v1',[]);
  const m = new Messages(s,configFixture); m.membership('research','CTEST',true);
  new Output(m,{post:async()=>({ts:'999.000001'})});return { s,m };
}
it('top-level messages omit thread_ts, become roots and can be reconciled without changing the request', async () => {
  const {s,m} = setup(), transport = new WebSlackTransport(s,m.mapper,{});
  const postMessage = vi.fn(async (_args: unknown) => ({ ts:'101.000001' }));
  transport.clients.set('research',{chat:{postMessage}} as any);
  const out = new CanonicalOutput(m,transport), target = targetSchema.parse({conversationId:'CTEST'});
  const id = out.queue('research',target,'new topic'); await out.send(id);
  expect(postMessage.mock.calls[0]![0]).not.toHaveProperty('thread_ts');
  expect(m.read('research',target)[0]?.rootId).toBe(m.mapper.messageId('CTEST','101.000001'));
  expect(m.read('research',{conversationId:'CTEST',threadId:m.mapper.messageId('CTEST','101.000001')})).toHaveLength(1);
  postMessage.mockRejectedValueOnce(new Error('lost'));
  const second=out.queue('research',target,'next topic'); await out.send(second);
  out.confirm(second,s.output(second)!.request_hash,{message:m.mapper.message({ts:'102.000001',revision:'102.000001',channel:'CTEST',user:'UONE',text:'next topic',deleted:false}),receipt:{ts:'102.000001'}});
  expect(s.output(second)?.state).toBe('sent');
});
it('revision order reflects edits, deletion and late old timestamps, not arrival duplicates', () => {
  const {s,m}=setup(); const msg={team:'TTEST',channel:'CTEST',ts:'100.000001',thread:'100.000001',revision:'100.000001',text:'synthetic',user:'UOWNER',deleted:false};
  m.record(msg,['research']); m.record(msg,['research']);
  m.record({...msg,revision:'103.000001',text:'edited'},['research']);
  m.record({...msg,revision:'104.000001',deleted:true},['research']);
  m.record({...msg,ts:'99.000001',thread:'99.000001',revision:'99.000001'},['research']);
  expect(s.db.prepare('SELECT kind FROM conversation_events ORDER BY seq').all()).toEqual([{kind:'message'},{kind:'edit'},{kind:'delete'},{kind:'message'}]);
});
it('directory uses acting identity, paginates and opens an active workspace user DM with durable receipt', async () => {
  const {s,m}=setup(); s.enqueue('research','test',{}); const run=s.beginRun('research')!;
  const conversations=vi.fn().mockResolvedValueOnce({channels:[{id:'CSECOND',name:'second'}],response_metadata:{next_cursor:'next'}}).mockResolvedValueOnce({channels:[]});
  const open=vi.fn(async()=>({channel:{id:'DNEW'}}));
  const directory=new Directory(m,new Map([['research',{users:{conversations,info:async()=>({user:{id:'UTWO',team_id:'TTEST'}})},conversations:{open,members:async()=>({members:['UTWO']})}} as any]]),m.mapper);
  expect(await directory.spaces('research')).toMatchObject({incomplete:false});
  expect(conversations).toHaveBeenCalledTimes(2); expect(m.access('research',m.mapper.conversation('CSECOND'))).toBe(true);
  await expect(directory.members('research',m.mapper.conversation('CSECRET'))).rejects.toThrow('access');
  const signal=new AbortController().signal;
  expect(await directory.openDM(run,'dm',slackPrincipal(configFixture,'UTWO') as {kind:'human';id:string},signal)).toEqual({conversationId:m.mapper.conversation('DNEW')});
  expect(await directory.openDM(run,'dm',slackPrincipal(configFixture,'UTWO') as {kind:'human';id:string},signal)).toEqual({conversationId:m.mapper.conversation('DNEW')});
  expect(open).toHaveBeenCalledTimes(1); expect(m.access('research',m.mapper.conversation('DNEW'))).toBe(true);
});
it('uncertain DM opening is not replayed under a new action id', async () => {
  const {s,m}=setup(); s.enqueue('research','test',{}); const run=s.beginRun('research')!;
  const open=vi.fn(async()=>{throw new Error('lost');});
  const d=new Directory(m,new Map([['research',{users:{info:async()=>({user:{id:'UTWO',team_id:'TTEST'}})},conversations:{open}} as any]]),m.mapper);
  await expect(d.openDM(run,'a',slackPrincipal(configFixture,'UTWO') as {kind:'human';id:string},new AbortController().signal)).rejects.toThrow('lost');
  await expect(d.openDM(run,'b',slackPrincipal(configFixture,'UTWO') as {kind:'human';id:string},new AbortController().signal)).rejects.toThrow('unknown');
  expect(open).toHaveBeenCalledTimes(1);
});
it('v7 upgrade makes a private consistent backup and retains old targets and messages', () => {
  const dir=mkdtempSync(join(tmpdir(),'mate-v8-')), path=join(dir,'state.sqlite');
  try {
    const initial=new Store(path); initial.register('research','v1',[]);
    const m=new LegacyMessages(initial,configFixture); m.membership('research','CTEST',true);
    m.record({team:'TTEST',channel:'CTEST',ts:'100.000001',thread:'100.000001',revision:'100.000001',text:'legacy synthetic',user:'UOWNER',deleted:false},['research']);
    const output=new LegacyOutput(m,{post:async()=>({ts:'101.000001'})}); output.queue('research',{channel:'CTEST',thread:'100.000001'},'legacy reply','legacy');
    initial.db.exec('DROP TABLE canonical_targets; DROP TABLE message_bindings; DROP TABLE message_identities; DROP TABLE conversation_bindings; DROP TABLE conversation_identities; DROP TABLE session_resets; DROP TABLE agent_checkpoints; DROP TABLE reminder_firings; DROP TABLE reminder_events; DROP TABLE system_projections; ALTER TABLE schedules DROP COLUMN content; ALTER TABLE schedules DROP COLUMN anchor; ALTER TABLE schedules DROP COLUMN version; ALTER TABLE schedules DROP COLUMN legacy; DROP TABLE task_projections; DROP TABLE task_intents; DROP INDEX canonical_message_task; ALTER TABLE tasks DROP COLUMN message_key; DROP TABLE review_seats; DROP TABLE drafts; DROP TABLE attention_presented; DROP TABLE attention_views; DROP TABLE attention_seen; DROP TABLE attention_state; DROP TABLE channel_watches; ALTER TABLE sessions DROP COLUMN context_epoch; DROP TABLE budget_runs; DROP TABLE budget_accounts; DROP TABLE run_context; DROP TABLE delivery_context; DROP TABLE conversation_events; PRAGMA user_version=7'); initial.close();
    const migrated=new Store(path); expect(migrated.db.pragma('user_version',{simple:true})).toBe(16);
    expect(migrated.db.prepare('SELECT thread FROM conversation_events').get()).toEqual({thread:'100.000001'});
    expect(JSON.parse(migrated.output('legacy')!.request).target).toEqual({channel:'CTEST',thread:'100.000001'}); migrated.close();
    const backups=readdirSync(dir).filter(p=>p.includes('.pre-v8-')); expect(backups).toHaveLength(1);
    const backupPath=join(dir,backups[0]!); expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    const old=new Database(backupPath,{readonly:true}); expect(old.pragma('user_version',{simple:true})).toBe(7); expect(old.prepare('SELECT id FROM agents').get()).toEqual({id:'research'}); old.close();
    const reopened=new Store(path); reopened.close(); expect(readdirSync(dir).filter(p=>p.includes('.pre-v8-'))).toHaveLength(1);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
it('normalizes deletion of a reply before or after observing its original message', () => {
  for (const originalFirst of [true,false]) {
    const {s,m}=setup();
    const original={type:'message',channel:'CTEST',ts:'101.000001',thread_ts:'100.000001',text:'reply',user:'UOWNER'};
    const ingest=(id:string,event:unknown)=>{s.ingest('AONE',id,{team_id:'TTEST',event});m.normalize('AONE',id);};
    if(originalFirst) ingest('original',original);
    ingest('deleted',{type:'message',channel:'CTEST',subtype:'message_deleted',deleted_ts:'101.000001',event_ts:'102.000001',previous_message:{thread_ts:'100.000001'}});
    if(!originalFirst) ingest('original',original);
    expect(s.db.prepare("SELECT thread FROM conversation_events WHERE kind='delete'").get()).toEqual({thread:fixtureTarget().threadId});
    expect(m.read('research',fixtureTarget())).toEqual([]);
  }
});
it('late directory results cannot restore revoked channel visibility', async()=>{
  const {m}=setup(); let resolve!: (v:unknown)=>void;
  const d=new Directory(m,new Map([['research',{users:{conversations:()=>new Promise(r=>{resolve=r;})}} as any]]),m.mapper);
  const pending=d.spaces('research'); m.membership('research','CTEST',false);
  resolve({channels:[{id:'CTEST'}]});
  expect(await pending).toMatchObject({spaces:[],incomplete:true});
  expect(m.access('research','CTEST')).toBe(false);
});
it('definitive DM rejection permits retry and uncertain receipt can reconcile through discovery',async()=>{
  const {s,m}=setup();s.enqueue('research','test',{});const run=s.beginRun('research')!;
  const open=vi.fn().mockRejectedValueOnce({code:'slack_webapi_rate_limited_error',retryAfter:1}).mockRejectedValueOnce(new Error('lost'));
  const d=new Directory(m,new Map([['research',{users:{info:async()=>({user:{id:'UTWO',team_id:'TTEST'}}),conversations:async()=>({channels:[{id:'DNEW',is_im:true,user:'UTWO'}]})},conversations:{open}} as any]]),m.mapper);
  const signal=new AbortController().signal;
  await expect(d.openDM(run,'limited',slackPrincipal(configFixture,'UTWO') as {kind:'human';id:string},signal)).rejects.toMatchObject({code:'slack_webapi_rate_limited_error'});
  await expect(d.openDM(run,'lost',slackPrincipal(configFixture,'UTWO') as {kind:'human';id:string},signal)).rejects.toThrow('lost');
  await d.spaces('research');
  expect(await d.openDM(run,'lost',slackPrincipal(configFixture,'UTWO') as {kind:'human';id:string},signal)).toEqual({conversationId:m.mapper.conversation('DNEW')});
  expect(open).toHaveBeenCalledTimes(2);
});
it('late reply metadata repairs a tombstone with no previous_message and advances the root revision',()=>{
  const {s,m}=setup();
  s.ingest('AONE','delete',{team_id:'TTEST',event:{type:'message',channel:'CTEST',subtype:'message_deleted',deleted_ts:'101.000001',event_ts:'102.000001'}});m.normalize('AONE','delete');
  s.ingest('AONE','original',{team_id:'TTEST',event:{type:'message',channel:'CTEST',ts:'101.000001',thread_ts:'100.000001',text:'late',user:'UOWNER'}});m.normalize('AONE','original');
  expect(s.db.prepare('SELECT thread,deleted FROM messages').get()).toEqual({thread:fixtureTarget().threadId,deleted:1});
  expect(s.db.prepare('SELECT thread,kind FROM conversation_events ORDER BY seq DESC LIMIT 1').get()).toEqual({thread:fixtureTarget().threadId,kind:'delete'});
});
it.each(['no_permission','user_disabled'])('DM %s rejection can be retried after external repair',async error=>{
  const {s,m}=setup();s.enqueue('research','test',{});const run=s.beginRun('research')!;
  const open=vi.fn().mockRejectedValueOnce({code:'slack_webapi_platform_error',data:{error}}).mockResolvedValueOnce({channel:{id:'DNEW'}});
  const d=new Directory(m,new Map([['research',{users:{info:async()=>({user:{id:'UTWO',team_id:'TTEST'}})},conversations:{open}} as any]]),m.mapper);
  await expect(d.openDM(run,'first',slackPrincipal(configFixture,'UTWO') as {kind:'human';id:string},new AbortController().signal)).rejects.toMatchObject({data:{error}});
  expect(await d.openDM(run,'retry',slackPrincipal(configFixture,'UTWO') as {kind:'human';id:string},new AbortController().signal)).toEqual({conversationId:m.mapper.conversation('DNEW')});
});
