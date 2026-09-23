import {isAbsolute} from 'node:path';
import {z} from 'zod';
import {encode,hash,type RunToken,type Store} from '../storage/store.js';
import type {Collaboration} from '../collaboration/service.js';

export const systemCommandSchema=z.object({program:z.string().min(1).max(4096).refine(isAbsolute),args:z.array(z.string().max(4096)).max(100),cwd:z.string().min(1).max(4096).refine(isAbsolute)}).strict().refine(command=>encode(command).length<=2400,'System request exceeds approval UI capacity');
export const mutableSystemInputsWarning='Scripts, packages, plugins and dependencies invoked by this command may change before execution; approval does not freeze their contents.';
export type SystemCommand=z.infer<typeof systemCommandSchema>;
export interface PrivilegedExecutor {execute(command:SystemCommand,signal?:AbortSignal):Promise<{code:number;stdout:string;stderr:string;truncated:boolean}>}
export type SystemStatus='pending'|'approved'|'rejected'|'expired'|'executing'|'succeeded'|'failed'|'unknown';
export interface SystemRequest {id:string;agentId:string;workId:string;command:SystemCommand;expires:number;status:SystemStatus;decisionBy:string|null;receipt:unknown;warning:string}
interface RequestRow {id:string;agent_id:string;work_id:string;request_hash:string;request:string;expires:number;status:SystemStatus;decision_by:string|null;receipt:string|null;notice_state:string}

