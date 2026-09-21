import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { relative } from 'node:path';
import { z } from 'zod';
import { Store, encode, type RunToken } from '../storage/store.js';
import { Collaboration } from '../collaboration/service.js';
import { canonicalRoot, checkedPath } from '../execution/paths.js';
import { operationSchema, permissionFor, type Permission, type Operation, type ExecutionBackend } from '../execution/backend.js';

const policyVersion = 'mate-scope-2';
interface Grant { id: string; agent_id: string; work_id: string; root: string; operations: string; expires: number; revoked: number; }
export interface EffectiveGrant {id:string;root:string;operations:Permission[];expires:number}
export class Broker {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly store: Store, readonly collaboration: Collaboration, private backend: ExecutionBackend,
    private protectedRoots: string[], private clock: () => number = Date.now) {}
  issueGrant(ownerId: string, agentId: string, workId: string, root: string, operations: Permission[], expires: number): string {
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
      : { ...op, path: relative(root, checkedPath(root, op.path)) || '.', ...(op.kind==='move' ? {destination:relative(root,checkedPath(root,op.destination)) || '.'} : {}) };
  }
  private assertScope(run:RunToken,workId:string):{seatRoot?:string}{
    this.store.assertRun(run);
    this.collaboration.assertActionWork(run,workId);
    const binding = this.store.db.prepare('SELECT work_id FROM delivery_work WHERE delivery_id=?').get(run.deliveryId) as { work_id: string } | undefined;
    if (this.collaboration.currentWork(run, binding?.work_id ?? '') !== workId) throw new Error('Run work mismatch');
    this.collaboration.messages.requireAccess(run.agentId, JSON.parse(this.collaboration.work(workId).target).conversationId);
    const seat=this.collaboration.seats.active(run.agentId);return seat?{seatRoot:seat.workspace}:{};
  }
  private effective(run:RunToken,workId:string,grant:Grant,permission?:Permission):boolean{
    const scope=this.assertScope(run,workId);
    if(grant.agent_id!==run.agentId||grant.work_id!==workId||grant.revoked||grant.expires<=this.clock())return false;
    const operations=z.array(z.enum(['read','write','exec'])).parse(JSON.parse(grant.operations));
    if(permission&&!operations.includes(permission))return false;
    if(scope.seatRoot&&grant.root!==scope.seatRoot)return false;
    try{if(canonicalRoot(grant.root,this.protectedRoots)!==grant.root)throw new Error('changed');}
    catch{throw new Error('Grant root unavailable or changed');}
    return true;
  }
  effectiveGrants(run:RunToken,workId:string):EffectiveGrant[]{
    this.assertScope(run,workId);
    const rows=this.store.db.prepare('SELECT * FROM grants WHERE agent_id=? AND work_id=? ORDER BY rowid').all(run.agentId,workId) as Grant[];
    return rows.filter(row=>this.effective(run,workId,row)).map(row=>({id:row.id,root:row.root,operations:z.array(z.enum(['read','write','exec'])).parse(JSON.parse(row.operations)),expires:row.expires}));
  }
  private grant(run: RunToken, workId: string, id: string, op: Operation): Grant {
    const grant = this.store.db.prepare('SELECT * FROM grants WHERE id=?').get(id) as Grant | undefined;
    const seat=this.collaboration.seats.active(run.agentId);if(grant&&seat&&grant.root!==seat.workspace)throw new Error('Review seat permits only its clean private workspace');
    if (!grant || !this.effective(run,workId,grant,permissionFor(op))) throw new Error('Grant does not cover action');
    checkedPath(grant.root, op.kind === 'exec' ? op.cwd : op.path);
    if(op.kind==='move')checkedPath(grant.root,op.destination);
    if(permissionFor(op)==='write' && (relative(grant.root,checkedPath(grant.root,op.kind==='exec'?op.cwd:op.path))==='' || (op.kind==='move' && relative(grant.root,checkedPath(grant.root,op.destination))==='')))throw new Error('Cannot mutate workspace root');
    return grant;
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
    if (action.state === 'unknown' || action.state === 'executing' || (permissionFor(op) !== 'read' && this.store.db.prepare("SELECT 1 FROM actions WHERE agent_id=? AND state IN ('unknown','executing') AND id!=? AND (json_extract(request,'$.operation.kind')='exec' OR (json_extract(request,'$.root')=? AND json_extract(request,'$.operation.kind') NOT IN ('read','read_bytes','stat','list','search')))").get(run.agentId, actionId, grant.root))) return { status: 'action_unknown', actionId };
    if (signal?.aborted) throw new Error('Action aborted before execution');
    this.grant(run, workId, grantId, op);
    this.store.atomic(() => {
      this.store.assertRun(run);
      this.store.startAction(run, actionId);
    });
    try {
      const result = await this.backend.execute({ root: grant.root, operation: op, timeoutMs: Math.min(60000, this.collaboration.config.budgets.runTimeoutMs),...(this.collaboration.seats.active(run.agentId)?{network:'none' as const}:{}) }, signal);
      this.store.settleAction(run, actionId, result.code === 0 ? 'succeeded' : 'failed', result);
      return result;
    } catch (error) {
      try { this.store.settleAction(run, actionId, 'unknown', { reason: 'execution_or_receipt_failure' }); } catch { /* stop/recovery already fences and marks unknown */ }
      throw error;
    }
  }
}
