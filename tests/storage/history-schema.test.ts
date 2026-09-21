import {afterEach,expect,it} from 'vitest';
import {Store} from '../../src/storage/store.js';
import {initializeCanonicalStore,migrateInternalConversations} from '../../src/storage/internal-schema.js';
import {migrateProjections} from '../../src/storage/projection-schema.js';
import {migrateProjectionImports} from '../../src/storage/projection-import-schema.js';
import {migrateHistoryIndexes} from '../../src/storage/history-schema.js';
import {encode} from '../../src/storage/store.js';

const stores:Store[]=[];afterEach(()=>stores.splice(0).forEach(store=>store.close()));
it('adds explicit conversation and thread history indexes as an idempotent v21 migration',()=>{
  const store=new Store(':memory:');stores.push(store);initializeCanonicalStore(store);migrateInternalConversations(store);migrateProjections(store);migrateProjectionImports(store);
  expect(store.db.pragma('user_version',{simple:true})).toBe(20);migrateHistoryIndexes(store);migrateHistoryIndexes(store);
  expect(store.db.pragma('user_version',{simple:true})).toBe(21);
  expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'message_history_%' ORDER BY name").all()).toEqual([{name:'message_history_conversation'},{name:'message_history_thread'}]);
  const conversation=store.db.prepare("EXPLAIN QUERY PLAN SELECT key,channel,ts FROM messages WHERE channel=? AND deleted=0 ORDER BY length(ts) DESC,ts DESC,key DESC LIMIT 1001").all('room') as {detail:string}[];
  const thread=store.db.prepare("EXPLAIN QUERY PLAN SELECT key FROM messages WHERE channel=? AND thread=? AND deleted=0 ORDER BY length(ts) DESC,ts DESC,key DESC LIMIT 51").all('room','root') as {detail:string}[];
  const production=store.db.prepare(`EXPLAIN QUERY PLAN SELECT m.key,m.channel,m.ts FROM messages m INDEXED BY message_history_conversation
    JOIN conversation_identities c ON c.id=m.channel JOIN channel_access a ON a.channel=m.channel
    LEFT JOIN message_visibility v ON v.key=m.key AND v.agent_id=a.agent_id
    WHERE a.agent_id=? AND a.active=1 AND ((c.authority='internal' AND c.kind='channel') OR v.key IS NOT NULL) AND m.channel=?
    ORDER BY m.channel,length(m.ts) DESC,m.ts DESC,m.key DESC LIMIT 1001`).all('agent','room') as {detail:string}[];
  const productionThread=store.db.prepare(`EXPLAIN QUERY PLAN SELECT m.key,m.channel,m.ts FROM messages m INDEXED BY message_history_thread
    JOIN conversation_identities c ON c.id=m.channel JOIN channel_access a ON a.channel=m.channel
    LEFT JOIN message_visibility v ON v.key=m.key AND v.agent_id=a.agent_id
    WHERE a.agent_id=? AND a.active=1 AND ((c.authority='internal' AND c.kind='channel') OR v.key IS NOT NULL) AND m.channel=? AND m.thread=?
    ORDER BY m.channel,length(m.ts) DESC,m.ts DESC,m.key DESC LIMIT 1001`).all('agent','room','root') as {detail:string}[];
  const globalChannels=store.db.prepare('EXPLAIN QUERY PLAN SELECT channel FROM channel_access WHERE agent_id=? AND active=1 AND (? IS NULL OR channel>=?) ORDER BY channel').all('agent',null,null) as {detail:string}[];
  const globalSegment=store.db.prepare(`EXPLAIN QUERY PLAN SELECT m.key,m.channel,m.ts FROM messages m INDEXED BY message_history_conversation
    JOIN conversation_identities c ON c.id=m.channel LEFT JOIN message_visibility v ON v.key=m.key AND v.agent_id=?
    WHERE m.channel=? AND ((c.authority='internal' AND c.kind='channel') OR v.key IS NOT NULL)
    ORDER BY m.channel,length(m.ts) DESC,m.ts DESC,m.key DESC LIMIT ?`).all('agent','room',1001) as {detail:string}[];
  const snapshotSearch=store.db.prepare(`EXPLAIN QUERY PLAN SELECT m.key FROM messages m INDEXED BY message_history_conversation
    JOIN conversation_identities c ON c.id=m.channel JOIN message_visibility v ON v.key=m.key AND v.agent_id=?
    WHERE m.channel=? AND ((c.authority='external' AND json_extract(v.body,'$.message.deleted')=0 AND instr(lower(json_extract(v.body,'$.message.text')),lower(?))>0)
      OR (c.authority='internal' AND m.deleted=0 AND instr(lower(json_extract(m.body,'$.message.text')),lower(?))>0))
    ORDER BY length(m.ts) DESC,m.ts DESC,m.key DESC LIMIT ?`).all('agent','room','needle','needle',100) as {detail:string}[];
  expect(conversation.some(row=>row.detail.includes('message_history_conversation'))).toBe(true);
  expect(thread.some(row=>row.detail.includes('message_history_thread'))).toBe(true);
  expect(production.some(row=>row.detail.includes('message_history_conversation'))).toBe(true);
  expect(productionThread.some(row=>row.detail.includes('message_history_thread'))).toBe(true);
  expect(globalSegment.some(row=>row.detail.includes('message_history_conversation'))).toBe(true);
  expect(snapshotSearch.some(row=>row.detail.includes('message_history_conversation'))).toBe(true);
  expect([...conversation,...thread,...production,...productionThread,...globalChannels,...globalSegment,...snapshotSearch].some(row=>row.detail.includes('SCAN m')||row.detail.includes('USE TEMP B-TREE'))).toBe(false);
});

it('backfills the strongest actor-specific revision evidence without inventing missing observations',()=>{
  const store=new Store(':memory:');stores.push(store);initializeCanonicalStore(store);migrateInternalConversations(store);migrateProjections(store);migrateProjectionImports(store);
  store.register('observed','v1',[]);store.register('legacy-visible','v1',[]);
  store.db.prepare('INSERT INTO conversation_identities VALUES(?,?,?)').run('room','channel','external');
  store.db.prepare('INSERT INTO message_identities VALUES(?,?,?)').run('message','room','message');
  const body=(revision:string)=>encode({format:'mate.message.v2',message:{id:'message',conversationId:'room',rootId:'message',author:{kind:'human',id:'owner'},origin:'participant',mentions:[],text:`revision ${revision}`,deleted:false,order:'1',revision,attachments:[]}});
  store.db.prepare('INSERT INTO messages(key,channel,ts,thread,revision,body,deleted) VALUES(?,?,?,?,?,?,?)').run('message','room','1','message','2',body('2'),0);
  store.db.prepare('INSERT INTO message_revisions VALUES(?,?,?)').run('message','1',body('1'));store.db.prepare('INSERT INTO message_revisions VALUES(?,?,?)').run('message','2',body('2'));
  store.db.prepare('INSERT INTO message_visibility VALUES(?,?)').run('observed','message');store.db.prepare('INSERT INTO message_visibility VALUES(?,?)').run('legacy-visible','message');
  store.db.prepare('INSERT INTO message_observations VALUES(?,?,?)').run('observed','message','1');migrateHistoryIndexes(store);
  expect(store.db.prepare('SELECT agent_id,revision,body FROM message_visibility ORDER BY agent_id').all()).toEqual([
    {agent_id:'legacy-visible',revision:'2',body:body('2')},{agent_id:'observed',revision:'1',body:body('1')},
  ]);
  expect(store.db.prepare("SELECT body FROM audit WHERE kind='history_visibility_backfill'").get()).toBeDefined();
});
