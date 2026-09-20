import { relative } from 'node:path';
import { checkedPath } from '../execution/paths.js';
import type { RunToken } from '../storage/store.js';
import { hash } from '../storage/store.js';
import type { Broker } from '../policy/broker.js';
import type { Collaboration } from '../collaboration/service.js';
import type { Target,ArtifactOutputTransport } from '../slack/messages.js';
import type { ExecutionResult } from '../execution/backend.js';
export interface PublishArgs {grantId:string;path:string;title:string;target:Target;text?:string;viewToken?:string;draftId?:string;revision?:number}
export class Artifacts {
  constructor(readonly collaboration: Collaboration, readonly broker: Broker, transport: ArtifactOutputTransport, readonly memoryRoots: Record<string, string>) {collaboration.output.artifacts=transport;}
  async publish(run: RunToken, workId: string, actionId: string, args: PublishArgs, signal: AbortSignal): Promise<unknown> {
    const c=this.collaboration,s=c.store,gate=c.output.gate;if(!gate)throw new Error('Publication gate unavailable');
    s.assertRun(run);c.assertActionWork(run,workId);c.messages.requireAccess(run.agentId,args.target.channel);
    const grant=s.db.prepare('SELECT root FROM grants WHERE id=?').get(args.grantId) as {root:string}|undefined;
    if(!grant||grant.root!==this.memoryRoots[run.agentId]||!relative(grant.root,checkedPath(grant.root,args.path)).startsWith('artifacts/'))throw new Error('Only own artifacts/ files may be published');
    const read=await this.broker.execute(run,workId,`${actionId}:read`,args.grantId,{kind:'read',path:args.path},signal) as ExecutionResult|{receipt?:ExecutionResult};
    const file='code'in read?read:read.receipt;if(!file||file.code!==0||file.truncated)throw new Error('Artifact read failed or incomplete');
    signal.throwIfAborted();s.assertRun(run);c.assertActionWork(run,workId);c.messages.requireAccess(run.agentId,args.target.channel);
    const artifact={title:args.title,content:file.stdout,contentHash:hash(file.stdout)};
    return s.atomic(()=>{
      const action=s.prepareAction(run,actionId,{kind:'artifact_draft',workId,args,contentHash:artifact.contentHash});
      if(action.state==='succeeded'){const receipt=JSON.parse(action.receipt!);return gate.describe(run.agentId,receipt.draftId);}
      if(action.state!=='prepared')throw new Error('Publication preparation outcome unknown');
      // Changing target/action ID cannot resend an uncertain identical publication.
      if(s.db.prepare("SELECT 1 FROM actions WHERE agent_id=? AND state IN ('unknown','executing') AND json_extract(request,'$.kind')='artifact' AND json_extract(request,'$.contentHash')=?").get(run.agentId,artifact.contentHash)||s.db.prepare("SELECT 1 FROM outbox WHERE agent_id=? AND state IN ('sending','unknown') AND json_extract(request,'$.artifact.contentHash')=?").get(run.agentId,artifact.contentHash))throw new Error('Artifact publication outcome unknown; inspect Slack before retry');
      s.startAction(run,actionId);let result:unknown;
      if(args.draftId){const previous=gate.describe(run.agentId,args.draftId) as {artifact?:unknown};if(!previous.artifact)throw new Error('Not an artifact draft');result=gate.revise(run,args.draftId,args.revision!,args.text??args.title,args.target,artifact);}
      else{c.output.queueArtifact(run.agentId,args.target,args.text??args.title,artifact,actionId,{run,...(args.viewToken?{viewToken:args.viewToken}:{})});s.db.prepare('INSERT INTO output_work VALUES(?,?)').run(actionId,workId);result=gate.describe(run.agentId,actionId);}
      s.settleAction(run,actionId,'succeeded',result);return result;
    });
  }
}
