import { z } from 'zod';
import type { MateConfig } from '../config.js';
import type { Store, RunToken } from '../storage/store.js';
export interface Account { agent_id: string; max_runs: number; max_tokens: number; max_cost: number; runs: number; tokens: number; cost: number }
/** Persistent finite account. Only config seeds it; only the owner changes limits. */
export class BudgetLedger {
  constructor(readonly store: Store, readonly config: MateConfig) {}
  account(actor: string): Account {
    if (!this.config.agents.some(a=>a.id===actor)) throw new Error('Unknown Agent');
    return this.store.atomic(()=>{
      const old=this.store.db.prepare('SELECT * FROM budget_accounts WHERE agent_id=?').get(actor) as Account|undefined;
      if(old) return old;
      // Legacy accounting lacks per-run actual usage. Conservatively retain all usage of
      // each shared work this actor touched. Never forgive uncertain historical debt.
      const usage=this.store.db.prepare('SELECT COALESCE(SUM(runs),0) runs,COALESCE(SUM(tokens),0) tokens,COALESCE(SUM(cost),0) cost FROM works WHERE id IN (SELECT wr.work_id FROM work_runs wr JOIN runs r ON r.id=wr.run_id WHERE r.agent_id=?)').get(actor) as {runs:number;tokens:number;cost:number};
      const b=this.config.budgets;
      this.store.db.prepare('INSERT INTO budget_accounts VALUES(?,?,?,?,?,?,?)').run(actor,b.maxRuns,b.maxTokens,b.maxCostUsd,usage.runs,usage.tokens,usage.cost);
      this.store.db.prepare('INSERT INTO budget_runs SELECT wr.run_id,r.agent_id,wr.token_cap,wr.cost_cap,wr.settled FROM work_runs wr JOIN runs r ON r.id=wr.run_id WHERE r.agent_id=?').run(actor);
      this.store.audit('budget_account_initialized',{actor,limits:b,legacyConservativeUsage:usage});
      return this.account(actor);
    });
  }
  reserve(run:RunToken,tokens:number,cost:number):void {
    z.number().int().positive().parse(tokens);z.number().finite().nonnegative().parse(cost);
    this.store.atomic(()=>{
      this.store.assertRun(run);const a=this.account(run.agentId);
      if(a.runs+1>a.max_runs||a.tokens+tokens>a.max_tokens||a.cost+cost>a.max_cost) throw new Error('Agent budget exhausted');
      this.store.db.prepare('INSERT INTO budget_runs(run_id,agent_id,token_cap,cost_cap) VALUES(?,?,?,?)').run(run.id,run.agentId,tokens,cost);
      this.store.db.prepare('UPDATE budget_accounts SET runs=runs+1,tokens=tokens+?,cost=cost+? WHERE agent_id=?').run(tokens,cost,run.agentId);
    });
  }
  settle(runId:string,tokens:number,cost:number):void {
    this.store.atomic(()=>{
      const r=this.store.db.prepare('SELECT * FROM budget_runs WHERE run_id=? AND settled=0').get(runId) as {agent_id:string;token_cap:number;cost_cap:number}|undefined;
      if(!r)return;
      this.store.db.prepare('UPDATE budget_accounts SET tokens=tokens+?,cost=MAX(0,cost+?) WHERE agent_id=?').run(tokens-r.token_cap,cost-r.cost_cap,r.agent_id);
      this.store.db.prepare('UPDATE budget_runs SET settled=1 WHERE run_id=?').run(runId);
    });
  }
  setLimits(owner:string,actor:string,runs:number,tokens:number,cost:number):void {
    if(!this.config.ownerUserIds.includes(owner))throw new Error('Owner only');
    z.number().int().positive().parse(runs);z.number().int().positive().parse(tokens);z.number().finite().positive().parse(cost);
    const a=this.account(actor);if(runs<a.runs||tokens<a.tokens||cost<a.cost)throw new Error('Budget below usage');
    this.store.db.prepare('UPDATE budget_accounts SET max_runs=?,max_tokens=?,max_cost=? WHERE agent_id=?').run(runs,tokens,cost,actor);
    this.store.audit('owner_agent_budget',{owner,actor,runs,tokens,cost});
  }
}
