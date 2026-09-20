import { z } from 'zod';
import type { RunToken } from '../storage/store.js';
import type { Collaboration } from '../collaboration/service.js';
import type { Broker } from '../policy/broker.js';
import { targetSchema } from '../slack/messages.js';
import type { ToolReply } from './engine.js';
const id = z.string().min(1).max(500), text = z.string().max(35000);
const schemas = {
  'research.read': z.object({ url: z.string().url().max(4000) }).strict(),
  'artifact.publish': z.object({ grantId: id, path: id, title: z.string().min(1).max(200), target: targetSchema }).strict(),
  'messages.recent': z.object({ channel: id }).strict(),
  'tasks.read': z.object({ taskId: id }).strict(),
  agents: z.object({}).strict(), 'messages.read': z.object({ target: targetSchema }).strict(),
  'messages.search': z.object({ query: text }).strict(), 'messages.send': z.object({ target: targetSchema, text }).strict(),
  'messages.watch': z.object({ target: targetSchema, active: z.boolean() }).strict(),
  'tasks.list': z.object({}).strict(), 'tasks.create': z.object({ target: targetSchema, title: text, parentId: id.optional() }).strict(),
  'tasks.claim': z.object({ taskId: id }).strict(), 'tasks.delegate': z.object({ taskId: id, peerId: id, title: text }).strict(),
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
  publish(run: RunToken, workId: string, actionId: string, args: { grantId: string; path: string; title: string; target: { channel: string; thread: string } }, signal: AbortSignal): Promise<unknown>;
}
export class ToolRouter {
  constructor(readonly collaboration: Collaboration, readonly broker: Broker, readonly additional?: AdditionalTools) {}
  async call(run: RunToken, workId: string, callId: string, operation: string, input: unknown, signal: AbortSignal): Promise<ToolReply> {
    const c = this.collaboration, s = c.store, actor = run.agentId;
    s.assertRun(run); signal.throwIfAborted();
    if (c.work(workId).state !== 'active') throw new Error('Work not active');
    if (!(operation in schemas)) throw new Error('Unknown operation');
    // Parsing is deliberately repeated in the daemon, independently of model-side tool validation.
    const args = schemas[operation as keyof typeof schemas].parse(input) as Record<string, any>;
    const actionId = `${run.sessionId}:${callId}`;
    if (operation === 'research.read') { if (!this.additional) throw new Error('Research unavailable'); return { value: await this.additional.research(args.url, signal) }; }
    if (operation === 'artifact.publish') { if (!this.additional) throw new Error('Publication unavailable'); return { value: await this.additional.publish(run, workId, actionId, args as any, signal) }; }
    if (['file.read','file.write','exec'].includes(operation)) {
      const value = await this.broker.execute(run, workId, actionId, args.grantId, operation === 'exec' ? { kind: 'exec', command: args.command, cwd: args.cwd } : operation === 'file.read' ? { kind: 'read', path: args.path } : { kind: 'write', path: args.path, content: args.content }, signal);
      return { value };
    }
    // All local effects and their receipts commit together. Crash replay returns the recorded value.
    return s.atomic(() => {
      const existing = s.prepareAction(run, actionId, { workId, operation, args });
      if (existing.state === 'succeeded') return JSON.parse(existing.receipt!) as ToolReply;
      if (existing.state !== 'prepared') throw new Error('Uncertain tool action');
      s.startAction(run, actionId);
      if (args.taskId && c.task(args.taskId).work_id !== workId) throw new Error('Task belongs to another work');
      let value: unknown = null, wait = false;
      switch (operation) {
        case 'agents': value = c.config.agents.map(a => ({ id: a.id, name: a.name, role: a.role, slackUserId: a.slackUserId })); break;
        case 'tasks.read': { const task = c.task(args.taskId); c.messages.requireAccess(actor, JSON.parse(task.target).channel); value = task; break; }
        case 'messages.recent': value = c.messages.recent(actor, args.channel); break;
        case 'messages.read': value = c.messages.read(actor, args.target); break;
        case 'messages.search': value = c.messages.search(actor, args.query); break;
        case 'messages.send': value = c.send(actor, workId, args.target, args.text, actionId); break;
        case 'messages.watch': c.messages.watch(actor, args.target, args.active); break;
        case 'tasks.list': value = c.list(actor); break;
        case 'tasks.create': value = c.createTask(actor, workId, args.target, args.title, args.parentId); break;
        case 'tasks.claim': value = c.claim(actor, args.taskId); break;
        case 'tasks.delegate': value = c.delegate(actor, args.taskId, args.peerId, args.title); break;
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