/** The only privileged-command broker. No Agent Linux account receives permanent root privileges. */
export class SystemOperations {
  private dispatching=false;
  constructor(readonly store:Store,readonly collaboration:Collaboration,readonly eligible:readonly string[],readonly executor:PrivilegedExecutor,readonly clock:()=>number=Date.now){}
  private row(id:string):RequestRow|undefined{return this.store.db.prepare('SELECT * FROM system_requests WHERE id=?').get(id) as RequestRow|undefined;}
  private view(row:RequestRow):SystemRequest{return{id:row.id,agentId:row.agent_id,workId:row.work_id,command:JSON.parse(row.request) as SystemCommand,expires:row.expires,status:row.status,decisionBy:row.decision_by,receipt:row.receipt?{...JSON.parse(row.receipt),warning:mutableSystemInputsWarning}:null,warning:mutableSystemInputsWarning};}
  private expireOne(row:RequestRow,at=this.clock()):RequestRow{
    if(row.status==='pending'||row.status==='approved')if(row.expires<=at){this.store.db.prepare("UPDATE system_requests SET status='expired',receipt=? WHERE id=? AND status IN ('pending','approved')").run(encode({reason:'approval_expired'}),row.id);return this.row(row.id)!;}
    return row;
  }
  request(run:RunToken,workId:string,id:string,input:unknown):SystemRequest{
    const command=systemCommandSchema.parse(input),body=encode(command);
    return this.store.atomic(()=>{
      this.store.assertRun(run);this.collaboration.assertActionWork(run,workId);
      if(this.collaboration.seats.active(run.agentId))throw new Error('Independent review seat cannot request system operations');
      if(!this.eligible.includes(run.agentId))throw new Error('Agent is not authorized for system operations');
      const old=this.row(id);
      if(old){if(old.agent_id!==run.agentId||old.work_id!==workId||old.request_hash!==hash(body))throw new Error('System request identity conflict');return this.view(this.expireOne(old));}
      const expires=this.clock()+600000;
      this.store.db.prepare("INSERT INTO system_requests(id,agent_id,work_id,request_hash,request,expires,status) VALUES(?,?,?,?,?,?,'pending')").run(id,run.agentId,workId,hash(body),body,expires);
      this.store.audit('system_request',{id,agentId:run.agentId,workId,expires});return this.view(this.row(id)!);
    });
  }
  status(agentId:string,id:string):SystemRequest{
    const row=this.row(id);if(!row||row.agent_id!==agentId)throw new Error('Unknown own system request');
    return this.store.atomic(()=>this.view(this.expireOne(row)));
  }
  pending():SystemRequest[]{
    this.expire();return(this.store.db.prepare("SELECT * FROM system_requests WHERE status='pending' ORDER BY rowid").all() as RequestRow[]).map(row=>this.view(row));
  }
  pendingNotices():SystemRequest[]{
    this.expire();return(this.store.db.prepare("SELECT * FROM system_requests WHERE status='pending' AND notice_state='pending' ORDER BY rowid LIMIT 20").all() as RequestRow[]).map(row=>this.view(row));
  }
  claimNotice(id:string):boolean{return this.store.db.prepare("UPDATE system_requests SET notice_state='sending' WHERE id=? AND status='pending' AND notice_state='pending'").run(id).changes===1;}
  settleNotice(id:string,state:'sent'|'unknown'):void{this.store.atomic(()=>{
    const row=this.row(id);if(!row||row.notice_state!=='sending')return;
    if(state==='sent'){this.store.db.prepare("UPDATE system_requests SET notice_state='sent' WHERE id=? AND notice_state='sending'").run(id);return;}
    this.failNotice(row);
  });}
  private failNotice(row:RequestRow):void{
    this.store.db.prepare("UPDATE system_requests SET notice_state='unknown',status='failed',receipt=? WHERE id=? AND status='pending' AND notice_state='sending'").run(encode({reason:'approval_notice_outcome_unknown; request again with a new ID'}),row.id);
    this.wake(row.agent_id,row.work_id,row.id,'failed');
  }
  decide(owner:string,id:string,decision:'approve'|'reject'):SystemRequest{
    if(!this.collaboration.config.ownerUserIds.includes(owner))throw new Error('Owner only');
    return this.store.atomic(()=>{
      const row=this.row(id);if(!row)throw new Error('Unknown system request');const current=this.expireOne(row);
      if(current.status==='approved'&&decision==='approve')return this.view(current);
      if(current.status!=='pending')throw new Error('System request already decided');
      const status=decision==='approve'?'approved':'rejected';
      this.store.db.prepare("UPDATE system_requests SET status=?,decision_by=?,receipt=?,notice_state='sent' WHERE id=? AND status='pending'").run(status,owner,decision==='reject'?encode({reason:'approval_rejected'}):null,id);
      this.store.audit('system_decision',{id,owner,status});
      if(status==='rejected')this.wake(current.agent_id,current.work_id,id,status);
      return this.view(this.row(id)!);
    });
  }
  expire(at=this.clock()):void{
    this.store.atomic(()=>{const rows=this.store.db.prepare("SELECT * FROM system_requests WHERE status IN ('pending','approved') AND expires<=?").all(at) as RequestRow[];
      for(const row of rows){this.expireOne(row,at);this.wake(row.agent_id,row.work_id,row.id,'expired');}
    });
  }
  recover():void{
    this.store.atomic(()=>{const running=this.store.db.prepare("SELECT * FROM system_requests WHERE status='executing'").all() as RequestRow[];
      for(const row of running){this.store.db.prepare("UPDATE system_requests SET status='unknown',receipt=? WHERE id=? AND status='executing'").run(encode({reason:'interrupted_after_execution_boundary'}),row.id);this.wake(row.agent_id,row.work_id,row.id,'unknown');}
      for(const row of this.store.db.prepare("SELECT * FROM system_requests WHERE notice_state='sending' AND status='pending'").all() as RequestRow[])this.failNotice(row);
    });this.expire();
  }
  async dispatchApproved():Promise<void>{
    if(this.dispatching)return;this.dispatching=true;
    try{this.expire();for(const row of this.store.db.prepare("SELECT * FROM system_requests WHERE status='approved' ORDER BY rowid").all() as RequestRow[]){
      const claimed=this.store.atomic(()=>{const current=this.expireOne(this.row(row.id)!);if(current.status!=='approved')return false;
        if(!this.eligible.includes(current.agent_id)||this.collaboration.seats.active(current.agent_id)){
          this.store.db.prepare("UPDATE system_requests SET status='failed',receipt=? WHERE id=? AND status='approved'").run(encode({reason:'system_eligibility_unavailable'}),row.id);
          this.wake(current.agent_id,current.work_id,row.id,'failed');return false;
        }
        this.store.db.prepare("UPDATE system_requests SET status='executing' WHERE id=? AND status='approved'").run(row.id);return true;});
      if(!claimed)continue;
      try{const result=await this.executor.execute(JSON.parse(row.request) as SystemCommand);
        this.store.atomic(()=>{this.store.db.prepare("UPDATE system_requests SET status=?,receipt=? WHERE id=? AND status='executing'").run(result.code===0?'succeeded':'failed',encode(result),row.id);this.wake(row.agent_id,row.work_id,row.id,result.code===0?'succeeded':'failed');});
      }catch(error){this.store.atomic(()=>{this.store.db.prepare("UPDATE system_requests SET status='unknown',receipt=? WHERE id=? AND status='executing'").run(encode({reason:'privileged_execution_outcome_unknown',detail:String(error)}),row.id);this.wake(row.agent_id,row.work_id,row.id,'unknown');});}
    }}finally{this.dispatching=false;}
  }
  private wake(agentId:string,workId:string,id:string,status:SystemStatus):void{
    try{this.collaboration.enqueue(agentId,workId,`system:${id}:${status}`,{kind:'system_operation',requestId:id,status});}catch{/* An inactive work does not authorize resurrection; status remains readable. */}
  }
}
