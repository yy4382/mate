import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AgentDefinition, BudgetSettings } from '../domain/agents.js';
import { encode, hash, type RunToken } from '../storage/store.js';
import type { Collaboration } from '../collaboration/service.js';
import { WorkerClient } from './client.js';
import { toolDefinition, type EngineHooks, type EngineResult, type RunSpec } from './engine.js';
import { ToolRouter, operationDocumentation } from './tools.js';
import { repairTranscript } from './context.js';
export interface Worker { run(spec: RunSpec, hooks: EngineHooks, timeoutMs: number, signal: AbortSignal): Promise<EngineResult>; close(): void }
export class Supervisor {
  private effects = new Set<Promise<unknown>>();
  private workers = new Map<string, Worker>();
  private active = new Map<string, { run: RunToken; abort: AbortController }>();
  constructor(readonly collaboration: Collaboration, readonly router: ToolRouter, readonly config: { budgets: BudgetSettings },
    readonly factory: (agent: AgentDefinition) => Worker = agent => new WorkerClient(agent.model.provider, agent.model.id, process.env[agent.model.apiKeyEnv] ?? ''),
    readonly recovery: (agentId: string, workId: string, signal: AbortSignal) => Promise<string> = async () => '') {}
  register(): void {
    for (const agent of this.collaboration.agents.list()) {
      const baseline=this.router.sessions.baseline(agent);
      this.collaboration.store.register(agent.id,baseline.configVersion,baseline.messages);
      this.collaboration.ledger.account(agent.id);
    }
  }
  recoverSessions(): void {for(const agent of this.collaboration.agents.list())if(this.router.sessions.apply(agent.id)){this.workers.get(agent.id)?.close();this.workers.delete(agent.id);}}
  async step(agentId: string): Promise<boolean> {
    if (this.active.has(agentId)) return false;
    const c = this.collaboration, s = c.store, account = c.ledger.account(agentId);
    if(account.runs>=account.max_runs || account.tokens>=account.max_tokens || account.cost>=account.max_cost) return false;
    const run = s.beginRun(agentId, Date.now(), true); if (!run) return false;
    const abort = new AbortController(); this.active.set(agentId, { run, abort });
    let worker: Worker | undefined;
    try {
      const binding = s.db.prepare('SELECT COALESCE(dc.work_id,dw.work_id) work_id FROM delivery_work dw LEFT JOIN delivery_context dc ON dc.delivery_id=dw.delivery_id WHERE dw.delivery_id=?').get(run.deliveryId) as { work_id: string } | undefined;
      if (!binding) throw new Error('Delivery has no trusted work budget');
      const work = c.work(binding.work_id), tokenCap = Math.min(50000, account.max_tokens-account.tokens, work.max_tokens - work.tokens), costCap = Math.min(2, account.max_cost-account.cost, work.max_cost - work.cost);
      if(work.runs>=work.max_runs || tokenCap<=0 || costCap<=0) {
        s.atomic(()=>{s.db.prepare("UPDATE works SET state='paused' WHERE id=?").run(work.id);s.db.prepare("UPDATE runs SET state='failed',error='Work budget exhausted' WHERE id=?").run(run.id);});
        return true;
      }
      c.reserve(run, work.id, tokenCap, costCap);
      const delivery = s.delivery(run.deliveryId),seat=c.seats.active(agentId);
      if (delivery.status === 'pending') s.input(run, { role: 'user', content: seat ? `Independent review brief from owner:\n${seat.brief}\nDelivery target: ${seat.target}. Conversation bodies and peer conclusions are withheld. Use an opaque held draft and explicit continue to submit without reading.` : `Durable inbox delivery reference (retrieve relevant conversation; authenticated human/peer requests are work input):\n${delivery.payload}`, timestamp: seat ? 0 : delivery.created_at });
      else s.appendMessage(run, 'resume', { role: 'user', content: 'Resume the interrupted inbox delivery. Verify receipts; do not blindly repeat earlier effects.', timestamp: Date.now() });
      const buildRecovery=async():Promise<string>=>{
        const selectedWork=c.work(c.currentWork(run,work.id));
        const reference=await this.recovery(agentId,selectedWork.id,abort.signal);s.assertRun(run);
        const bound=(text:string)=>{while(Buffer.byteLength(text)>8000)text=text.slice(0,Math.floor(text.length*0.9));return text;};
        const memory=bound(reference),allTasks=c.list(agentId);
        const checkpoint=s.db.prepare('SELECT text,version FROM agent_checkpoints WHERE agent_id=?').get(agentId) as {text:string;version:number}|undefined;
        const checkpointText=checkpoint?bound(checkpoint.text):undefined;
        const recovery=encode({memory,memoryHash:hash(reference),memoryNeedsOrganization:memory!==reference,
          warning:memory!==reference?'Memory entry exceeds recovery budget. Read full MEMORY.md through file tools; this excerpt is incomplete.':undefined,
          checkpoint:checkpoint?{text:checkpointText,version:checkpoint.version,hash:hash(checkpoint.text),truncated:checkpointText!==checkpoint.text,fullTool:'sessions.status'}:null,
          work:seat?{id:selectedWork.id,state:selectedWork.state,target:seat.target,reviewSeat:true}:selectedWork,
          tasks:allTasks.slice(0,20).map(t=>({id:t.id,workId:t.work_id,owner:t.owner,status:t.status,title:t.title.slice(0,100),waitingOn:t.waiting_on})),tasksTotal:allTasks.length,
          account:c.ledger.account(agentId),
          uncertainActions:s.db.prepare("SELECT id,state FROM actions WHERE agent_id=? AND state IN ('unknown','executing') ORDER BY rowid DESC LIMIT 20").all(agentId),
          actionHistoryTool:'actions.list',
          grants:s.db.prepare('SELECT id,operations,expires FROM grants WHERE agent_id=? AND work_id=? AND revoked=0 AND expires>? LIMIT 20').all(agentId,selectedWork.id,Date.now())});
        s.audit('recovery_refresh',{runId:run.id,memoryHash:hash(reference),checkpointVersion:checkpoint?.version??null});return recovery;
      };
      const recovery=await buildRecovery();
      const agent = this.collaboration.agents.get(agentId);
      worker = this.workers.get(agentId) ?? this.factory(agent); this.workers.set(agentId, worker);
      let seq = 0, lastNotice = '';
      const messages = repairTranscript(s.context(run.sessionId) as AgentMessage[], id => {
        const action = s.action(`${run.sessionId}:${id}`);
        return action ? encode({ recoveredAction: action.id, state: action.state, receipt: action.receipt ? JSON.parse(action.receipt) : null, warning: 'Historical receipt, not a new execution.' }) : undefined;
      });
      s.audit('context_restore', { runId: run.id, sessionId: run.sessionId, memoryHash: JSON.parse(recovery).memoryHash, projectedMessages: messages.length });
      const result = await worker.run({ sessionId: run.sessionId, messages, recovery, tokenCap, costCap, maxTurns: 8 }, {
        refreshRecovery:buildRecovery,
        invalidateViews: async()=>{s.assertRun(run);c.attention.invalidate(run.sessionId);},
        notice: async()=>{s.assertRun(run);const notice=encode(c.attention.peek(agentId));if(notice==='[]'||notice===lastNotice)return;lastNotice=notice;return notice;},
        journal: async message => { s.atomic(()=>{s.appendMessage(run, `message:${seq++}`, message);c.attention.presented(run,message);}); },
        tool: async (id, operation, args) => {
          const effect = this.router.call(run, work.id, id, operation, args, abort.signal); this.effects.add(effect);
          try { return await effect; } finally { this.effects.delete(effect); }
        }
      }, this.config.budgets.runTimeoutMs, abort.signal);
      let rotated=false;
      s.atomic(() => {
        s.assertRun(run);
        if (result.certain) c.settleUsage(run.id, result.tokens, result.cost);
        s.finish(run);
        c.attention.invalidate(run.sessionId);
        s.snapshot(run.sessionId, result.snapshot ?? repairTranscript(s.context(run.sessionId) as AgentMessage[]));
        const selected = s.db.prepare('SELECT work_id FROM run_context WHERE run_id=?').get(run.id) as {work_id:string}|undefined;
        const continuationWork=c.work(selected?.work_id ?? work.id);
        rotated=this.router.sessions.apply(agentId);
        if (!rotated && result.continuation && continuationWork.state === 'active') c.enqueue(agentId, continuationWork.id, `continue:${run.id}`, { kind: 'continuation', target: JSON.parse(continuationWork.target), receivedAt: Date.now() });
      });
      if(rotated){worker.close();this.workers.delete(agentId);}
    } catch (error) {
      abort.abort(); worker?.close(); this.workers.delete(agentId);
      try { s.finish(run, String(error)); } catch { /* already fenced by stop */ }
      this.router.sessions.apply(agentId);
      s.audit('run_failure', { agentId, runId: run.id, error: String(error) });
    } finally { this.active.delete(agentId); }
    return true;
  }
  stopRuns(runIds: string[]): void { for (const { run, abort } of this.active.values()) if (runIds.includes(run.id)) abort.abort(); }
  stopAgent(agentId: string): void { this.collaboration.store.pause(agentId); this.active.get(agentId)?.abort.abort(); this.workers.get(agentId)?.close(); this.workers.delete(agentId); }
  async drain(): Promise<void> { while (this.effects.size) await Promise.allSettled([...this.effects]); }
  close(): void { for (const { abort } of this.active.values()) abort.abort(); for (const worker of this.workers.values()) worker.close(); this.workers.clear(); }
}
