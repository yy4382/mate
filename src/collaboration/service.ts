import {Reminders,type Reminder}from '../reminders/service.js';
import type { SendBasis } from '../slack/freshness.js';
import { ReviewSeats } from '../slack/review-seats.js';
import { Attention } from '../slack/attention.js';
import { BudgetLedger } from '../budget/ledger.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, encode, type RunToken } from '../storage/store.js';
import { Messages, Output, targetSchema, type Target } from '../slack/messages.js';
import type { MateConfig } from '../config.js';

export interface Work { id: string; target: string; state: string; max_runs: number; max_tokens: number; max_cost: number; runs: number; tokens: number; cost: number }
export interface Task { legacy:number; message_key:string|null; id: string; work_id: string; parent_id: string | null; target: string; title: string; owner: string | null; assigned_to: string | null; status: string; version: number; waiting_on: string | null; result: string | null; outbox_id: string | null }
export class Collaboration {
  readonly reminders:Reminders;
  readonly seats: ReviewSeats;
  readonly ledger: BudgetLedger;
  readonly attention: Attention;
  constructor(readonly store: Store, readonly messages: Messages, readonly output: Output, readonly config: MateConfig) { this.reminders=new Reminders(this); this.ledger = new BudgetLedger(store, config); this.attention = new Attention(messages); this.seats = new ReviewSeats(messages); }
  work(id: string): Work { const work = this.store.db.prepare('SELECT * FROM works WHERE id=?').get(id) as Work | undefined; if (!work) throw new Error('Unknown work'); return work; }
  task(id: string): Task { const task = this.store.db.prepare("SELECT *, (message_key IS NULL AND status!='draft') legacy FROM tasks WHERE id=?").get(id) as Task | undefined; if (!task) throw new Error('Unknown task'); return task; }
  list(agentId: string): Task[] {
    this.messages.agent(agentId);
    if(this.messages.isolated(agentId))return [];
    return this.store.db.prepare("SELECT t.*, (t.message_key IS NULL AND t.status!='draft') legacy FROM tasks t JOIN channel_access a ON a.channel=json_extract(t.target,'$.channel') WHERE a.agent_id=? AND a.active=1 ORDER BY t.rowid DESC LIMIT 100").all(agentId) as Task[];
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
  active(workId: string): Work { const work = this.work(workId); if (work.state !== 'active') throw new Error('Work paused or cancelled'); return work; }
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
  send(agentId: string, workId: string, target: Target, text: string, id: string = randomUUID(), basis?:SendBasis): string {
    return this.store.atomic(() => {
      this.active(workId); this.output.queue(agentId, target, text, id, basis);
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
  delegate(agentId: string, parentId: string, peerId: string, title: string, basis?:SendBasis): string {
    return this.store.atomic(() => {
      const parent = this.owned(agentId, parentId), target = JSON.parse(parent.target) as Target;
      const peer = this.messages.agent(peerId); if (peerId === agentId) throw new Error('Cannot delegate to self');
      this.messages.requireAccess(peerId, target.channel);
      const id = this.createTask(agentId, parent.work_id, target, title, parentId);
      const outputId = this.send(agentId, parent.work_id, target, `<@${peer.slackUserId}> ${title}\nMate task: ${id}`, undefined, basis);
      this.store.db.prepare("UPDATE tasks SET status='draft',assigned_to=?,outbox_id=? WHERE id=?").run(peerId, outputId, id);
      return id;
    });
  }
  /** Idempotent poll: activate only after a durable visible send receipt. */
  activateDelegations(): void {
    this.store.atomic(() => {
      const tasks = this.store.db.prepare("SELECT t.* FROM tasks t JOIN outbox o ON o.id=t.outbox_id JOIN works w ON w.id=t.work_id WHERE t.status='draft' AND o.state='sent' AND w.state='active'").all() as Task[];
      for (const task of tasks) {
        const receipt=JSON.parse(this.store.output(task.outbox_id!)!.receipt!) as {ts:string};
        const key=encode([this.config.teamId,JSON.parse(task.target).channel,receipt.ts]);
        this.store.db.prepare("UPDATE tasks SET status='todo',message_key=? WHERE id=?").run(key,task.id);
        this.enqueue(task.assigned_to??this.store.output(task.outbox_id!)!.agent_id, task.work_id, `delegate:${task.id}`, { kind: 'delegation', taskId: task.id, target: JSON.parse(task.target), receivedAt: Date.now() });
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
      const delivery=this.store.enqueue(waiter.owner!, `dependency:${waiter.id}:${task.id}:${task.version}`, { kind: 'dependency', taskId: waiter.id, dependencyId: task.id, target: JSON.parse(waiter.target) },50);
      this.bindDelivery(delivery,waiter.work_id);
    }
  }
  wait(agentId: string, taskId: string, dependencyId: string): void {
    this.store.atomic(() => {
      const task = this.owned(agentId, taskId), dependency = this.task(dependencyId);
      this.messages.requireAccess(agentId,JSON.parse(dependency.target).channel);
      if (taskId === dependencyId) throw new Error('Invalid dependency');
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
        if(task.status==='waiting'){this.store.db.prepare("UPDATE tasks SET status='doing',waiting_on=NULL,version=version+1 WHERE id=?").run(task.id);this.event(task.id,{action:'dependency_already_terminal',dependencyId});}
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
        this.wakeDependents(this.task(id));
      }
    });
  }
  schedule(agentId:string,workId:string,target:Target,nextAt:number,timezone:string,cron?:string,taskId?:string):string{return this.reminders.create(agentId,workId,{target,nextAt,timezone,cron,taskId,content:'Follow up on the referenced conversation or task.'}).id;}
  cancelSchedule(agentId:string,id:string):void{const r=this.reminders.read(agentId,id);this.reminders.cancel(agentId,id,r.version);}
  reschedule(agentId:string,id:string,nextAt:number):void{const r=this.reminders.read(agentId,id);this.reminders.edit(agentId,id,r.version,{target:JSON.parse(r.target),content:r.content,nextAt,timezone:r.timezone,cron:r.cron??undefined,taskId:r.task_id??undefined,anchor:r.anchor?JSON.parse(r.anchor):undefined});}
  schedules(agentId:string):Reminder[]{return this.reminders.list(agentId);}
  tick(now = Date.now()): void {
    this.store.atomic(() => {
      const deferred=this.store.db.prepare('SELECT agent_id,target,deferred_until,muted FROM attention_state WHERE deferred_until>0 AND deferred_until<=?').all(now) as {agent_id:string;target:string;deferred_until:number;muted:number}[];
      for(const item of deferred){
        const target=JSON.parse(item.target) as Target;
        this.store.db.prepare('UPDATE attention_state SET deferred_until=0 WHERE agent_id=? AND target=?').run(item.agent_id,item.target);
        const channelMuted=this.store.db.prepare('SELECT 1 FROM attention_state WHERE agent_id=? AND target=? AND muted=1').get(item.agent_id,encode({channel:target.channel}));
        if(item.muted || channelMuted || !this.messages.access(item.agent_id,target.channel))continue;
        const work=this.createWork(`attention:${item.agent_id}:${item.target}`,target);
        if(this.work(work).state==='active')this.enqueue(item.agent_id,work,`defer:${item.target}:${item.deferred_until}`,{kind:'attention_due',target});
      }
      this.reminders.tick(now);
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
        this.reminders.cancelWork(workId);
        this.store.db.prepare("UPDATE tasks SET status='cancelled',version=version+1 WHERE work_id=? AND status NOT IN ('done','cancelled','failed')").run(workId);
      }
      this.store.audit('work_control', { ownerId, workId, operation }); return runs.map(r => r.id);
    });
  }
}
