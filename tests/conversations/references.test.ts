import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store, encode } from '../../src/storage/store.js';
import { References } from '../../src/conversations/references.js';
import { migrateLegacyReferences } from '../../src/slack/reference-migration.js';
import { Messages } from '../../src/slack/messages.js';
import { configFixture } from '../helpers/config.js';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(clean => clean()));
function setup() {
  const s = new Store(':memory:'); cleanups.push(() => s.close());
  return { s, r: new References(s) };
}

it('keeps opaque identities, authority and projection routing independent of provider IDs', () => {
  const { s, r } = setup();
  const dm = r.createConversation('dm', 'internal');
  const channel = r.createConversation('channel', 'external');
  const root = r.createMessage(dm.id);
  const reply = r.createMessage(dm.id, 'another-message', root.id);
  expect(reply.rootId).toBe(root.id);
  expect(r.validateTarget({ conversationId: dm.id, threadId: root.id })).toBeDefined();
  expect(() => r.validateTarget({ conversationId: channel.id, threadId: root.id })).toThrow('Invalid target');
  expect(() => r.validateTarget({ conversationId: dm.id, threadId: reply.id })).toThrow('Invalid target');
  const locator = { provider: 'example', workspace: 'personal', externalId: 'space-9' };
  r.bindConversation(locator, dm.id, 'projection');
  expect(() => r.bindConversation(locator, channel.id, 'primary')).toThrow('already bound');
  expect(() => r.bindConversation({ ...locator, externalId: 'other' }, dm.id, 'primary')).toThrow('authority');
  expect(() => r.createConversation('channel', 'external', dm.id)).toThrow('identity conflict');
  expect(s.db.prepare('SELECT count(*) n FROM channel_access').get()).toEqual({ n: 0 });
  expect(s.db.prepare('SELECT count(*) n FROM messages').get()).toEqual({ n: 0 });
});

it('rejects cross-conversation message bindings and preserves globally distinct same-local-ID messages', () => {
  const { r } = setup();
  const a = r.createConversation('channel', 'external', 'old-channel');
  const b = r.createConversation('channel', 'external');
  const la = { provider: 'example', workspace: 'one', externalId: 'a', messageId: '100' };
  const lb = { ...la, externalId: 'b' };
  r.bindConversation(la, a.id, 'primary'); r.bindConversation(lb, b.id, 'primary');
  const ma = r.createMessage(a.id), mb = r.createMessage(b.id);
  r.bindMessage(la, ma.id); r.bindMessage(lb, mb.id);
  expect(r.findMessage(la)).not.toBe(r.findMessage(lb));
  expect(() => r.bindMessage(la, mb.id)).toThrow('mismatch');
  const other = r.createMessage(a.id);
  expect(() => r.bindMessage(la, other.id)).toThrow('already bound');
});

it('migrates old references and missing roots without rewriting immutable unknown evidence', () => {
  const { s, r } = setup(); s.register('research', 'legacy', []);
  const m = new Messages(s, configFixture);
  for (const channel of ['CTEST', 'CTWO']) {
    m.membership('research', channel, true);
    m.record({ team: 'TTEST', channel, ts: '102.000001', thread: '100.000001', revision: '105.000001', text: '', user: 'UOWNER', deleted: true }, ['research']);
  }
  s.queueOutput('research', 'unknown', { target: { channel: 'CTEST', thread: '100.000001' }, text: 'wire evidence' });
  s.transitionOutput('unknown', 'pending', 'sending'); s.transitionOutput('unknown', 'sending', 'unknown', { reason: 'lost response' });
  s.queueOutput('research', 'artifact', { target: { channel: 'CTEST' }, text: 'caption', artifact: { content: 'frozen bytes', contentHash: 'hash' } });
  s.transitionOutput('artifact', 'pending', 'sending'); s.transitionOutput('artifact', 'sending', 'unknown', { fileId: 'FFILE', phase: 'sharing' });
  const before = s.db.prepare('SELECT * FROM outbox ORDER BY id').all();
  const journal = s.context(s.register('research', 'legacy', []));
  migrateLegacyReferences(s, 'TTEST');
  const target = r.indexedTarget('outbox', 'unknown')!;
  expect(target).toEqual({ conversationId: 'CTEST', threadId: encode(['TTEST', 'CTEST', '100.000001']) });
  expect(r.message(encode(['TTEST', 'CTEST', '102.000001'])).rootId).toBe(target.threadId);
  expect(r.message(encode(['TTEST', 'CTWO', '102.000001'])).conversationId).toBe('CTWO');
  expect(s.db.prepare('SELECT count(*) n FROM messages').get()).toEqual({ n: 2 });
  expect(s.db.prepare('SELECT count(*) n FROM message_identities').get()).toEqual({ n: 4 });
  expect(s.db.prepare('SELECT * FROM outbox ORDER BY id').all()).toEqual(before);
  expect(s.context(s.register('research', 'legacy', []))).toEqual(journal);
  const epoch = s.db.prepare('SELECT context_epoch FROM sessions').get();
  migrateLegacyReferences(s, 'TTEST');
  expect(s.db.prepare('SELECT context_epoch FROM sessions').get()).toEqual(epoch);
});

