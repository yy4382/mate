import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../../src/storage/store.js';
import { configSchema } from '../../src/config.js';
import { configFixture } from '../helpers/config.js';
import { Messages, Output } from '../../src/slack/messages.js';
import { Collaboration } from '../../src/collaboration/service.js';
import { Broker } from '../../src/policy/broker.js';
const cleanups: (() => void)[] = [];
function setup() {
  const root = realpathSync(mkdtempSync(`${tmpdir()}/mate-policy-`)); const db = new Store(':memory:');
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const config = configSchema.parse(configFixture); db.register('research', 'v1', []);
  const messages = new Messages(db, config); messages.membership('research', 'CTEST', true);
  const collaboration = new Collaboration(db, messages, new Output(messages, { post: async () => ({ ts: '101.000001' }) }), config);
  const work = collaboration.createWork('human:one', { channel: 'CTEST', thread: '100.000001' });
  collaboration.enqueue('research', work, 'one', {}); const run = db.beginRun('research')!; db.input(run, {});
  const execute = vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '', truncated: false }));
  const broker = new Broker(db, collaboration, { execute }, ['/synthetic/protected'], () => 1000);
  const grant = broker.issueGrant('UOWNER', 'research', work, root, ['read','write','exec'], 100000);
  return { root, db, collaboration, run, broker, work, grant, execute };
}
afterEach(() => cleanups.splice(0).forEach(fn => fn()));
it('scope checks cover file tools, symlink escapes, work and trusted actor', async () => {
  const { root, run, broker, work, grant, execute } = setup();
  await expect(broker.execute(run, work, 'a', grant, { kind: 'write', path: '../outside', content: 'x' })).rejects.toThrow('escapes');
  symlinkSync('/tmp', `${root}/link`);
  await expect(broker.execute(run, work, 'b', grant, { kind: 'read', path: 'link/secret' })).rejects.toThrow('Symlinks');
  await expect(broker.execute({ ...run, agentId: 'other' }, work, 'c', grant, { kind: 'read', path: 'MEMORY.md' })).rejects.toThrow('Stale');
  await broker.execute(run, work, 'd', grant, { kind: 'write', path: 'MEMORY.md', content: 'safe' }); expect(execute).toHaveBeenCalledTimes(1);
});
it('unknown effects block equivalent new action IDs instead of replaying', async () => {
  const { db, run, broker, work, grant, execute } = setup();
  execute.mockRejectedValueOnce(new Error('lost receipt'));
  const op = { kind: 'write', path: 'note', content: 'one' };
  await expect(broker.execute(run, work, 'first', grant, op)).rejects.toThrow('lost receipt');
  expect(db.action('first')?.state).toBe('unknown');
  expect(await broker.execute(run, work, 'second', grant, op)).toMatchObject({ status: 'action_unknown' }); expect(execute).toHaveBeenCalledTimes(1);
});
it('scoped exec runs directly without a review service or per-command approval', async () => {
  const { run, broker, work, grant, execute, db } = setup();
  const command = { kind: 'exec', cwd: '.', command: 'printf safe' };
  await broker.execute(run, work, 'exec-one', grant, command);
  await broker.execute(run, work, 'exec-one', grant, command);
  expect(execute).toHaveBeenCalledOnce(); expect(db.action('exec-one')?.state).toBe('succeeded');
  expect(db.db.prepare("SELECT name FROM sqlite_master WHERE name='approvals'").get()).toBeUndefined();
});
it('revocation, immutable action identity and cancellation still guard direct execution', async () => {
  const { run, broker, work, grant, execute } = setup();
  const command = { kind: 'exec', cwd: '.', command: 'printf first' };
  await broker.execute(run, work, 'once', grant, command);
  await expect(broker.execute(run, work, 'once', grant, { ...command, command: 'printf changed' })).rejects.toThrow('identity conflict');
  const abort = new AbortController(); abort.abort();
  await expect(broker.execute(run, work, 'aborted', grant, command, abort.signal)).rejects.toThrow('aborted');
  broker.revoke('UOWNER', grant);
  await expect(broker.execute(run, work, 'revoked', grant, command)).rejects.toThrow('Grant'); expect(execute).toHaveBeenCalledOnce();
});
it('expired scope and a foreign work cannot reach the execution backend', async () => {
  const { db, collaboration, run, work, grant, execute } = setup();
  const later = new Broker(db, collaboration, { execute }, ['/synthetic/protected'], () => 200000);
  await expect(later.execute(run, work, 'expired', grant, { kind: 'exec', cwd: '.', command: 'true' })).rejects.toThrow('Grant');
  const other = collaboration.createWork('human:other', { channel: 'CTEST', thread: '100.000001' });
  await expect(new Broker(db, collaboration, { execute }, [], () => 1000).execute(run, other, 'foreign', grant, { kind: 'read', path: 'note' })).rejects.toThrow('mismatch');
  expect(execute).not.toHaveBeenCalled();
});
it('switching activity cannot bypass uncertain effects on the same resources',async()=>{
  const {root,run,broker,work,grant,execute,collaboration:c}=setup();
  execute.mockRejectedValueOnce(new Error('lost'));
  await expect(broker.execute(run,work,'first',grant,{kind:'write',path:'note',content:'x'})).rejects.toThrow('lost');
  const other=c.createWork('other',{channel:'CTEST'});const otherGrant=broker.issueGrant('UOWNER','research',other,root,['write'],100000);c.selectWork(run,other);
  expect(await broker.execute(run,other,'second',otherGrant,{kind:'write',path:'note',content:'x'})).toMatchObject({status:'action_unknown'});
  expect(execute).toHaveBeenCalledTimes(1);
});
