import { relative } from 'node:path';
import { checkedPath } from '../execution/paths.js';
import type { RunToken } from '../storage/store.js';
import { encode, hash } from '../storage/store.js';
import type { Broker } from '../policy/broker.js';
import type { Collaboration } from '../collaboration/service.js';
import type { Target } from '../slack/messages.js';
import type { ExecutionResult } from '../execution/backend.js';
export interface ArtifactTransport { upload(agentId: string, target: Target, title: string, content: string): Promise<{ fileId: string }> }
export class Artifacts {
  constructor(readonly collaboration: Collaboration, readonly broker: Broker, readonly transport: ArtifactTransport, readonly memoryRoots: Record<string, string>) {}
  async publish(run: RunToken, workId: string, actionId: string, args: { grantId: string; path: string; title: string; target: Target }, signal: AbortSignal): Promise<unknown> {
    const c = this.collaboration, s = c.store;
    s.assertRun(run); c.messages.requireAccess(run.agentId, args.target.channel);
    const grant = s.db.prepare('SELECT root FROM grants WHERE id=?').get(args.grantId) as { root: string } | undefined;
    if (!grant || grant.root !== this.memoryRoots[run.agentId] || !relative(grant.root, checkedPath(grant.root, args.path)).startsWith('artifacts/')) throw new Error('Only own artifacts/ files may be published');
    const read = await this.broker.execute(run, workId, `${actionId}:read`, args.grantId, { kind: 'read', path: args.path }, signal) as { status: string; receipt?: ExecutionResult };
    const file = 'code' in read ? read as unknown as ExecutionResult : read.receipt;
    if (!file || file.code !== 0 || file.truncated) throw new Error('Artifact read failed or incomplete');
    const content = file.stdout, request = { kind: 'artifact', workId, target: args.target, title: args.title, contentHash: hash(content), path: args.path };
    const action = s.prepareAction(run, actionId, request);
    if (action.state === 'succeeded') return JSON.parse(action.receipt!);
    if (action.state !== 'prepared' || s.db.prepare("SELECT 1 FROM actions WHERE agent_id=? AND state IN ('unknown','executing') AND json_extract(request,'$.kind')='artifact' AND json_extract(request,'$.contentHash')=?").get(run.agentId, request.contentHash)) throw new Error('Artifact publication outcome unknown; inspect Slack before retry');
    s.startAction(run, actionId);
    try {
      signal.throwIfAborted(); s.assertRun(run); c.messages.requireAccess(run.agentId, args.target.channel);
      const receipt = await this.transport.upload(run.agentId, args.target, args.title, content);
      s.settleAction(run, actionId, 'succeeded', receipt); return receipt;
    } catch (error) { try { s.settleAction(run, actionId, 'unknown', { error: 'Publication interrupted or uncertain' }); } catch { /* fenced */ } throw error; }
  }
}
