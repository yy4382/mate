import { operationSchema, type ExecutionBackend } from '../execution/backend.js';
import { Collaboration } from '../collaboration/service.js';
import { Store, type RunToken } from '../storage/store.js';

/** Records ordinary Agent actions; Linux user permissions decide filesystem access. */
export class Broker {
  constructor(readonly store: Store, readonly collaboration: Collaboration, private readonly backend: ExecutionBackend,
    private readonly homes: Readonly<Record<string, string>>) {}

  private assertScope(run: RunToken, workId: string): void {
    this.store.assertRun(run);
    const binding = this.store.db.prepare('SELECT work_id FROM delivery_work WHERE delivery_id=?').get(run.deliveryId) as { work_id: string } | undefined;
    if (this.collaboration.currentWork(run, binding?.work_id ?? '') !== workId) throw new Error('Run work mismatch');
  }

  async execute(run: RunToken, workId: string, actionId: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const operation = operationSchema.parse(input);
    this.assertScope(run, workId);
    const home = this.homes[run.agentId];
    if (!home) throw new Error('Agent Linux home is not configured');
    const request = { workId, operation, policyVersion: 'linux-user-1' };
    const action = this.store.prepareAction(run, actionId, request);
    if (action.state === 'succeeded' || action.state === 'failed') return { status: action.state, receipt: action.receipt ? JSON.parse(action.receipt) : null };
    if (action.state === 'unknown' || action.state === 'executing') return { status: 'action_unknown', actionId };
    if (signal?.aborted) throw new Error('Action aborted before execution');
    this.assertScope(run, workId);
    this.store.atomic(() => { this.store.assertRun(run); this.store.startAction(run, actionId); });
    try {
      const result = await this.backend.execute({ agentId: run.agentId, root: home, operation,
        timeoutMs: Math.min(60000, this.collaboration.config.budgets.runTimeoutMs) }, signal);
      this.store.settleAction(run, actionId, result.code === 0 ? 'succeeded' : 'failed', result);
      return result;
    } catch (error) {
      try { this.store.settleAction(run, actionId, 'unknown', { reason: 'execution_or_receipt_failure' }); }
      catch { /* Stop/recovery may already own the uncertain action. */ }
      throw error;
    }
  }
}
