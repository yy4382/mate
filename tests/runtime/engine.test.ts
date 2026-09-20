import { expect, it, vi } from 'vitest';
import { createInitialSystemMessage } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Engine, toolDefinition, type RunSpec } from '../../src/runtime/engine.js';
import { repairTranscript, compactionParts } from '../../src/runtime/context.js';
import { answer, model, scripted, deferred } from '../helpers/pi.js';
const spec = (): RunSpec => ({ sessionId: 's', messages: [createInitialSystemMessage('synthetic', [toolDefinition])!, { role: 'user', content: 'test', timestamp: 0 }], recovery: '', tokenCap: 100000, costCap: 1, maxTurns: 4 });
const call = () => answer([{ type: 'toolCall', id: 'c', name: 'mate', arguments: { operation: 'agents', args: {} } }], 'toolUse');
it('journal acknowledgment gates execution and failures cannot become successful runs', async () => {
  const gate = deferred(), tool = vi.fn(async () => ({ value: 'ok' })); let durable = false;
  const engine = new Engine(model, scripted([call(), answer([{ type: 'text', text: 'done' }])]));
  const running = engine.run(spec(), { journal: async m => { if (m.role === 'assistant') { durable = true; await gate.promise; } }, tool });
  await vi.waitFor(() => expect(durable).toBe(true)); expect(tool).not.toHaveBeenCalled(); gate.resolve();
  expect(await running).toMatchObject({ tokens: 24, certain: true }); expect(tool).toHaveBeenCalledOnce();
  const failed = new Engine(model, scripted([call()])); tool.mockClear();
  await expect(failed.run(spec(), { journal: async () => { throw new Error('disk failure'); }, tool })).rejects.toThrow('disk failure');
  expect(tool).not.toHaveBeenCalled();
});
it('approval wait suppresses the rest of a batch and releases the model loop', async () => {
  const message = call(); message.content.push({ type: 'toolCall', id: 'c2', name: 'mate', arguments: { operation: 'exec', args: {} } });
  const tool = vi.fn(async () => ({ value: 'approval_pending', wait: true }));
  const result = await new Engine(model, scripted([message])).run(spec(), { journal: async () => {}, tool });
  expect(result).toMatchObject({ waiting: true, continuation: false }); expect(tool).toHaveBeenCalledOnce();
});
it('budget is enforced before provider invocation and usage is not raced with completion', async () => {
  const stream = vi.fn(scripted([answer([{ type: 'text', text: 'done' }])]));
  const engine = new Engine(model, stream);
  await expect(engine.run({ ...spec(), tokenCap: 1 }, { journal: async () => {}, tool: async () => ({ value: null }) })).rejects.toThrow('budget');
  expect(stream).not.toHaveBeenCalled();
});
it('repair closes partial batches before new input, drops orphan results, retains raw input separately', () => {
  const messages: AgentMessage[] = [...spec().messages, call(), { role: 'user', content: 'restart', timestamp: 1 }];
  const repaired = repairTranscript(messages); expect(repaired.map(m => m.role)).toEqual(['system','user','assistant','toolResult','user']);
  expect(repaired[3]).toMatchObject({ isError: true, toolCallId: 'c' }); expect(messages).toHaveLength(4);
  expect(compactionParts(repaired)?.prefix.map(m => m.role)).toEqual(['user','assistant','toolResult']);
});
it('compaction retains baseline and the last complete turn; failure leaves caller transcript untouched', async () => {
  const input = spec(); input.messages.push(answer([{ type: 'text', text: 'x'.repeat(5000) }]), { role: 'user', content: 'next', timestamp: 1 });
  const engine = new Engine({ ...model, contextWindow: 20000 }, scripted([answer([{ type: 'text', text: 'y'.repeat(4500) }])]));
  const summarize = vi.fn(async () => 'summary');
  const result = await engine.run(input, { journal: async () => {}, tool: async () => ({ value: null }), summarize });
  expect(summarize).toHaveBeenCalledOnce(); expect(result.snapshot?.map(m => m.role)).toEqual(['system','user','user','assistant']);
  expect(input.messages).toHaveLength(4);
});
it('compacts at a closed tool turn before the next request can overflow context', async () => {
  const input = spec(); input.messages.push(answer([{ type: 'text', text: 'h'.repeat(7000) }]), { role: 'user', content: 'read', timestamp: 1 });
  const stream = vi.fn(scripted([call()])); const summarize = vi.fn(async () => 'history summary');
  const result = await new Engine({ ...model, contextWindow: 20000 }, stream).run(input, { journal: async () => {}, tool: async () => ({ value: 'x'.repeat(12000) }), summarize });
  expect(stream).toHaveBeenCalledOnce(); expect(summarize).toHaveBeenCalled();
  expect(result.continuation).toBe(true); expect(result.snapshot).toBeDefined();
});
it('official Pi summary helper routes through the bounded provider boundary', async () => {
  const { builtinModels } = await import('@earendil-works/pi-ai/providers/all');
  const { summarizeWithPi } = await import('../../src/runtime/worker.js');
  const stream = vi.fn(scripted([answer([{ type: 'text', text: 'actual helper summary' }])]));
  const engine = new Engine(model, stream);
  const summary = await summarizeWithPi(builtinModels(), engine, spec().messages, stream, new AbortController().signal);
  expect(summary).toBe('actual helper summary'); expect(stream).toHaveBeenCalledOnce();
});
it('oversized restored history is summarized in bounded reference segments before main inference', async () => {
  const input = spec(); input.tokenCap = 200000; input.messages.push(answer([{ type: 'text', text: 'old'.repeat(10000) }]), { role: 'user', content: 'new', timestamp: 1 });
  const summarize = vi.fn(async (messages: AgentMessage[]) => { expect(JSON.stringify(messages).length).toBeLessThan(4000); return 'cumulative summary'; });
  const stream = vi.fn(scripted([answer([{ type: 'text', text: 'done' }])]));
  const result = await new Engine({ ...model, contextWindow: 20000 }, stream).run(input, { journal: async () => {}, tool: async () => ({ value: null }), summarize });
  expect(summarize.mock.calls.length).toBeGreaterThan(5); expect(stream).toHaveBeenCalledOnce(); expect(result.snapshot).toBeDefined();
});
