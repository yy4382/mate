import type {ActivityItem,OperationsStatus} from './view.js';

export type RecoveryState={upgrade:null|{phase:string;everActivated:boolean};root:null|{step:string;mode:string};restore:null|{phase:string;databaseComplete:boolean;completedAgents:number};invalid:boolean};
export type ServiceState='active'|'inactive'|'activating'|'deactivating'|'failed'|'reloading'|'unknown';
const phases=['preparing','candidate','rollback','activated','fix-forward'];
const steps=['prepared','checkpoint','journal','release','migrated','config','current','checked','rollback-checkpoint','rollback','restored','old-config','old-current','activated','finalizing'];
/** An allowlist projection, never a regex scrub of potentially confidential strings. */
export function diagnosticStatus(operations:OperationsStatus|null,service:ServiceState,recovery:RecoveryState){
 const invalid=recovery.invalid||!!(recovery.upgrade&&!phases.includes(recovery.upgrade.phase))||!!(recovery.root&&(!steps.includes(recovery.root.step)||!['candidate','fix-forward'].includes(recovery.root.mode)))||!!(recovery.restore&&!['planned','decided'].includes(recovery.restore.phase));
 const pending=!!(recovery.upgrade||recovery.root||recovery.restore);
 return {service,health:invalid?'recovery-unreadable':pending?'recovery-pending':service!=='active'?'service-not-active':!operations?'operations-unavailable':operations.agents.some(a=>!a.registered||a.paused)||operations.uncertainActions.atLeast>0||operations.uncertainOutputs.atLeast>0?'attention-required':'running',
  recovery:invalid?{invalid:true}:{upgrade:recovery.upgrade?{phase:recovery.upgrade.phase,everActivated:recovery.upgrade.everActivated}:null,root:recovery.root?{step:recovery.root.step,mode:recovery.root.mode}:null,restore:recovery.restore?{phase:recovery.restore.phase,databaseComplete:recovery.restore.databaseComplete,completedAgents:recovery.restore.completedAgents}:null},
  operations:operations?{agents:operations.agents.length,unregisteredAgents:operations.agents.filter(a=>!a.registered).length,pausedAgents:operations.agents.filter(a=>a.paused).length,activeRuns:operations.agents.filter(a=>a.activeRun).length,
   uncertainActions:operations.uncertainActions.atLeast,uncertainOutputs:operations.uncertainOutputs.atLeast,heldDrafts:operations.heldDrafts.atLeast,dueReminders:operations.dueReminders.atLeast,
   countsTruncated:[operations.uncertainActions,operations.uncertainOutputs,operations.heldDrafts,operations.dueReminders].some(p=>p.truncated)}:null};
}
export const diagnosticLogLimit=100;
export const diagnosticLogWindowMs=24*60*60*1000;
/** Only runtime facts have a closed operational vocabulary. IDs, actor names and payloads never leave this boundary. */
export function diagnosticLogs(items:readonly ActivityItem[],now=Date.now()){
 const kinds=['runtime.run_completed','runtime.run_failed','runtime.run_interrupted','internal_dm.internal_dm_created'];
 const eligible=items.filter(i=>['runtime','internal_dm'].includes(i.source)&&kinds.includes(i.kind)&&Number.isSafeInteger(i.at)&&i.at>=now-diagnosticLogWindowMs&&i.at<=now);
 return {since:now-diagnosticLogWindowMs,until:now,limit:diagnosticLogLimit,events:eligible.slice(0,diagnosticLogLimit).map(i=>({at:i.at,event:i.kind})),content:'structured-operational-events-only' as const};
}
