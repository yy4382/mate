import type { Collaboration } from '../collaboration/service.js';
import type { Supervisor } from '../runtime/supervisor.js';
import type { Broker } from '../policy/broker.js';
import { encode } from '../storage/store.js';
export class Controls {
  constructor(readonly collaboration: Collaboration, readonly supervisor: Supervisor, readonly broker: Broker) {}
  execute(user: string, text: string): string {
    const c = this.collaboration, s = c.store;
    if (!c.config.ownerUserIds.includes(user)) throw new Error('Owner only');
    const [command, id, ...rest] = text.trim().split(/\s+/);
    switch (command) {
      case 'status': return encode({ agents: s.db.prepare('SELECT id,session_id,paused,generation FROM agents').all(), activeRuns: s.db.prepare("SELECT id,agent_id FROM runs WHERE state='active'").all(), works: s.db.prepare('SELECT id,state,runs,max_runs,tokens,max_tokens,cost,max_cost FROM works ORDER BY rowid DESC LIMIT 20').all(), unknown: s.db.prepare("SELECT id,agent_id,state FROM actions WHERE state='unknown'").all(), unknownOutputs: s.db.prepare("SELECT id,agent_id FROM outbox WHERE state='unknown'").all() });
      case 'tasks': return encode(s.db.prepare('SELECT * FROM tasks ORDER BY rowid DESC LIMIT 30').all());
      case 'schedules': return encode(s.db.prepare('SELECT * FROM schedules WHERE active=1').all());
      case 'stop': case 'pause': case 'cancel': case 'resume': {
        if (!id) throw new Error('Work ID required');
        this.supervisor.stopRuns(c.control(user, id, command === 'stop' ? 'pause' : command)); return `${id}: ${c.work(id).state}`;
      }
      case 'agent-stop': if (!id) throw new Error('Agent ID required'); this.supervisor.stopAgent(id); return `Agent ${id} paused`;
      case 'agent-resume': if (!id) throw new Error('Agent ID required'); c.messages.agent(id); s.resume(id); return `Agent ${id} resumed`;
      case 'revoke': if (!id) throw new Error('Grant ID required'); this.broker.revoke(user, id); for (const row of s.db.prepare("SELECT DISTINCT agent_id FROM actions WHERE state='executing' AND json_extract(request,'$.grantId')=?").all(id) as { agent_id: string }[]) this.supervisor.stopAgent(row.agent_id); return `Grant ${id} revoked`;
      case 'budget': {
        const [runs, tokens, dollars] = rest.map(Number); if (!id || !Number.isInteger(runs) || runs! < 1 || !Number.isInteger(tokens) || tokens! < 1 || !Number.isFinite(dollars) || dollars! <= 0) throw new Error('budget WORK_ID MAX_RUNS MAX_TOKENS MAX_USD');
        const work = c.work(id); if (work.state === 'cancelled' || runs! < work.runs || tokens! < work.tokens || dollars! < work.cost) throw new Error('Budget below usage or cancelled work');
        s.db.prepare('UPDATE works SET max_runs=?,max_tokens=?,max_cost=? WHERE id=?').run(runs!, tokens!, dollars!, id); s.audit('owner_budget', { user, id, runs, tokens, dollars }); return `Budget updated for ${id}; resume separately if paused`;
      }
      default: return 'Commands: status; tasks; schedules; stop|resume|cancel WORK_ID; agent-stop|agent-resume AGENT_ID; revoke GRANT_ID; budget WORK_ID MAX_RUNS MAX_TOKENS MAX_USD';
    }
  }
}
