import { afterEach, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Store } from '../../src/storage/store.js';
import { configSchema } from '../../src/config.js';
import { configFixture } from '../helpers/config.js';
import { Messages, Output } from '../../src/slack/messages.js';
import { Collaboration } from '../../src/collaboration/service.js';
import { Broker } from '../../src/policy/broker.js';
import { Supervisor, type Worker } from '../../src/runtime/supervisor.js';
import { WorkerClient } from '../../src/runtime/client.js';
import { ToolRouter } from '../../src/runtime/tools.js';
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(fn => fn()));
function setup(factory?: (id: string) => Worker) {
  const config = configSchema.parse({ ...configFixture, agents: [configFixture.agents[0], { ...configFixture.agents[0], id: 'writer', name: 'Writer', slackAppId: 'ATWO', slackUserId: 'UTWO', slackBotId: 'BTWO', botTokenEnv: 'WRITER_BOT', appTokenEnv: 'WRITER_APP' }] });
  const store = new Store(':memory:'), messages = new Messages(store, config), output = new Output(messages, { post: async () => ({ ts: '100.000002' }) }), collaboration = new Collaboration(store, messages, output, config);
  const broker = new Broker(store, collaboration, { execute: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }) }, { classify: async () => ({ status: 'unavailable' }) }, ['/never']);
  const router = new ToolRouter(collaboration, broker);
  const supervisor = new Supervisor(collaboration, router, config, agent => factory?.(agent.id) ?? new WorkerClient('test', 'test', 'only-provider-secret', new URL('../../dist/tests/helpers/worker-fixture.js', import.meta.url)));
  supervisor.register();
  for (const agent of config.agents) for (const channel of ['CTEST','CTWO']) messages.membership(agent.id, channel, true);
  const work = collaboration.createWork('human:one', { channel: 'CTEST', thread: '100.000001' });
  cleanups.push(() => { supervisor.close(); store.close(); }); return { config, store, collaboration, supervisor, router, work };
}
function last(store: Store, agent: string) {
  const row = store.db.prepare('SELECT session_id FROM agents WHERE id=?').get(agent) as { session_id: string };
  const message = (store.context(row.session_id) as AgentMessage[]).findLast(m => m.role === 'assistant');
  if (message?.role !== 'assistant' || message.content[0]?.type !== 'text') throw new Error('No assistant result');
  return { session: row.session_id, data: JSON.parse(message.content[0].text) };
}
it('real worker processes retain cross-channel context and isolate Agent state and inherited secrets', async () => {
  process.env.SYNTHETIC_SLACK_SECRET = 'must-not-inherit';
  try {
    const { store, collaboration: c, supervisor, work } = setup();
    c.enqueue('research', work, 'channel-one', { text: 'first private input', target: { channel: 'CTEST', thread: '100.000001' } });
    await supervisor.step('research'); const first = last(store, 'research');
    c.enqueue('research', work, 'channel-two', { text: 'second channel', target: { channel: 'CTWO', thread: '100.000001' } });
    c.enqueue('writer', work, 'writer-one', { text: 'writer only' });
    await Promise.all([supervisor.step('research'), supervisor.step('writer')]);
    const second = last(store, 'research'), writer = last(store, 'writer');
    expect(second.session).toBe(first.session); expect(second.data.calls).toBe(2); expect(second.data.pid).toBe(first.data.pid);
    expect(writer.session).not.toBe(first.session); expect(writer.data.pid).not.toBe(first.data.pid); expect(writer.data.calls).toBe(1);
    expect(JSON.stringify(second.data.context)).toContain('first private input'); expect(JSON.stringify(writer.data.context)).not.toContain('first private input');
    expect(second.data.env).not.toContain('SYNTHETIC_SLACK_SECRET'); expect(second.data.env).not.toContain('HOME');
  } finally { delete process.env.SYNTHETIC_SLACK_SECRET; }
}, 15000);
it('worker loss keeps reservation and input; explicit recovery resumes the same logical session', async () => {
  let failures = true;
  const { store, collaboration: c, supervisor, work } = setup(() => failures ? { run: async () => { throw new Error('killed'); }, close: () => {} } : new WorkerClient('test','test','key',new URL('../../dist/tests/helpers/worker-fixture.js',import.meta.url)));
  const delivery = c.enqueue('research', work, 'one', { text: 'recover me' });
  await supervisor.step('research'); expect(store.delivery(delivery).status).toBe('injected'); expect(c.work(work).tokens).toBe(50000);
  // The owner explicitly raises exhausted budget before resuming this synthetic test.
  store.db.prepare('UPDATE works SET max_tokens=300000 WHERE id=?').run(work); store.resume('research'); failures = false;
  await supervisor.step('research'); expect(store.delivery(delivery).status).toBe('handled'); expect(JSON.stringify(last(store,'research').data.context)).toContain('recover me');
}, 10000);
it('local tools use immutable receipts and cannot cross work scope', async () => {
  const { store, collaboration: c, work, router } = setup(); c.enqueue('research', work, 'one', {}); const run = store.beginRun('research')!; store.input(run, {});
  const target = { channel: 'CTEST', thread: '100.000001' }, signal = new AbortController().signal;
  const created = await router.call(run, work, 'create', 'tasks.create', { target, title: 'one' }, signal);
  expect(await router.call(run, work, 'create', 'tasks.create', { target, title: 'one' }, signal)).toEqual(created); expect(c.list('research')).toHaveLength(1);
  const other = c.createWork('human:other', target), task = c.createTask('research', other, target, 'other');
  await expect(router.call(run, work, 'claim', 'tasks.claim', { taskId: task }, signal)).rejects.toThrow('another work');
  await expect(router.call(run, work, 'spoof', 'messages.send', { target, text: 'hi', agentId: 'writer' }, signal)).rejects.toThrow();
});
it('recovery is bounded even with large task results; memory callback is injected and hashed', async () => {
  let seen: import('../../src/runtime/engine.js').RunSpec | undefined;
  const { store, collaboration: c, work, router, config, supervisor: original } = setup(); original.close();
  const supervisor = new Supervisor(c, router, config, () => ({ run: async spec => { seen = spec; return { tokens: 0, cost: 0, certain: true, waiting: false, continuation: false }; }, close: () => {} }), async () => '私有memory'.repeat(10000));
  cleanups.unshift(() => supervisor.close());
  for (let n = 0; n < 3; n++) { const task = c.createTask('research', work, { channel: 'CTEST', thread: '100.000001' }, 'big'); c.claim('research', task); c.update('research', task, 'review', 'x'.repeat(35000)); }
  c.enqueue('research', work, 'large', {}); await supervisor.step('research');
  expect(Buffer.byteLength(seen!.recovery)).toBeLessThan(15000); expect(JSON.parse(seen!.recovery).memoryNeedsOrganization).toBe(true);
  expect(JSON.parse(seen!.recovery).memory).toContain('私有memory'); expect(store.db.prepare("SELECT count(*) n FROM audit WHERE kind='context_restore'").get()).toEqual({ n: 1 });
});
it('inbox list/read cannot reveal a revoked channel and ack never handles queued delivery', async () => {
  const { store, collaboration: c, work, router } = setup(); const first = c.enqueue('research', work, 'first', {}); const run = store.beginRun('research')!; store.input(run, {});
  const secret = c.enqueue('research', work, 'secret', { target: { channel: 'CTWO', thread: '100.000001' }, text: 'private' });
  c.messages.membership('research', 'CTWO', false); const signal = new AbortController().signal;
  expect(JSON.stringify(await router.call(run, work, 'list', 'inbox.list', {}, signal))).not.toContain(secret);
  await expect(router.call(run, work, 'read', 'inbox.read', { deliveryId: secret }, signal)).rejects.toThrow();
  await router.call(run, work, 'ack', 'inbox.ack', { deliveryId: first }, signal); expect(store.delivery(first).status).toBe('injected');
});
it('invalid run IPC fails immediately instead of consuming the run timeout', async () => {
  const worker = new WorkerClient('test','test','key',new URL('../../dist/tests/helpers/worker-fixture.js',import.meta.url));
  try { await expect(worker.run({ sessionId: 's', messages: [], recovery: 'x'.repeat(50001), tokenCap: 100, costCap: 1, maxTurns: 1 }, { journal: async () => {}, tool: async () => ({ value: null }) }, 10000, new AbortController().signal)).rejects.toThrow('Invalid worker run payload'); }
  finally { worker.close(); }
}, 2000);
it('crash after effect commit before tool-result journal restores its receipt without re-execution', async () => {
  const { answer } = await import('../helpers/pi.js'); let first = true, restored = '';
  const { store, collaboration: c, work, supervisor } = setup(() => ({ close: () => {}, run: async (spec, hooks) => {
    if (first) {
      first = false;
      await hooks.journal(answer([{ type: 'toolCall', id: 'create-committed', name: 'mate', arguments: { operation: 'tasks.create', args: { target: { channel: 'CTEST', thread: '100.000001' }, title: 'commit before crash' } } }], 'toolUse'));
      await hooks.tool('create-committed', 'tasks.create', { target: { channel: 'CTEST', thread: '100.000001' }, title: 'commit before crash' });
      throw new Error('kill before result journal');
    }
    restored = JSON.stringify(spec.messages); return { tokens: 0, cost: 0, certain: true, waiting: false, continuation: false };
  } }));
  c.enqueue('research', work, 'crash-window', {}); await supervisor.step('research'); expect(c.list('research')).toHaveLength(1);
  store.resume('research'); await supervisor.step('research'); expect(c.list('research')).toHaveLength(1);
  expect(restored).toContain('recoveredAction'); expect(restored).toContain('succeeded'); expect(restored).toContain('Historical receipt');
});
