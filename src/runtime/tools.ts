import { FreshnessGate } from '../slack/freshness.js';
import { z } from 'zod';
import type { RunToken } from '../storage/store.js';
import type { Collaboration } from '../collaboration/service.js';
import type { Broker } from '../policy/broker.js';
import type { Directory } from '../slack/directory.js';
import { targetSchema } from '../slack/messages.js';
import type { ToolReply } from './engine.js';
const id = z.string().min(1).max(500), text = z.string().max(35000);
const schemas = {
  'drafts.list':z.object({}).strict(),
  'drafts.read':z.object({draftId:id}).strict(),
  'drafts.retry':z.object({draftId:id,revision:z.number().int().positive(),viewToken:id.optional()}).strict(),
  'drafts.continue':z.object({draftId:id,revision:z.number().int().positive(),holdId:id,acknowledge:z.literal('send_despite_unread_or_changes')}).strict(),
  'drafts.revise':z.object({draftId:id,revision:z.number().int().positive(),text,target:targetSchema.optional()}).strict(),
  'drafts.discard':z.object({draftId:id,revision:z.number().int().positive()}).strict(),
  'attention.peek': z.object({}).strict(),
  'attention.read': z.object({target:targetSchema,cursor:id.optional()}).strict(),
  'attention.resolve': z.object({target:targetSchema,throughRevision:z.number().int().nonnegative()}).strict(),
  'attention.defer': z.object({target:targetSchema,until:z.number().int().nonnegative()}).strict(),
  'attention.mute': z.object({target:targetSchema,active:z.boolean()}).strict(),
  'works.list': z.object({}).strict(),
  'works.select': z.object({ workId: id }).strict(),
  'budget.read': z.object({}).strict(),
  'conversations.list': z.object({}).strict(),
  'conversations.members': z.object({ channel: id }).strict(),
  'conversations.openDM': z.object({ user: z.string().regex(/^U[A-Z0-9]+$/) }).strict(),
  'research.read': z.object({ url: z.string().url().max(4000) }).strict(),
  'artifact.publish': z.object({ grantId: id, path: id, title: z.string().min(1).max(200), target: targetSchema }).strict(),
  'messages.recent': z.object({ channel: id }).strict(),
  'tasks.read': z.object({ taskId: id }).strict(),
  agents: z.object({}).strict(), 'messages.read': z.object({ target: targetSchema }).strict(),
  'messages.search': z.object({ query: text }).strict(), 'messages.send': z.object({ target: targetSchema, text,viewToken:id.optional() }).strict(),
  'messages.watch': z.object({ target: targetSchema, active: z.boolean() }).strict(),
  'tasks.list': z.object({}).strict(), 'tasks.create': z.object({ target: targetSchema, title: text, parentId: id.optional() }).strict(),
  'tasks.claim': z.object({ taskId: id }).strict(), 'tasks.delegate': z.object({ taskId: id, peerId: id, title: text, viewToken:id.optional() }).strict(),
  'tasks.wait': z.object({ taskId: id, dependencyId: id }).strict(),
  'tasks.update': z.object({ taskId: id, status: z.enum(['doing','review','done','cancelled','failed']), result: text.optional() }).strict(),
  'schedules.list': z.object({}).strict(), 'schedules.cancel': z.object({ scheduleId: id }).strict(),
  'schedules.create': z.object({ target: targetSchema, nextAt: z.number().int().positive(), timezone: id, cron: id.optional(), taskId: id.optional() }).strict(),
  'inbox.list': z.object({}).strict(), 'inbox.read': z.object({ deliveryId: id }).strict(), 'inbox.ack': z.object({ deliveryId: id }).strict(),
  'file.read': z.object({ grantId: id, path: id }).strict(), 'file.write': z.object({ grantId: id, path: id, content: z.string().max(1000000) }).strict(),
  exec: z.object({ grantId: id, command: z.string().max(16000), cwd: id }).strict()
};
export const operationDocumentation = Object.entries(schemas).map(([name, schema]) => `${name}: ${JSON.stringify(z.toJSONSchema(schema))}`).join('\n');
export interface AdditionalTools {
  research(url: string, signal: AbortSignal): Promise<unknown>;
  publish(run: RunToken, workId: string, actionId: string, args: { grantId: string; path: string; title: string; target: { channel: string; thread?: string } }, signal: AbortSignal): Promise<unknown>;
}
export class ToolRouter {
  readonly gate:FreshnessGate;
  constructor(readonly collaboration: Collaboration, readonly broker: Broker, readonly additional?: AdditionalTools, readonly directory?: Directory, readonly provision?: (actor:string,workId:string)=>void) {this.gate=new FreshnessGate(collaboration.messages,collaboration.attention);collaboration.output.gate=this.gate;}
  async call(run: RunToken, workId: string, callId: string, operation: string, input: unknown, signal: AbortSignal): Promise<ToolReply> {
    const c = this.collaboration, s = c.store, actor = run.agentId;
    s.assertRun(run); signal.throwIfAborted();
    workId = c.currentWork(run, workId);
    if (!(operation in schemas)) throw new Error('Unknown operation');
    // Parsing is deliberately repeated in the daemon, independently of model-side tool validation.
    const args = schemas[operation as keyof typeof schemas].parse(input) as Record<string, any>;
    const readOnly = ['drafts.list','drafts.read','attention.peek','attention.read','attention.resolve','attention.defer','attention.mute','agents','works.list','budget.read','tasks.read','tasks.list','messages.read','messages.recent','messages.search','schedules.list','inbox.list','inbox.read','conversations.list','conversations.members'];
    if (!readOnly.includes(operation) && operation !== 'works.select') c.assertActionWork(run, args.taskId ? c.task(args.taskId).work_id : workId);
    if(args.target)c.messages.requireAccess(actor,args.target.channel);
    if(args.channel)c.messages.requireAccess(actor,args.channel);
    if(args.taskId)c.messages.requireAccess(actor,JSON.parse(c.task(args.taskId).target).channel);
    if(args.deliveryId){const delivery=s.delivery(args.deliveryId);if(delivery.agent_id!==actor)throw new Error('Private inbox');const target=JSON.parse(delivery.payload).target;if(target)c.messages.requireAccess(actor,target.channel);}
    const actionId = `${run.sessionId}:${callId}`;
    if (operation.startsWith('conversations.')) {
      if (!this.directory) throw new Error('Directory unavailable');
      const value = operation === 'conversations.openDM' ? await this.directory.openDM(run, actionId, args.user, signal) : operation === 'conversations.members' ? await this.directory.members(actor, args.channel) : await this.directory.spaces(actor);
      s.assertRun(run); signal.throwIfAborted(); return { value };
    }
    if (operation === 'research.read') { if (!this.additional) throw new Error('Research unavailable'); return { value: await this.additional.research(args.url, signal) }; }
    if (operation === 'artifact.publish') { if (!this.additional) throw new Error('Publication unavailable'); return { value: await this.additional.publish(run, workId, actionId, args as any, signal) }; }
    if (['file.read','file.write','exec'].includes(operation)) {
      const value = await this.broker.execute(run, workId, actionId, args.grantId, operation === 'exec' ? { kind: 'exec', command: args.command, cwd: args.cwd } : operation === 'file.read' ? { kind: 'read', path: args.path } : { kind: 'write', path: args.path, content: args.content }, signal);
      return { value };
    }
    // All local effects and their receipts commit together. Crash replay returns the recorded value.
    return s.atomic(() => {
      const existing = s.prepareAction(run, actionId, operation === 'works.select' ? { operation, args } : { workId, operation, args });
      if(args.draftId)this.gate.describe(actor,args.draftId);
      const refresh = ['drafts.list','drafts.read','attention.peek','budget.read','works.list','tasks.list','messages.search','schedules.list','inbox.list'].includes(operation);
      if (existing.state === 'succeeded' && !refresh) return JSON.parse(existing.receipt!) as ToolReply;
      if(existing.state==='succeeded' && refresh){s.db.prepare("UPDATE actions SET state='prepared',run_id=? WHERE id=?").run(run.id,actionId);existing.state='prepared';}
      if (existing.state !== 'prepared') throw new Error('Uncertain tool action');
      s.startAction(run, actionId);
      if (args.taskId) c.messages.requireAccess(actor, JSON.parse(c.task(args.taskId).target).channel);
      let value: unknown = null, wait = false;
      switch (operation) {
        case 'drafts.list':value=this.gate.list(actor);break;
        case 'drafts.read':value=this.gate.describe(actor,args.draftId);break;
        case 'drafts.retry':value=this.gate.retry(run,args.draftId,args.revision,args.viewToken);break;
        case 'drafts.continue':value=this.gate.continueOnce(run,args.draftId,args.revision,args.holdId);break;
        case 'drafts.revise':value=this.gate.revise(run,args.draftId,args.revision,args.text,args.target);break;
        case 'drafts.discard':value=this.gate.discard(run,args.draftId,args.revision);break;
        case 'attention.peek': value=c.attention.peek(actor);break;
        case 'attention.read': value=c.attention.read(run,args.target,args.cursor);break;
        case 'attention.resolve': c.attention.state(actor,args.target,'resolve',args.throughRevision);break;
        case 'attention.defer': c.attention.state(actor,args.target,'defer',args.until);break;
        case 'attention.mute': c.attention.state(actor,args.target,'mute',Number(args.active));break;
        case 'budget.read': value=c.ledger.account(actor); break;
        case 'works.list': value=s.db.prepare("SELECT w.* FROM works w JOIN channel_access a ON a.channel=json_extract(w.target,'$.channel') WHERE a.agent_id=? AND a.active=1 ORDER BY w.rowid DESC LIMIT 100").all(actor); break;
        case 'works.select': c.selectWork(run,args.workId); this.provision?.(actor,args.workId); value={work:c.work(args.workId),grants:s.db.prepare('SELECT id,operations FROM grants WHERE agent_id=? AND work_id=? AND revoked=0 AND expires>?').all(actor,args.workId,Date.now())}; break;
        case 'agents': value = c.config.agents.map(a => ({ id: a.id, name: a.name, role: a.role, slackUserId: a.slackUserId })); break;
        case 'tasks.read': { const task = c.task(args.taskId); c.messages.requireAccess(actor, JSON.parse(task.target).channel); value = task; break; }
        case 'messages.recent': value = c.messages.recent(actor, args.channel); break;
        case 'messages.read': value = c.messages.read(actor, args.target); break;
        case 'messages.search': value = c.messages.search(actor, args.query); break;
        case 'messages.send': c.send(actor, workId, args.target, args.text, actionId,{run,viewToken:args.viewToken});value=this.gate.describe(actor,actionId);break;
        case 'messages.watch': c.messages.watch(actor, args.target, args.active); break;
        case 'tasks.list': value = c.list(actor); break;
        case 'tasks.create': value = c.createTask(actor, workId, args.target, args.title, args.parentId); break;
        case 'tasks.claim': value = c.claim(actor, args.taskId); break;
        case 'tasks.delegate': value = c.delegate(actor, args.taskId, args.peerId, args.title,{run,viewToken:args.viewToken}); break;
        case 'tasks.wait': c.wait(actor, args.taskId, args.dependencyId); wait = c.task(args.taskId).status === 'waiting'; break;
        case 'tasks.update': c.update(actor, args.taskId, args.status, args.result); break;
        case 'schedules.list': value = c.schedules(actor); break;
        case 'schedules.create': value = c.schedule(actor, workId, args.target, args.nextAt, args.timezone, args.cron, args.taskId); break;
        case 'schedules.cancel': c.cancelSchedule(actor, args.scheduleId); break;
        case 'inbox.read': case 'inbox.ack': {
          const delivery = s.delivery(args.deliveryId);
          if (delivery.agent_id !== actor) throw new Error('Private inbox');
          const payload = JSON.parse(delivery.payload);
          if (payload.target?.channel) c.messages.requireAccess(actor, payload.target.channel);
          if (operation === 'inbox.ack') s.db.prepare('INSERT INTO inbox_reads VALUES(?,?,?) ON CONFLICT DO NOTHING').run(delivery.id, actor, Date.now());
          value = { ...delivery, payload }; break;
        }
        case 'inbox.list': value = (s.db.prepare("SELECT id,payload,status FROM deliveries WHERE agent_id=? AND status!='handled' ORDER BY created_at LIMIT 50").all(actor) as { id: string; payload: string; status: string }[]).filter(d => { const target = JSON.parse(d.payload).target; if (!target?.channel) return true; try { c.messages.requireAccess(actor, target.channel); return true; } catch { return false; } }).map(d => ({ id: d.id, status: d.status, kind: JSON.parse(d.payload).kind })); break;
      }
      const result = { value, wait }; s.settleAction(run, actionId, 'succeeded', result); return result;
    });
  }
}
