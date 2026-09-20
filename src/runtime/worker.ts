import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { normalizeContext, type Models } from '@earendil-works/pi-ai';
import { generateSummaryWithUsage, type AgentMessage, type StreamFn } from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/pi-agent-core/harness/context';
import { z } from 'zod';
import { Engine, type RunSpec, type ToolReply } from './engine.js';

export async function summarizeWithPi(models: Models, engine: Engine, messages: AgentMessage[], stream: StreamFn, signal: AbortSignal): Promise<string> {
  const bounded: Models = { ...models, completeSimple: async (model, context, options) => (await stream(model, normalizeContext(context), { ...options, signal })).result() };
  const summary = await generateSummaryWithUsage(messages, bounded, engine.model, 2000, undefined, undefined, 'off', { enabled: false, maxRetries: 0, baseDelayMs: 0 }, undefined, withAbortSignal(signal, BACKGROUND_CONTEXT));
  if (!summary.ok) throw new Error('Compaction failed'); return summary.value.text;
}
const startSchema = z.object({ type: z.literal('run'), nonce: z.string(), spec: z.object({ sessionId: z.string(), messages: z.array(z.unknown()), recovery: z.string().max(50000), tokenCap: z.number().int().positive(), costCap: z.number().nonnegative(), maxTurns: z.number().int().min(1).max(20) }) });
/** Separate entrypoint allows tests to supply a synthetic stream without a production config switch. */
export function serveWorker(engine: Engine, models?: Models): void {
  let nonce: string | undefined, counter = 0, active = false;
  let abort = new AbortController();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  function rpc(kind: string, payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++counter; pending.set(id, { resolve, reject });
      process.send?.({ type: 'rpc', nonce, id, kind, payload });
    });
  }
  const stop = () => { abort.abort(); engine.abort(); for (const waiter of pending.values()) waiter.reject(new Error('Worker disconnected or aborted')); pending.clear(); };
  process.on('disconnect', () => { stop(); process.exit(0); });
  process.on('message', async raw => {
    const message = raw as { type?: string; nonce?: string; id?: number; error?: string; value?: unknown };
    if (message.type === 'abort' && message.nonce === nonce) { stop(); return; }
    if (message.type === 'reply' && message.nonce === nonce && message.id) {
      const waiter = pending.get(message.id); pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error)); else waiter?.resolve(message.value); return;
    }
    const parsed = startSchema.safeParse(raw);
    if (!parsed.success) { if (message.type === 'run') process.send?.({ type: 'failed', nonce: message.nonce, error: 'Invalid worker run payload' }); return; }
    if (active) { process.send?.({ type: 'failed', nonce: message.nonce, error: 'Worker already active' }); return; }
    active = true; nonce = parsed.data.nonce; abort = new AbortController();
    try {
      const result = await engine.run(parsed.data.spec as RunSpec, {
        refreshRecovery:async()=>z.string().max(50000).parse(await rpc('refreshRecovery',null)),
        invalidateViews: async()=>{await rpc('invalidateViews',null);},
        notice: async()=>await rpc('notice',null) as string|undefined,
        journal: async message => { await rpc('journal', message); },
        tool: async (id, operation, args) => await rpc('tool', { id, operation, args }) as ToolReply,
        ...(models ? { summarize: async (messages, stream) => summarizeWithPi(models, engine, messages, stream, abort.signal) } : {})
      });
      process.send?.({ type: 'done', nonce, result });
    } catch (error) { process.send?.({ type: 'failed', nonce, error: String(error) }); }
    finally { active = false; }
  });
}
if (process.env.MATE_WORKER === '1') {
  const models = builtinModels();
  const model = models.getModel(process.env.MATE_PROVIDER!, process.env.MATE_MODEL!);
  if (!model || !process.env.MATE_MODEL_KEY) throw new Error('Worker model or credential unavailable');
  serveWorker(new Engine(model, (m, context, options) => models.streamSimple(m, context, { ...options, apiKey: process.env.MATE_MODEL_KEY!, env: {} })), models);
}
