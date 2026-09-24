import type { Collaboration } from '../collaboration/service.js';
import type { Supervisor } from '../runtime/supervisor.js';
import type { Broker } from '../policy/broker.js';
import type {LinuxProcessManager} from '../execution/linux-processes.js';
import {ProcessNotRunningError} from '../execution/linux-processes.js';
import type {SystemOperations} from '../policy/system-operations.js';
export class Controls {
  constructor(readonly collaboration: Collaboration, readonly supervisor: Supervisor, readonly broker: Broker, readonly verifyReviewWorkspace: (actor:string)=>string = ()=>{throw new Error('Clean workspace verification unavailable');},readonly platformControl?:(user:string,command:string,id:string|undefined,args:string[])=>string|undefined,readonly processes?:LinuxProcessManager,readonly system?:SystemOperations) {}
  execute(user: string, text: string): unknown {
    const c = this.collaboration, s = c.store;
    if (!c.config.ownerUserIds.includes(user)) throw new Error('Owner only');
    const [command, id, ...rest] = text.trim().split(/\s+/);
    const platform=command?this.platformControl?.(user,command,id,rest):undefined;if(platform!==undefined)return platform;
    switch (command) {
      case 'status': return c.operations.status(user);
      case 'system-pending': if(!this.system)throw new Error('System approval unavailable');return this.system.pending();
      case 'system-status': {if(!id)throw new Error('System request ID required');if(!this.system)throw new Error('System approval unavailable');const result=this.system.ownerStatus(user,id),receipt=result.receipt as Record<string,unknown>|null;
        return{...result,receipt:receipt?{...receipt,...(typeof receipt.stdout==='string'?{stdout:receipt.stdout.slice(0,500),stdoutMore:receipt.stdout.length>500}:{}),...(typeof receipt.stderr==='string'?{stderr:receipt.stderr.slice(0,500),stderrMore:receipt.stderr.length>500}:{})}:null};}
      case 'system-output': if(!id||rest.length!==2||!['stdout','stderr'].includes(rest[0]!))throw new Error('system-output REQUEST_ID stdout|stderr OFFSET');if(!this.system)throw new Error('System approval unavailable');return this.system.ownerOutput(user,id,rest[0] as 'stdout'|'stderr',Number(rest[1]));
      case 'processes': if(!id)throw new Error('Agent ID required');c.messages.agent(id);if(!this.processes)throw new Error('Linux process control unavailable');return this.processes.list(id);
      case 'process-stop': if(!id||rest.length!==1)throw new Error('process-stop AGENT_ID UNIT');c.messages.agent(id);if(!this.processes)throw new Error('Linux process control unavailable');try{return this.processes.stop(id,rest[0]!);}catch(error){if(error instanceof ProcessNotRunningError)return{unit:rest[0],stopped:false,reason:'not_running'};throw error;}
      case 'activity': return c.operations.activity(user,id?JSON.parse([id,...rest].join(' ')):{});
      case 'review-seat': {
        if(!id)throw new Error('Agent ID required');const input=JSON.parse(rest.join(' '));
        c.seats.activate(user,id,input.target,input.brief,this.verifyReviewWorkspace);return `Independent review seat enabled for ${id}`;
      }
      case 'review-release': if(!id)throw new Error('Agent ID required');this.supervisor.stopAgent(id);c.seats.release(user,id);return 'Review isolation released; explicitly resume the Agent';
      case 'tasks': return c.operations.activity(user,{sources:['task']});
      case 'schedules': return c.operations.activity(user,{sources:['reminder_event','reminder_firing']});
      case 'stop': case 'pause': case 'cancel': case 'resume': {
        if (!id) throw new Error('Work ID required');
        this.supervisor.stopRuns(c.control(user, id, command === 'stop' ? 'pause' : command)); return `${id}: ${c.work(id).state}`;
      }
      case 'agent-reset': {
        if(!id || !rest.length || rest.join(' ').length>20000)throw new Error('agent-reset AGENT_ID CHECKPOINT (1–20000 characters)');
        c.messages.agent(id);this.supervisor.stopAgent(id);
        const session=this.supervisor.router.sessions.resetStopped(id,rest.join(' '));
        return `Agent ${id} context replaced (${session}); paused, explicitly agent-resume when ready`;
      }
      case 'agent-stop': if (!id) throw new Error('Agent ID required'); this.supervisor.stopAgent(id); return `Agent ${id} paused`;
      case 'agent-resume': if (!id) throw new Error('Agent ID required'); c.messages.agent(id); s.resume(id); return `Agent ${id} resumed`;
      case 'agent-budget': {
        const [runs,tokens,cost]=rest.map(Number); if(!id)throw new Error('Agent ID required');
        c.ledger.setLimits(user,id,runs!,tokens!,cost!);return `Persistent budget updated for ${id}`;
      }
      case 'budget': {
        const [runs, tokens, dollars] = rest.map(Number); if (!id || !Number.isInteger(runs) || runs! < 1 || !Number.isInteger(tokens) || tokens! < 1 || !Number.isFinite(dollars) || dollars! <= 0) throw new Error('budget WORK_ID MAX_RUNS MAX_TOKENS MAX_USD');
        const work = c.work(id); if (work.state === 'cancelled' || runs! < work.runs || tokens! < work.tokens || dollars! < work.cost) throw new Error('Budget below usage or cancelled work');
        s.db.prepare('UPDATE works SET max_runs=?,max_tokens=?,max_cost=? WHERE id=?').run(runs!, tokens!, dollars!, id); s.audit('owner_budget', { user, id, runs, tokens, dollars }); return `Budget updated for ${id}; resume separately if paused`;
      }
      default: return 'Commands: status; system-pending; system-status REQUEST_ID; system-output REQUEST_ID stdout|stderr OFFSET; processes AGENT_ID; process-stop AGENT_ID UNIT; activity [JSON]; tasks; schedules; conversations; projection-bindings; projection-add CONVERSATION_ID JSON; projections CONVERSATION_ID JSON; projection-inputs BINDING_ID JSON; projection-enable BINDING_ID true|false; projection-anchor BINDING_ID ROOT_ID; stop|resume|cancel WORK_ID; agent-stop|agent-resume AGENT_ID; agent-reset AGENT_ID CHECKPOINT; budget WORK_ID MAX_RUNS MAX_TOKENS MAX_USD; agent-budget AGENT_ID MAX_RUNS MAX_TOKENS MAX_USD';
    }
  }
}