it('rolls mapping and view changes back on a conflicting legacy reference', () => {
  const { s } = setup(); s.register('research', 'legacy', []);
  s.queueOutput('research', 'valid', { target: { channel: 'CTEST' }, text: 'valid' });
  s.queueOutput('research', 'invalid', { target: { channel: 'not-slack' }, text: 'conflict' });
  expect(() => migrateLegacyReferences(s, 'TTEST')).toThrow();
  expect(s.db.prepare('SELECT count(*) n FROM conversation_identities').get()).toEqual({ n: 0 });
  expect(s.db.prepare('SELECT count(*) n FROM canonical_targets').get()).toEqual({ n: 0 });
  expect(s.db.prepare('SELECT context_epoch FROM sessions').get()).toEqual({ context_epoch: 0 });
});

it('backs up a v15 database before adding identity mappings and preserves old wire bytes on reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mate-reference-upgrade-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite');
  const original = new Store(path); original.register('research', 'legacy', []);
  original.queueOutput('research', 'old', { target: { channel: 'CTEST' }, text: 'same bytes' });
  const effect = original.output('old');
  original.db.exec('DROP TABLE canonical_targets; DROP TABLE message_bindings; DROP TABLE message_identities; DROP TABLE conversation_bindings; DROP TABLE conversation_identities; PRAGMA user_version=15');
  original.close();
  const upgraded = new Store(path);
  try {
    migrateLegacyReferences(upgraded, 'TTEST');
    expect(upgraded.output('old')).toEqual(effect);
    expect(upgraded.db.pragma('user_version', { simple: true })).toBe(16);
  } finally { upgraded.close(); }
  const backup = new Database(join(dir, readdirSync(dir).find(name => name.includes('.pre-v16-'))!), { readonly: true });
  try { expect(backup.pragma('user_version', { simple: true })).toBe(15); } finally { backup.close(); }
  const reopened = new Store(path);
  try { expect(new References(reopened).indexedTarget('outbox', 'old')).toEqual({ conversationId: 'CTEST' }); expect(reopened.output('old')).toEqual(effect); } finally { reopened.close(); }
});

it('reserves unknown message locations without assuming they are roots, then enriches from evidence', () => {
  const { r } = setup(); const c = r.createConversation('channel', 'internal');
  const unknown = r.reserveMessage(c.id, 'not-loaded');
  expect(unknown.rootId).toBeNull();
  expect(() => r.validateTarget({ conversationId: c.id, threadId: unknown.id })).toThrow('Invalid target');
  const root = r.createMessage(c.id, 'known-root');
  expect(r.createMessage(c.id, unknown.id, root.id).rootId).toBe(root.id);
  expect(() => r.createMessage(c.id, unknown.id, unknown.id)).toThrow('conflict');
});

it('keeps an early tombstone root unknown across migration until a late reply supplies its location', () => {
  const dir=mkdtempSync(join(tmpdir(),'mate-tombstone-mapping-')); cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'state.sqlite'), s=new Store(path); s.register('research','legacy',[]);
  const m=new Messages(s,configFixture); m.membership('research','CTEST',true);
  const tombstone={team:'TTEST',channel:'CTEST',ts:'102.000001',thread:'102.000001',revision:'105.000001',text:'',deleted:true};
  m.record(tombstone,['research']); migrateLegacyReferences(s,'TTEST');
  const id=encode(['TTEST','CTEST','102.000001']);
  expect(new References(s).message(id).rootId).toBeNull(); s.close();
  const reopened=new Store(path);
  try {
    const current=new Messages(reopened,configFixture);
    current.record({...tombstone,thread:'100.000001',revision:'102.000001',text:'late original',deleted:false},['research']);
    migrateLegacyReferences(reopened,'TTEST');
    expect(new References(reopened).message(id).rootId).toBe(encode(['TTEST','CTEST','100.000001']));
    expect(reopened.db.prepare('SELECT deleted FROM messages WHERE key=?').get(id)).toEqual({deleted:1});
    migrateLegacyReferences(reopened,'TTEST');
  } finally { reopened.close(); }
});
