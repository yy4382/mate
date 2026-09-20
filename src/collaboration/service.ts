import { BudgetLedger } from '../budget/ledger.js';
import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { Store, encode, type RunToken } from '../storage/store.js';
import { Messages, Output, targetSchema, type Target } from '../slack/messages.js';
import type { MateConfig } from '../config.js';

export interface Work { id: string; target: string; state: string; max_runs: number; max_tokens: number; max_cost: number; runs: number; tokens: number; cost: number }
export interface Task { id: string; work_id: string; parent_id: string | null; target: string; title: string; owner: string | null; assigned_to: string | null; status: string; version: number; waiting_on: string | null; result: string | null; outbox_id: string | null }
interface Schedule { id: string; agent_id: string; work_id: string; task_id: string | null; target: string; next_at: number; cron: string | null; timezone: string; active: number }
export class Collaboration {
  readonly ledger: BudgetLedger;
  constructor(readonly store: Store, readonly messages: Messages, readonly output: Output, readonly config: MateConfig) { this.ledger = new BudgetLedger(store, config); }
  work(id: string): Work { const work = this.store.db.prepare('SELECT * FROM works WHERE id=?').get(id) as Work | undefined; if (!work) throw new Error('Unknown work'); return work; }
  task(id: string): Task { const task = this.store.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Task | undefined; if (!task) throw new Error('Unknown task'); return task; }
  list(agentId: string): Task[] {
    this.messages.agent(agentId);
    return this.store.db.prepare("SELECT t.* FROM tasks t JOIN channel_access a ON a.channel=json_extract(t.target,'$.channel') WHERE a.agent_id=? AND a.active=1 ORDER BY t.rowid DESC LIMIT 100").all(agentId) as Task[];
  }
  currentWork(run: RunToken, fallback: string): string {
    this.store.assertRun(run);
    return (this.store.db.prepare('SELECT work_id FROM run_context WHERE run_id=?').get(run.id) as {work_id:string}|undefined)?.work_id ?? fallback;
  }
  assertActionWork(run: RunToken, workId: string): void {
    this.store.assertRun(run);const work=this.active(workId);
    const reserved=this.store.db.prepare('SELECT 1 FROM work_runs WHERE run_id=? AND work_id=?').get(run.id,workId);
    if(!reserved && (work.runs>=work.max_runs || work.tokens>=work.max_tokens || work.cost>=work.max_cost)) throw new Error('Work budget exhausted');
  }
  selectWork(run: RunToken, workId: string): void {
    this.assertActionWork(run,workId); const work=this.active(workId);
    this.messages.requireAccess(run.agentId, JSON.parse(work.target).channel);
    this.store.atomic(()=>{
      this.store.db.prepare('INSERT INTO run_context VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET work_id=excluded.work_id').run(run.id,workId);
      this.store.db.prepare('INSERT INTO delivery_context VALUES(?,?) ON CONFLICT(delivery_id) DO UPDATE SET work_id=excluded.work_id').run(run.deliveryId,workId);
    });
  }
  private active(workId: string): Work { const work = this.work(workId); if (work.state !== 'active') throw new Error('Work paused or cancelled'); return work; }
  private event(taskId: string, body: unknown): void { this.store.db.prepare('INSERT INTO task_events(task_id,at,body) VALUES(?,?,?)').run(taskId, Date.now(), encode(body)); }
  /** Work identifies an activity; it never grants or replenishes an Agent account. */
  createWork(origin: string, target: Target): string {
    targetSchema.parse(target);
    return this.store.atomic(() => {
      const old = this.store.db.prepare('SELECT id FROM works WHERE origin=?').get(origin) as { id: string } | undefined; if (old) return old.id;
      const id = randomUUID(), b = this.config.budgets;
      this.store.db.prepare('INSERT INTO works(id,origin,target,max_runs,max_tokens,max_cost) VALUES(?,?,?,?,?,?)').run(id, origin, encode(target), b.maxRuns, b.maxTokens, b.maxCostUsd);
      return id;
    });
  }
  bindDelivery(deliveryId: string, workId: string): void {
    this.work(workId);
    const old = this.store.db.prepare('SELECT work_id FROM delivery_work WHERE delivery_id=?').get(deliveryId) as { work_id: string } | undefined;
    if (old && old.work_id !== workId) throw new Error('Delivery work conflict');
    this.store.db.prepare('INSERT INTO delivery_work VALUES(?,?) ON CONFLICT DO NOTHING').run(deliveryId, workId);
  }
  enqueue(agentId: string, workId: string, key: string, payload: unknown): string {
    return this.store.atomic(() => { this.active(workId); const id = this.store.enqueue(agentId, key, payload, 50); this.bindDelivery(id, workId); return id; });
  }
  send(agentId: string, workId: string, target: Target, text: string, id: string = randomUUID()): string {
    return this.store.atomic(() => {
      this.active(workId); this.output.queue(agentId, target, text, id);
      const old = this.store.db.prepare('SELECT work_id FROM output_work WHERE output_id=?').get(id) as { work_id: string } | undefined;
      if (old && old.work_id !== workId) throw new Error('Output work conflict');
      this.store.db.prepare('INSERT INTO output_work VALUES(?,?) ON CONFLICT DO NOTHING').run(id, workId); return id;
    });
  }
  /** Reserve worst-case allowance before model execution. Unknown usage retains the reservation. */
  reserve(run: RunToken, workId: string, tokens: number, cost: number): void {
    z.number().int().positive().parse(tokens); z.number().nonnegative().finite().parse(cost);
    this.store.atomic(() => {
      this.store.assertRun(run); const work = this.active(workId);
      if (this.store.db.prepare('SELECT 1 FROM work_runs WHERE run_id=?').get(run.id)) throw new Error('Run already reserved');
      const binding = this.store.db.prepare('SELECT COALESCE(dc.work_id,dw.work_id) work_id FROM delivery_work dw LEFT JOIN delivery_context dc ON dc.delivery_id=dw.delivery_id WHERE dw.delivery_id=?').get(run.deliveryId) as { work_id: string } | undefined;
      if (!binding || binding.work_id !== workId) throw new Error('Run work mismatch');
      if (work.runs + 1 > work.max_runs || work.tokens + tokens > work.max_tokens || work.cost + cost > work.max_cost) throw new Error('Work budget exhausted');
      this.ledger.reserve(run, tokens, cost);
      this.store.db.prepare('INSERT INTO run_context VALUES(?,?) ON CONFLICT DO NOTHING').run(run.id, workId);
      this.store.db.prepare('UPDATE works SET runs=runs+1,tokens=tokens+?,cost=cost+? WHERE id=?').run(tokens, cost, workId);
      this.store.db.prepare('INSERT INTO work_runs(run_id,work_id,token_cap,cost_cap) VALUES(?,?,?,?)').run(run.id, workId, tokens, cost);
    });
  }
  settleUsage(runId: string, tokens: number, cost: number): void {
    z.number().int().nonnegative().parse(tokens); z.number().finite().nonnegative().parse(cost);
    this.store.atomic(() => {
      this.ledger.settle(runId, tokens, cost);
      const row = this.store.db.prepare('SELECT * FROM work_runs WHERE run_id=?').get(runId) as { work_id: string; token_cap: number; cost_cap: number; settled: number } | undefined;
      if (!row || row.settled) return;
      this.store.db.prepare('UPDATE works SET tokens=tokens+?,cost=MAX(0,cost+?) WHERE id=?').run(tokens - row.token_cap, cost - row.cost_cap, row.work_id);
      this.store.db.prepare('UPDATE work_runs SET settled=1 WHERE run_id=?').run(runId);
      if (tokens > row.token_cap || cost > row.cost_cap) this.store.db.prepare("UPDATE works SET state='paused' WHERE id=? AND state!='cancelled'").run(row.work_id);
    });
  }
  createTask(agentId: string, workId: string, target: Target, title: string, parentId?: string): string {
    targetSchema.parse(target); z.string().min(1).max(500).parse(title); this.messages.requireAccess(agentId, target.channel);
    return this.store.atomic(() => {
      this.active(workId);
      if (parentId) { const parent = this.task(parentId); if (parent.work_id !== workId || parent.owner !== agentId || !['doing','waiting','review'].includes(parent.status)) throw new Error('Invalid parent task'); }
      const id = randomUUID();
      this.store.db.prepare("INSERT INTO tasks(id,work_id,parent_id,target,title,status) VALUES(?,?,?,?,?,'todo')").run(id, workId, parentId ?? null, encode(target), title);
      this.event(id, { action: 'create', agentId }); return id;
    });
  }
  claim(agentId: string, id: string): Task {
    return this.store.atomic(() => {
      const task = this.task(id); this.active(task.work_id); this.messages.requireAccess(agentId, (JSON.parse(task.target) as Target).channel);
      if (this.store.db.prepare("UPDATE tasks SET owner=?,status='doing',version=version+1 WHERE id=? AND owner IS NULL AND status='todo' AND (assigned_to IS NULL OR assigned_to=?)").run(agentId, id, agentId).changes !== 1) throw new Error('Task already claimed or unavailable');
      this.event(id, { action: 'claim', agentId }); return this.task(id);
    });
  }
  private owned(agentId: string, id: string): Task {
    const task = this.task(id); this.active(task.work_id); this.messages.requireAccess(agentId, JSON.parse(task.target).channel);
    if (task.owner !== agentId || ['done','cancelled','failed','draft'].includes(task.status)) throw new Error('Task not owned or terminal'); return task;
  }
  delegate(agentId: string, parentId: string, peerId: string, title: string): string {
    return this.store.atomic(() => {
      const parent = this.owned(agentId, parentId), target = JSON.parse(parent.target) as Target;
      const peer = this.messages.agent(peerId); if (peerId === agentId) throw new Error('Cannot delegate to self');
      this.messages.requireAccess(peerId, target.channel);
      const id = this.createTask(agentId, parent.work_id, target, title, parentId);
      const outputId = this.send(agentId, parent.work_id, target, `<@${peer.slackUserId}> ${title}\nMate task: ${id}`);
      this.store.db.prepare("UPDATE tasks SET status='draft',assigned_to=?,outbox_id=? WHERE id=?").run(peerId, outputId, id);
      return id;
    });
  }
  /** Idempotent poll: activate only after a durable visible send receipt. */
  activateDelegations(): void {
    this.store.atomic(() => {
      const tasks = this.store.db.prepare("SELECT t.* FROM tasks t JOIN outbox o ON o.id=t.outbox_id JOIN works w ON w.id=t.work_id WHERE t.status='draft' AND o.state='sent' AND w.state='active'").all() as Task[];
      for (const task of tasks) {
        this.store.db.prepare("UPDATE tasks SET status='todo',version=version+1 WHERE id=?").run(task.id);
        this.enqueue(task.assigned_to!, task.work_id, `delegate:${task.id}`, { kind: 'delegation', taskId: task.id, target: JSON.parse(task.target), receivedAt: Date.now() });
        this.event(task.id, { action: 'visible_delegation' });
      }
      const failed = this.store.db.prepare("SELECT t.* FROM tasks t JOIN outbox o ON o.id=t.outbox_id JOIN works w ON w.id=t.work_id WHERE t.status='draft' AND o.state='failed' AND w.state='active'").all() as Task[];
      for (const task of failed) {
        this.store.db.prepare("UPDATE tasks SET status='failed',result='Delegation delivery failed',version=version+1 WHERE id=?").run(task.id);
        this.event(task.id, { action: 'delegation_failed' }); this.wakeDependents(this.task(task.id));
      }
    });
  }
  private wakeDependents(task: Task): void {
    const waiters = this.store.db.prepare("SELECT * FROM tasks WHERE waiting_on=? AND status='waiting'").all(task.id) as Task[];
    for (const waiter of waiters) {
      this.store.db.prepare("UPDATE tasks SET status='doing',waiting_on=NULL,version=version+1 WHERE id=?").run(waiter.id);
      this.enqueue(waiter.owner!, task.work_id, `dependency:${waiter.id}:${task.id}:${task.version}`, { kind: 'dependency', taskId: waiter.id, dependencyId: task.id, target: JSON.parse(waiter.target) });
    }
  }
  wait(agentId: string, taskId: string, dependencyId: string): void {
    this.store.atomic(() => {
      const task = this.owned(agentId, taskId), dependency = this.task(dependencyId);
      if (dependency.work_id !== task.work_id || taskId === dependencyId) throw new Error('Invalid dependency');
      const queue = [dependency.id], visited = new Set<string>();
      while (queue.length) {
        const current = queue.pop()!;
        if (current === taskId) throw new Error('Dependency cycle');
        if (visited.has(current)) continue; visited.add(current);
        const node = this.task(current); if (node.waiting_on) queue.push(node.waiting_on);
        const children = this.store.db.prepare("SELECT id FROM tasks WHERE parent_id=? AND status NOT IN ('done','cancelled','failed')").all(current) as { id: string }[];
        queue.push(...children.map(c => c.id));
      }
      if (['done','cancelled','failed'].includes(dependency.status)) {
        this.enqueue(agentId, task.work_id, `dependency:${taskId}:${dependencyId}:${dependency.version}`, { kind: 'dependency', taskId, dependencyId, target: JSON.parse(task.target) }); return;
      }
      this.store.db.prepare("UPDATE tasks SET status='waiting',waiting_on=?,version=version+1 WHERE id=?").run(dependencyId, taskId);
      this.event(taskId, { action: 'wait', dependencyId });
    });
  }
  update(agentId: string, id: string, status: 'doing' | 'review' | 'done' | 'cancelled' | 'failed', result?: string): void {
    this.store.atomic(() => {
      let task = this.task(id);
      if (task.status === 'draft' && status === 'cancelled' && task.parent_id && this.owned(agentId, task.parent_id).work_id === task.work_id) {
        const output = task.outbox_id ? this.store.output(task.outbox_id) : undefined;
        if (output?.state === 'pending') this.store.transitionOutput(output.id, 'pending', 'failed', { reason: 'delegation_cancelled' });
      } else task = this.owned(agentId, id);
      if ((status === 'done' || status === 'review') && !result?.trim()) throw new Error('Evidence/result required');
      if (status === 'done' && this.store.db.prepare("SELECT 1 FROM tasks WHERE parent_id=? AND status NOT IN ('done','cancelled','failed')").get(id)) throw new Error('Unfinished child tasks');
      this.store.db.prepare('UPDATE tasks SET status=?,result=?,waiting_on=NULL,version=version+1 WHERE id=?').run(status, result ?? task.result, id);
      this.event(id, { action: status, result });
      if (['done','cancelled','failed'].includes(status)) {
        this.store.db.prepare('UPDATE schedules SET active=0 WHERE task_id=?').run(id);
        this.wakeDependents(this.task(id));
      }
    });
  }
  schedule(agentId: string, workId: string, target: Target, nextAt: number, timezone: string, cron?: string, taskId?: string): string {
    this.active(workId); this.messages.requireAccess(agentId, target.channel); targetSchema.parse(target);
    z.number().int().nonnegative().safe().parse(nextAt); new Intl.DateTimeFormat('en', { timeZone: timezone });
    if (cron) CronExpressionParser.parse(cron, { currentDate: nextAt, tz: timezone }).next();
    if (taskId && this.owned(agentId, taskId).work_id !== workId) throw new Error('Schedule task work mismatch');
    const id = randomUUID();
    this.store.db.prepare('INSERT INTO schedules(id,agent_id,work_id,task_id,target,next_at,cron,timezone) VALUES(?,?,?,?,?,?,?,?)').run(id, agentId, workId, taskId ?? null, encode(target), nextAt, cron ?? null, timezone); return id;
  }
  cancelSchedule(agentId: string, id: string): void {
    if (this.store.db.prepare('UPDATE schedules SET active=0 WHERE id=? AND agent_id=?').run(id, agentId).changes !== 1) throw new Error('Unknown owned schedule');
  }
  reschedule(agentId: string, id: string, nextAt: number): void {
    z.number().int().nonnegative().safe().parse(nextAt);
    this.store.atomic(() => {
      const schedule = this.schedules(agentId).find(s => s.id === id); if (!schedule) throw new Error('Unknown owned schedule');
      this.active(schedule.work_id); if (schedule.task_id) this.owned(agentId, schedule.task_id);
      this.store.db.prepare('UPDATE schedules SET next_at=?,active=1 WHERE id=?').run(nextAt, id);
    });
  }
  schedules(agentId: string): Schedule[] { return this.store.db.prepare('SELECT * FROM schedules WHERE agent_id=?').all(agentId) as Schedule[]; }
  tick(now = Date.now()): void {
    this.store.atomic(() => {
      const schedules = this.store.db.prepare("SELECT s.* FROM schedules s JOIN works w ON w.id=s.work_id WHERE s.active=1 AND s.next_at<=? AND w.state='active'").all(now) as Schedule[];
      for (const s of schedules) {
        this.enqueue(s.agent_id, s.work_id, `schedule:${s.id}:${s.next_at}`, { kind: 'schedule', scheduleId: s.id, taskId: s.task_id, dueAt: s.next_at, target: JSON.parse(s.target), receivedAt: now });
        if (s.cron) this.store.db.prepare('UPDATE schedules SET next_at=? WHERE id=?').run(CronExpressionParser.parse(s.cron, { currentDate: now, tz: s.timezone }).next().getTime(), s.id);
        else this.store.db.prepare('UPDATE schedules SET active=0 WHERE id=?').run(s.id);
      }
    });
  }
  /** Returns affected run IDs for the supervisor's independent abort channel. */
  control(ownerId: string, workId: string, operation: 'pause' | 'resume' | 'cancel'): string[] {
    if (!this.config.ownerUserIds.includes(ownerId)) throw new Error('Owner only');
    return this.store.atomic(() => {
      const work = this.work(workId); if (work.state === 'cancelled') throw new Error('Cancelled work cannot resume');
      const runs = this.store.db.prepare("SELECT r.id,r.agent_id FROM runs r LEFT JOIN run_context rc ON rc.run_id=r.id JOIN delivery_work dw ON dw.delivery_id=r.delivery_id WHERE COALESCE(rc.work_id,dw.work_id)=? AND r.state='active'").all(workId) as { id: string; agent_id: string }[];
      this.store.db.prepare('UPDATE works SET state=? WHERE id=?').run(operation === 'resume' ? 'active' : operation === 'pause' ? 'paused' : 'cancelled', workId);
      if (operation !== 'resume') {
        for (const run of runs) {
          this.store.db.prepare('UPDATE agents SET generation=generation+1 WHERE id=?').run(run.agent_id);
          this.store.db.prepare("UPDATE runs SET state='interrupted' WHERE id=?").run(run.id);
          this.store.db.prepare("UPDATE actions SET state='unknown' WHERE run_id=? AND state='executing'").run(run.id);
        }
      }
      if (operation === 'cancel') {
        this.store.db.prepare('UPDATE schedules SET active=0 WHERE work_id=?').run(workId);
        this.store.db.prepare("UPDATE tasks SET status='cancelled',version=version+1 WHERE work_id=? AND status NOT IN ('done','cancelled','failed')").run(workId);
      }
      this.store.audit('work_control', { ownerId, workId, operation }); return runs.map(r => r.id);
    });
  }
}
