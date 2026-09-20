import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { relative } from 'node:path';
import { z } from 'zod';
import { Store, encode, type RunToken } from '../storage/store.js';
import { Collaboration } from '../collaboration/service.js';
import { canonicalRoot, checkedPath } from '../execution/paths.js';
import { operationSchema, type Operation, type ExecutionBackend } from '../execution/backend.js';

const policyVersion = 'mate-scope-2';
interface Grant { id: string; agent_id: string; work_id: string; root: string; operations: string; expires: number; revoked: number; }
export class Broker {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly store: Store, readonly collaboration: Collaboration, private backend: ExecutionBackend,
    private protectedRoots: string[], private clock: () => number = Date.now) {}
  issueGrant(ownerId: string, agentId: string, workId: string, root: string, operations: Operation['kind'][], expires: number): string {
    if (!this.collaboration.config.ownerUserIds.includes(ownerId)) throw new Error('Owner only');
    this.collaboration.messages.agent(agentId); this.collaboration.work(workId);
    z.array(z.enum(['read','write','exec'])).min(1).parse(operations); z.number().int().positive().safe().parse(expires);
    if (expires <= this.clock()) throw new Error('Grant already expired');
    const canonical = canonicalRoot(root, this.protectedRoots), id = randomUUID();
    this.store.db.prepare('INSERT INTO grants(id,agent_id,work_id,root,operations,expires) VALUES(?,?,?,?,?,?)').run(id, agentId, workId, canonical, encode(operations), expires);
    this.store.audit('grant', { ownerId, id, agentId, workId, root: canonical, operations, expires }); return id;
  }
  revoke(ownerId: string, id: string): void {
    if (!this.collaboration.config.ownerUserIds.includes(ownerId)) throw new Error('Owner only');
    this.store.db.prepare('UPDATE grants SET revoked=1 WHERE id=?').run(id); this.store.audit('grant_revoke', { ownerId, id });
  }
  private normalize(root: string, op: Operation): Operation {
    return op.kind === 'exec' ? { ...op, cwd: relative(root, checkedPath(root, op.cwd)) || '.' }
      : { ...op, path: relative(root, checkedPath(root, op.path)) };
  }
  private grant(run: RunToken, workId: string, id: string, op: Operation): Grant {
    this.store.assertRun(run);
    this.collaboration.assertActionWork(run,workId);
    const binding = this.store.db.prepare('SELECT work_id FROM delivery_work WHERE delivery_id=?').get(run.deliveryId) as { work_id: string } | undefined;
    if (this.collaboration.currentWork(run, binding?.work_id ?? '') !== workId) throw new Error('Run work mismatch');
    this.collaboration.messages.requireAccess(run.agentId, JSON.parse(this.collaboration.work(workId).target).channel);
    const grant = this.store.db.prepare('SELECT * FROM grants WHERE id=?').get(id) as Grant | undefined;
    if (!grant || grant.agent_id !== run.agentId || grant.work_id !== workId || grant.revoked || grant.expires <= this.clock() || !(JSON.parse(grant.operations) as string[]).includes(op.kind)) throw new Error('Grant does not cover action');
    if (canonicalRoot(grant.root, this.protectedRoots) !== grant.root) throw new Error('Grant root changed');
    checkedPath(grant.root, op.kind === 'exec' ? op.cwd : op.path); return grant;
  }
  execute(run: RunToken, workId: string, actionId: string, grantId: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    // Serial broker execution also covers file writes and side-effecting shell calls.
    const next = this.queue.then(() => this.perform(run, workId, actionId, grantId, input, signal));
    this.queue = next.catch(() => {}); return next;
  }
  private async perform(run: RunToken, workId: string, actionId: string, grantId: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    let op = operationSchema.parse(input);
    const grant = this.grant(run, workId, grantId, op);
    op = this.normalize(grant.root, op);
    if (op.kind === 'exec' && !statSync(checkedPath(grant.root, op.cwd)).isDirectory()) throw new Error('Invalid command cwd');
    const request = { workId, grantId, root: grant.root, operation: op, policyVersion };
    const action = this.store.prepareAction(run, actionId, request);
    if (action.state === 'succeeded' || action.state === 'failed') return { status: action.state, receipt: action.receipt ? JSON.parse(action.receipt) : null };
    if (action.state === 'unknown' || action.state === 'executing' || (op.kind !== 'read' && this.store.db.prepare("SELECT 1 FROM actions WHERE agent_id=? AND state IN ('unknown','executing') AND id!=? AND (json_extract(request,'$.operation.kind')='exec' OR (json_extract(request,'$.root')=? AND json_extract(request,'$.operation.kind')='write' AND json_extract(request,'$.operation.path')=?))").get(run.agentId, actionId, grant.root, op.kind === 'write' ? op.path : null))) return { status: 'action_unknown', actionId };
    if (signal?.aborted) throw new Error('Action aborted before execution');
    this.grant(run, workId, grantId, op);
    this.store.atomic(() => {
      this.store.assertRun(run);
      this.store.startAction(run, actionId);
    });
    try {
      const result = await this.backend.execute({ root: grant.root, operation: op, timeoutMs: Math.min(60000, this.collaboration.config.budgets.runTimeoutMs) }, signal);
      this.store.settleAction(run, actionId, result.code === 0 ? 'succeeded' : 'failed', result);
      return result;
    } catch (error) {
      try { this.store.settleAction(run, actionId, 'unknown', { reason: 'execution_or_receipt_failure' }); } catch { /* stop/recovery already fences and marks unknown */ }
      throw error;
    }
  }
}
