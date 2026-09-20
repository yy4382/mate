import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../../src/storage/store.js';
import { configSchema } from '../../src/config.js';
import { configFixture } from '../helpers/config.js';
import { Messages, Output } from '../../src/slack/messages.js';
import { Collaboration } from '../../src/collaboration/service.js';
import { Broker } from '../../src/policy/broker.js';
import { JevClassifier } from '../../src/policy/jev.js';
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
  const broker = new Broker(db, collaboration, { execute }, { classify: async () => ({ status: 'unavailable' }) }, ['/synthetic/protected'], () => 1000);
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
it('Jev failure means durable approval, releases run, and exact approved action consumes once after resume', async () => {
  const { db, run, broker, work, grant, execute } = setup(); const command = { kind: 'exec', cwd: '.', command: 'printf safe' };
  expect(await broker.execute(run, work, 'a', grant, command)).toEqual({ status: 'approval_pending', approvalId: 'a' });
  expect(await broker.execute(run, work, 'next', grant, { kind: 'write', path: 'x', content: 'bypass' })).toEqual({ status: 'run_waiting' });
  expect(execute).not.toHaveBeenCalled(); db.finish(run);
  expect(() => broker.decide('UONE', 'a', true)).toThrow('Owner only');
  broker.decide('UOWNER', 'a', true); broker.decide('UOWNER', 'a', true);
  const next = db.beginRun('research')!;
  await broker.execute(next, work, 'a', grant, command); await broker.execute(next, work, 'a', grant, command);
  expect(execute).toHaveBeenCalledTimes(1); expect(db.db.prepare('SELECT status FROM approvals WHERE id=?').get('a')).toEqual({ status: 'consumed' });
});
it('approval cannot survive altered parameters/scripts or revoked grant', async () => {
  const { root, db, run, broker, work, grant, execute } = setup(); writeFileSync(`${root}/package.json`, '{"scripts":{"test":"echo first"}}');
  const command = { kind: 'exec', cwd: '.', command: 'npm test' };
  await broker.execute(run, work, 'a', grant, command); db.finish(run); broker.decide('UOWNER', 'a', true);
  const next = db.beginRun('research')!; writeFileSync(`${root}/package.json`, '{"scripts":{"test":"echo changed"}}');
  await expect(broker.execute(next, work, 'a', grant, command)).rejects.toThrow('identity conflict');
  broker.revoke('UOWNER', grant);
  await expect(broker.execute(next, work, 'a', grant, command)).rejects.toThrow('Grant'); expect(execute).not.toHaveBeenCalled();
});
it('exact trusted command grants persist without repeated approvals and invalidate on script changes', async () => {
  const { root, run, broker, work, execute } = setup(); writeFileSync(`${root}/package.json`, '{"scripts":{"test":"echo one"}}');
  const grant = broker.issueGrant('UOWNER', 'research', work, root, ['exec'], 100000, [{ command: 'npm test', cwd: './' }]);
  const command = { kind: 'exec', cwd: '.', command: 'npm test' };
  await broker.execute(run, work, 'one', grant, command); await broker.execute(run, work, 'two', grant, command);
  expect(execute).toHaveBeenCalledTimes(2);
  writeFileSync(`${root}/package.json`, '{"scripts":{"test":"echo two"}}');
  expect(await broker.execute(run, work, 'changed', grant, command)).toMatchObject({ status: 'approval_pending' });
  expect(execute).toHaveBeenCalledTimes(2);
});
it('unknown effects block equivalent new action IDs instead of replaying', async () => {
  const { db, run, broker, work, grant, execute } = setup();
  execute.mockRejectedValueOnce(new Error('lost receipt'));
  const op = { kind: 'write', path: 'note', content: 'one' };
  await expect(broker.execute(run, work, 'first', grant, op)).rejects.toThrow('lost receipt');
  expect(db.action('first')?.state).toBe('unknown');
  expect(await broker.execute(run, work, 'second', grant, op)).toMatchObject({ status: 'action_unknown' }); expect(execute).toHaveBeenCalledTimes(1);
});
it('Jev adapter pins version, redacts supplied secrets and fails closed on transport failure', async () => {
  const classifier = new JevClassifier('synthetic-key', ['synthetic-private-value'], async (_url, init) => {
    expect(String(init?.body)).toContain('jev-1.13.0'); expect(String(init?.body)).not.toContain('synthetic-private-value'); throw new Error('offline');
  });
  expect(await classifier.classify({ command: 'echo synthetic-private-value', goal: 'test', evidenceGaps: [] })).toEqual({ status: 'unavailable', automaticAllow: false });
});
