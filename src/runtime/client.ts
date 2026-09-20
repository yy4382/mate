import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { EngineHooks, EngineResult, RunSpec } from './engine.js';
const rpcSchema = z.object({ type: z.literal('rpc'), nonce: z.string(), id: z.number().int().positive(), kind: z.enum(['journal','tool','notice','invalidateViews','refreshRecovery']), payload: z.unknown() }).strict();
const resultSchema = z.object({ tokens: z.number().int().nonnegative(), cost: z.number().finite().nonnegative(), certain: z.boolean(), waiting: z.boolean(), continuation: z.boolean(), snapshot: z.array(z.unknown()).optional() }).strict();
export class WorkerClient {
  readonly child: ChildProcess;
  private active?: { nonce: string; reject(error: Error): void };
  constructor(provider: string, model: string, key: string, entry = new URL('./worker.js', import.meta.url)) {
    this.child = fork(entry, [], { env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', MATE_WORKER: '1', MATE_PROVIDER: provider, MATE_MODEL: model, MATE_MODEL_KEY: key }, execArgv: [], stdio: ['ignore','ignore','ignore','ipc'], serialization: 'json' });
    this.child.on('error', error => this.active?.reject(error));
    this.child.on('exit', () => this.active?.reject(new Error('Worker exited; usage and unfinished effects are uncertain')));
  }
  async run(spec: RunSpec, hooks: EngineHooks, timeoutMs: number, signal: AbortSignal): Promise<EngineResult> {
    if (this.active || !this.child.connected) throw new Error('Worker unavailable');
    const nonce = randomUUID();
    return new Promise((resolve, reject) => {
      let settled = false, busy = false, sequence = 0;
      const finish = (error?: Error, result?: EngineResult) => {
        if (settled) return; settled = true;
        clearTimeout(timer); signal.removeEventListener('abort', onAbort); this.child.off('message', onMessage); delete this.active;
        if (error) { this.child.kill('SIGKILL'); reject(error); } else resolve(result!);
      };
      const onAbort = () => finish(new Error('Worker run aborted'));
      const timer = setTimeout(() => finish(new Error('Worker run timed out')), timeoutMs);
      this.active = { nonce, reject: error => finish(error) };
      const onMessage = async (raw: unknown) => {
        if (Buffer.byteLength(JSON.stringify(raw)) > 2_000_000) { finish(new Error('Oversize worker message')); return; }
        const envelope = raw as { nonce?: string; type?: string; result?: unknown; error?: string };
        if (envelope.nonce !== nonce || settled) return;
        if (envelope.type === 'failed') { finish(new Error(envelope.error ?? 'Worker failed')); return; }
        if (envelope.type === 'done') {
          const parsed = resultSchema.safeParse(envelope.result);
          if (!parsed.success || busy) finish(new Error('Invalid worker completion')); else finish(undefined, parsed.data as EngineResult); return;
        }
        const parsed = rpcSchema.safeParse(raw);
        if (!parsed.success || busy || parsed.data.id <= sequence) { finish(new Error('Invalid worker RPC')); return; }
        busy = true; const call = parsed.data; sequence = call.id;
        try {
          let value: unknown;
          if(call.kind==='refreshRecovery')value=z.string().max(50000).parse(await hooks.refreshRecovery?.()??spec.recovery);
          else if(call.kind==='invalidateViews') await hooks.invalidateViews?.();
          else if (call.kind === 'notice') value=await hooks.notice?.();
          else if (call.kind === 'journal') {
            const msg = z.object({ role: z.enum(['system','user','assistant','toolResult']) }).passthrough().parse(call.payload);
            await hooks.journal(msg as AgentMessage);
          } else {
            const tool = z.object({ id: z.string().min(1).max(500), operation: z.string().max(100), args: z.unknown() }).strict().parse(call.payload);
            value = await hooks.tool(tool.id, tool.operation, tool.args);
          }
          if (!settled) this.child.send({ type: 'reply', nonce, id: call.id, value });
        } catch (error) { if (!settled) this.child.send({ type: 'reply', nonce, id: call.id, error: String(error) }); }
        finally { busy = false; }
      };
      this.child.on('message', onMessage); signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort(); else this.child.send({ type: 'run', nonce, spec });
    });
  }
  close(): void { this.active?.reject(new Error('Worker closed')); this.child.kill('SIGKILL'); }
}
