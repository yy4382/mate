import { mkdirSync, writeFileSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { App } from '@slack/bolt';
import { ManagedSocket } from '../slack/socket.js';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { DaemonConfig } from './config.js';
import { requireSecret } from '../config.js';
import { Store, hash } from '../storage/store.js';
import { Messages, Output } from '../slack/messages.js';
import { WebSlackTransport } from '../slack/transport.js';
import { DurableReceiver } from '../slack/receiver.js';
import { Collaboration } from '../collaboration/service.js';
import { Broker } from '../policy/broker.js';
import { JevClassifier } from '../policy/jev.js';
import { SandboxBackend, type ExecutionBackend } from '../execution/backend.js';
import { ContainerBackend, ControlledBackend } from '../execution/container.js';
import { canonicalRoot, within } from '../execution/paths.js';
import { Supervisor } from '../runtime/supervisor.js';
import { ToolRouter } from '../runtime/tools.js';
import { acquireLock } from './lock.js';
import { Ingress } from './ingress.js';
import { Controls } from './control.js';
import { SlackService } from './slack.js';
import { Research } from './research.js';
import { Artifacts } from './artifacts.js';
import { executionScope } from './paths.js';
import { backup } from './backup.js';
export interface Log { info(data: object, message: string): void; error(data: object, message: string): void }
export class Daemon {
  readonly store: Store;
  readonly collaboration: Collaboration;
  readonly broker: Broker;
  readonly supervisor: Supervisor;
  readonly slack: SlackService;
  readonly memoryRoots: Record<string, string> = {};
  readonly backend: ExecutionBackend;
  private release: () => void;
  private container: ContainerBackend | undefined;
  private apps: App[] = [];
  private stopping = false;
  private paused = false;
  private runs = new Set<Promise<unknown>>();
  private loopPromise?: Promise<void>;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  constructor(readonly config: DaemonConfig, readonly log: Log, readonly projectRoot = resolve('.')) {
    const data = config.runtime.dataDir;
    mkdirSync(data, { recursive: true, mode: 0o700 });
    if (lstatSync(data).isSymbolicLink() || within(realpathSync(projectRoot), realpathSync(data))) throw new Error('Data directory must be outside the application checkout and not a symlink');
    const state = join(data, 'state'); mkdirSync(state, { recursive: true, mode: 0o700 });
    if (lstatSync(state).isSymbolicLink()) throw new Error('State path must not be a symlink');
    this.release = acquireLock(join(state, 'daemon.lock'));
    let opened: Store | undefined;
    try {
      this.store = opened = new Store(join(state, 'mate.sqlite'));
      const policyHash = hash(JSON.stringify(config.runtime));
      const oldPolicy = this.store.db.prepare("SELECT value FROM runtime_meta WHERE key='policy'").get() as { value: string } | undefined;
      if (oldPolicy && oldPolicy.value !== policyHash) throw new Error('Runtime policy changed; explicit policy migration required');
      this.store.db.prepare("INSERT INTO runtime_meta VALUES('policy',?) ON CONFLICT DO NOTHING").run(policyHash);
      const c = config.mate;
      const transport = new WebSlackTransport(Object.fromEntries(c.agents.map(a => [a.id, requireSecret(process.env, a.botTokenEnv)])));
      const messages = new Messages(this.store, c), output = new Output(messages, transport);
      this.collaboration = new Collaboration(this.store, messages, output, c);
      const files = new SandboxBackend();
      if (config.runtime.docker) this.container = new ContainerBackend({ ...config.runtime.docker, scope: executionScope(data) });
      this.backend = new ControlledBackend(files, this.container ?? { execute: async () => { throw new Error('Container execution is not configured'); } });
      const secrets = c.agents.flatMap(a => [process.env[a.botTokenEnv], process.env[a.appTokenEnv], process.env[a.model.apiKeyEnv]]).filter((s): s is string => !!s);
      const classifier = process.env[c.jevApiKeyEnv] ? new JevClassifier(process.env[c.jevApiKeyEnv]!, secrets) : { classify: async () => ({ status: 'unavailable', automaticAllow: false }) };
      this.broker = new Broker(this.store, this.collaboration, this.backend, classifier, [projectRoot, state]);
      const research = new Research(config.runtime.researchHosts);
      let artifacts!: Artifacts;
      const router = new ToolRouter(this.collaboration, this.broker, { research: (url, signal) => research.read(url, signal), publish: (...args) => artifacts.publish(...args) });
      this.supervisor = new Supervisor(this.collaboration, router, c, undefined, async (agentId, workId, signal) => {
        this.ensureGrants(agentId, workId);
        const result = await files.execute({ root: this.memoryRoots[agentId]!, operation: { kind: 'read', path: 'MEMORY.md' }, timeoutMs: 10000 }, signal);
        if (result.code !== 0 || result.truncated) throw new Error('Private memory recovery read failed'); return result.stdout;
      });
      this.supervisor.register();
      const agentsDir = join(data, 'agents'); mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
      if (lstatSync(agentsDir).isSymbolicLink()) throw new Error('Agents directory must not be a symlink');
      for (const agent of c.agents) {
        const root = join(data, 'agents', agent.id); mkdirSync(root, { recursive: true, mode: 0o700 });
        if (lstatSync(root).isSymbolicLink()) throw new Error('Agent memory must not be a symlink');
        this.memoryRoots[agent.id] = canonicalRoot(root, [projectRoot, state]);
        for (const dir of ['notes','artifacts']) mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
        if (!existsSync(join(root, 'MEMORY.md'))) writeFileSync(join(root, 'MEMORY.md'), `# ${agent.name}\n\nPrivate memory entry. Keep durable lessons and links to notes here.\n`, { flag: 'wx', mode: 0o600 });
      }
      for (const grant of config.runtime.workspaceGrants) canonicalRoot(grant.root, [projectRoot, state, agentsDir]);
      const ingress = new Ingress(this.collaboration), controls = new Controls(this.collaboration, this.supervisor, this.broker);
      this.slack = new SlackService(this.collaboration, transport, ingress, controls, () => this.stopping);
      artifacts = new Artifacts(this.collaboration, this.broker, this.slack, this.memoryRoots);
    } catch (error) { opened?.close(); this.release(); throw error; }
  }
  private ensureGrants(agentId: string, workId: string): void {
    const grants = [{ root: this.memoryRoots[agentId]!, operations: ['read','write'] as ('read'|'write'|'exec')[], exactCommands: [] as { command: string; cwd: string }[] }, ...this.config.runtime.workspaceGrants.filter(g => g.agentId === agentId)];
    for (const grant of grants) {
      const root = realpathSync(grant.root);
      if (!this.store.db.prepare('SELECT 1 FROM grants WHERE agent_id=? AND work_id=? AND root=?').get(agentId, workId, root)) this.broker.issueGrant(this.config.mate.ownerUserIds[0]!, agentId, workId, root, grant.operations, Date.now() + 365 * 86400000, grant.exactCommands);
    }
  }
  start(): Promise<void> { return this.startPromise ??= this.open(); }
  private async open(): Promise<void> {
    if (this.stopping) return;
    const models = builtinModels();
    for (const agent of this.config.mate.agents) { requireSecret(process.env, agent.appTokenEnv); requireSecret(process.env, agent.model.apiKeyEnv); if (!models.getModel(agent.model.provider, agent.model.id)) throw new Error(`Unknown provider/model for ${agent.id}`); }
    await this.container?.recover(); if (this.stopping) return; this.store.recover();
    await this.slack.verify(); if (this.stopping) return;
    await this.slack.membership(); if (this.stopping) return;
    await this.slack.catchUp(); if (this.stopping) return;
    for (const agent of this.config.mate.agents) {
      const socket = new ManagedSocket(requireSecret(process.env, agent.appTokenEnv));
      const receiver = new DurableReceiver(this.store, agent.slackAppId, this.config.mate.teamId, socket, () => this.log.error({ agentId: agent.id }, 'Slack receiver error; uncommitted events are not acknowledged'), () => this.slack.replay());
      const app = new App({ token: requireSecret(process.env, agent.botTokenEnv), receiver });
      app.event(/.*/, async () => {}); app.command('/team', async () => {}); app.action(/.*/, async () => {});
      this.apps.push(app); await app.start(); if (this.stopping) return;
    }
    this.loopPromise = this.loop(); this.log.info({}, 'Mate daemon started');
  }
  private async loop(): Promise<void> {
    let nextReconcile = 0, nextMembership = Date.now() + 300000;
    while (!this.stopping) {
      try {
        this.slack.replay();
        if (!this.paused) {
          this.collaboration.tick(); this.slack.queueApprovals();
          for (const row of this.collaboration.output.ready()) await this.collaboration.output.send(row.id);
          this.slack.ingress.bindPeerEchoes(); this.collaboration.activateDelegations();
          await this.slack.flushAdmin();
          if (!this.paused && !this.stopping) for (const agent of this.config.mate.agents) {
            const run = this.supervisor.step(agent.id); this.runs.add(run); void run.finally(() => this.runs.delete(run));
          }
          if (Date.now() >= nextReconcile) { await this.slack.reconcile(); nextReconcile = Date.now() + 60000; }
          if (Date.now() >= nextMembership) { await this.slack.membership(); await this.slack.catchUp(); nextMembership = Date.now() + 300000; }
        }
      } catch { this.log.error({}, 'Daemon tick failed; durable state retained'); }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  async checkpoint(destination: string): Promise<void> {
    this.paused = true;
    try { await Promise.allSettled([...this.runs]); await this.supervisor.drain(); await backup(this.store, this.config.runtime.dataDir, destination); }
    finally { this.paused = false; }
  }
  close(): Promise<void> { return this.closePromise ??= this.shutdown(); }
  private async shutdown(): Promise<void> {
    this.stopping = true; this.supervisor.close();
    await Promise.allSettled(this.apps.map(app => app.stop()));
    await this.startPromise?.catch(() => {}); await this.loopPromise; await Promise.allSettled([...this.runs]);
    await this.supervisor.drain();
    // Destroy any remaining namespace before releasing the singleton lock.
    await this.container?.recover(); this.store.close(); this.release();
  }
}
