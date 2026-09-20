import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { Store, encode, hash, type RunToken } from '../storage/store.js';
import { Collaboration } from '../collaboration/service.js';
import { canonicalRoot, checkedPath } from '../execution/paths.js';
import { operationSchema, type Operation, type ExecutionBackend } from '../execution/backend.js';
import type { Classifier } from './jev.js';

const policyVersion = 'mate-policy-1-shadow';
interface Grant { id: string; agent_id: string; work_id: string; root: string; operations: string; expires: number; revoked: number; exec_allowlist: string }
interface Approval { id: string; agent_id: string; work_id: string; run_id: string; grant_id: string; request_hash: string; expires: number; status: string; policy_version: string }
export class Broker {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly store: Store, readonly collaboration: Collaboration, private backend: ExecutionBackend,
    private classifier: Classifier, private protectedRoots: string[], private clock: () => number = Date.now) {}
  issueGrant(ownerId: string, agentId: string, workId: string, root: string, operations: Operation['kind'][], expires: number, exactCommands: { command: string; cwd: string }[] = []): string {
    if (!this.collaboration.config.ownerUserIds.includes(ownerId)) throw new Error('Owner only');
    this.collaboration.messages.agent(agentId); this.collaboration.work(workId);
    z.array(z.enum(['read','write','exec'])).min(1).parse(operations); z.number().int().positive().safe().parse(expires);
    if (expires <= this.clock()) throw new Error('Grant already expired');
    const canonical = canonicalRoot(root, this.protectedRoots), id = randomUUID();
    const allowlist = exactCommands.map(command => {
      const op = this.normalize(canonical, operationSchema.parse({ kind: 'exec', ...command }));
      return hash(encode({ operation: op, preconditions: this.preconditions(canonical, op) }));
    });
    this.store.db.prepare('INSERT INTO grants(id,agent_id,work_id,root,operations,expires,exec_allowlist) VALUES(?,?,?,?,?,?,?)').run(id, agentId, workId, canonical, encode(operations), expires, encode(allowlist));
    this.store.audit('grant', { ownerId, id, agentId, workId, root: canonical, operations, expires }); return id;
  }
  revoke(ownerId: string, id: string): void {
    if (!this.collaboration.config.ownerUserIds.includes(ownerId)) throw new Error('Owner only');
    this.store.db.prepare('UPDATE grants SET revoked=1 WHERE id=?').run(id); this.store.audit('grant_revoke', { ownerId, id });
  }
  waiting(runId: string): boolean { return !!this.store.db.prepare('SELECT 1 FROM blocked_runs WHERE run_id=?').get(runId); }
  private normalize(root: string, op: Operation): Operation {
    return op.kind === 'exec' ? { ...op, cwd: relative(root, checkedPath(root, op.cwd)) || '.' }
      : { ...op, path: relative(root, checkedPath(root, op.path)) };
  }
  private grant(run: RunToken, workId: string, id: string, op: Operation): Grant {
    this.store.assertRun(run);
    if (this.collaboration.work(workId).state !== 'active') throw new Error('Work is not active');
    const binding = this.store.db.prepare('SELECT work_id FROM delivery_work WHERE delivery_id=?').get(run.deliveryId) as { work_id: string } | undefined;
    if (binding?.work_id !== workId) throw new Error('Run work mismatch');
    const grant = this.store.db.prepare('SELECT * FROM grants WHERE id=?').get(id) as Grant | undefined;
    if (!grant || grant.agent_id !== run.agentId || grant.work_id !== workId || grant.revoked || grant.expires <= this.clock() || !(JSON.parse(grant.operations) as string[]).includes(op.kind)) throw new Error('Grant does not cover action');
    if (canonicalRoot(grant.root, this.protectedRoots) !== grant.root) throw new Error('Grant root changed');
    checkedPath(grant.root, op.kind === 'exec' ? op.cwd : op.path); return grant;
  }
  private preconditions(root: string, op: Operation): Record<string, string> {
    if (op.kind !== 'exec') return {};
    const cwd = checkedPath(root, op.cwd), files = ['package.json', 'package-lock.json'];
    const script = /^\s*(?:node|python3?|sh|bash)\s+([A-Za-z0-9_.\/-]+)(?:\s|$)/.exec(op.command)?.[1];
    if (script) files.push(script);
    const result: Record<string, string> = {};
    for (const file of files) {
      const path = checkedPath(root, join(op.cwd, file));
      if (!existsSync(path)) continue;
      if (!statSync(path).isFile() || statSync(path).size > 1000000) throw new Error('Inspected script too large or not a file');
      result[file] = hash(readFileSync(path, 'utf8'));
    }
    // cwd existence is required, even for shell builtins.
    if (!statSync(cwd).isDirectory()) throw new Error('Invalid command cwd'); return result;
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
    if (this.waiting(run.id)) return { status: 'run_waiting' };
    const request = { workId, grantId, root: grant.root, operation: op, preconditions: this.preconditions(grant.root, op), policyVersion };
    const preauthorized = (JSON.parse(grant.exec_allowlist) as string[]).includes(hash(encode({ operation: op, preconditions: request.preconditions })));
    const action = this.store.prepareAction(run, actionId, request);
    if (action.state === 'succeeded' || action.state === 'failed') return { status: action.state, receipt: action.receipt ? JSON.parse(action.receipt) : null };
    if (action.state === 'unknown' || action.state === 'executing' || (op.kind !== 'read' && this.store.db.prepare("SELECT 1 FROM actions WHERE agent_id=? AND state IN ('unknown','executing') AND id!=? AND json_extract(request,'$.workId')=? AND (json_extract(request,'$.operation.kind')='exec' OR (json_extract(request,'$.root')=? AND json_extract(request,'$.operation.kind')='write' AND json_extract(request,'$.operation.path')=?))").get(run.agentId, actionId, workId, grant.root, op.kind === 'write' ? op.path : null))) return { status: 'action_unknown', actionId };
    if (op.kind === 'exec' && !preauthorized) {
      let approval = this.store.db.prepare('SELECT * FROM approvals WHERE id=?').get(actionId) as Approval | undefined;
      if (!approval) {
        const classification = await this.classifier.classify({ command: op.command, goal: 'Execute the exact scoped action only after owner approval', evidenceGaps: ['Dynamic dependencies are not fully frozen; classifier is shadow-only'] });
        this.grant(run, workId, grantId, op);
        this.store.atomic(() => {
          this.store.db.prepare('INSERT INTO approvals(id,agent_id,work_id,run_id,grant_id,request_hash,expires,policy_version,classification) VALUES(?,?,?,?,?,?,?,?,?)').run(actionId, run.agentId, workId, run.id, grantId, action.request_hash, Math.min(grant.expires, this.clock() + 900000), policyVersion, encode(classification));
          this.store.db.prepare('INSERT INTO blocked_runs VALUES(?) ON CONFLICT DO NOTHING').run(run.id);
          this.store.audit('approval_pending', { actionId, workId, agentId: run.agentId });
        });
        return { status: 'approval_pending', approvalId: actionId };
      }
      if (approval.status !== 'approved' || approval.expires <= this.clock() || approval.request_hash !== action.request_hash || approval.policy_version !== policyVersion || approval.grant_id !== grantId) return { status: 'approval_unavailable', approvalId: actionId };
    }
    if (signal?.aborted) throw new Error('Action aborted before execution');
    this.grant(run, workId, grantId, op);
    if (encode(this.preconditions(grant.root, op)) !== encode(request.preconditions)) throw new Error('Action preconditions changed');
    this.store.atomic(() => {
      this.store.assertRun(run);
      if (op.kind === 'exec' && !preauthorized && this.store.db.prepare("UPDATE approvals SET status='consumed' WHERE id=? AND status='approved' AND expires>?").run(actionId, this.clock()).changes !== 1) throw new Error('Approval is no longer valid');
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
  decide(ownerId: string, id: string, approve: boolean): void {
    if (!this.collaboration.config.ownerUserIds.includes(ownerId)) throw new Error('Owner only');
    this.store.atomic(() => {
      const approval = this.store.db.prepare('SELECT * FROM approvals WHERE id=?').get(id) as Approval | undefined;
      if (!approval) throw new Error('Unknown approval');
      if (approval.status !== 'pending') return;
      const grant = this.store.db.prepare('SELECT * FROM grants WHERE id=?').get(approval.grant_id) as Grant;
      if (approval.expires <= this.clock() || grant.revoked || grant.expires <= this.clock()) throw new Error('Approval expired or revoked');
      if (this.collaboration.work(approval.work_id).state !== 'active') throw new Error('Work is not active');
      this.store.db.prepare('UPDATE approvals SET status=?,decision_by=? WHERE id=?').run(approve ? 'approved' : 'denied', ownerId, id);
      this.collaboration.enqueue(approval.agent_id, approval.work_id, `approval:${id}`, { kind: 'approval', actionId: id, approved: approve, target: JSON.parse(this.collaboration.work(approval.work_id).target) });
      this.store.audit('approval_decision', { ownerId, id, approve });
    });
  }
}
