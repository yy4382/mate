import type { AdapterLifecycle } from "./adapter.js";
import { SlackRuntime } from "../slack/runtime.js";
import { configureLocalRooms } from "../local/rooms.js";
import type { LocalAdapter } from "../local/input.js";

import { storedConfiguration, saveConfiguration } from "./config.js";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  realpathSync,
  lstatSync,
  readdirSync,
  readFileSync,
  chownSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  sameConfiguration,
  assertConfigurationEvolution,
  daemonConfigSchema,
  slackRuntimeConfig,
  type DaemonConfig,
} from "./config.js";
import { requireSecret } from "../config.js";
import { Store } from "../storage/store.js";

import { Collaboration } from "../collaboration/service.js";
import { Broker } from "../policy/broker.js";
import type { ExecutionBackend } from "../execution/backend.js";
import { LinuxUserBackend } from "../execution/linux-user.js";
import { LinuxProcessManager } from "../execution/linux-processes.js";
import { SystemOperations } from "../policy/system-operations.js";
import { canonicalRoot, within } from "../execution/paths.js";
import { Supervisor } from "../runtime/supervisor.js";
import { Controls } from "./control.js";
import { acquireLock } from "./lock.js";
import { reservedAgentHomePaths, pathVariants } from "./paths.js";
import { assertNoRestoreInProgress } from "./restore.js";
import { assertLinuxOperationAllowed } from "../deployment/linux-upgrade-guard.js";
import { nodeHostOperations, type HostOperations } from "../deployment/host.js";
import { initialMemory } from "../agents/workspace.js";
import { buildBaseline } from "../runtime/prompt.js";
import { operationDocumentation } from "../runtime/tools.js";
import { repairTranscript } from "../runtime/context.js";
import { Application } from "../application.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
export interface Log {
  info(data: object, message: string): void;
  error(data: object, message: string): void;
}
export class Daemon {
  readonly store: Store;
  /** The one application assembly: every collaborator below is wired there before use. */
  readonly application: Application;
  readonly collaboration: Collaboration;
  readonly broker: Broker;
  readonly system: SystemOperations;
  readonly supervisor: Supervisor;
  readonly controls: Controls;
  readonly local: LocalAdapter | undefined;
  readonly adapter: AdapterLifecycle | undefined;
  private readonly slackRuntime: SlackRuntime | undefined;
  /** Compatibility inspection surface; production lifecycle uses the adapter port. */
  get slack() {
    if (!this.slackRuntime) throw new Error("Slack adapter unavailable");
    return this.slackRuntime.service;
  }
  get projections() {
    if (!this.slackRuntime) throw new Error("Slack adapter unavailable");
    return this.slackRuntime.projections;
  }
  readonly memoryRoots: Record<string, string> = {};
  readonly backend: ExecutionBackend;
  private release: () => void;
  private readonly abort = new AbortController();
  private background?: Promise<void>;
  private privileged?: Promise<void>;
  private opening?: Promise<void>;
  private stopping = false;
  private paused = false;
  private runs = new Set<Promise<unknown>>();
  private loopPromise?: Promise<void>;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private recoveredDuringStartup = false;
  readonly config: DaemonConfig;
  static async create(input: unknown, log: Log, projectRoot = resolve(".")): Promise<Daemon> {
    // The daemon entry owns its own host entry, like the other process entries; its remaining
    // startup checks (data/state creation, worker quota) stay local to daemon startup.
    const host: HostOperations = nodeHostOperations(),
      config = daemonConfigSchema.parse(input),
      data = config.runtime.dataDir;
    if (process.platform === "linux" && !config.runtime.linuxUsers)
      throw new Error("Linux deployment requires one Linux user for every Agent");
    if (config.runtime.linuxUsers && process.platform === "linux") {
      if (process.getuid?.() !== 0)
        throw new Error("Mate must run as root to switch Agent Linux users");
      const processes = new LinuxProcessManager(
        Object.fromEntries(
          Object.entries(config.runtime.linuxUsers).map(([agentId, user]) => [agentId, user.uid]),
        ),
      );
      for (const agent of config.mate.agents) await processes.verifyQuota(agent.id);
    }
    mkdirSync(data, { recursive: true, mode: 0o700 });
    if (lstatSync(data).isSymbolicLink() || within(realpathSync(projectRoot), realpathSync(data)))
      throw new Error("Data directory must be outside the application checkout and not a symlink");
    const state = join(data, "state");
    mkdirSync(state, { recursive: true, mode: 0o700 });
    if (lstatSync(state).isSymbolicLink()) throw new Error("State path must not be a symlink");
    if (config.runtime.linuxUsers)
      for (const path of [data, state]) {
        const status = lstatSync(path);
        if (
          !status.isDirectory() ||
          status.uid !== process.getuid?.() ||
          status.gid !== process.getgid?.() ||
          (status.mode & 0o777) !== 0o700
        )
          throw new Error(`Mate control directory must be private and owned by Mate: ${path}`);
      }
    const release = acquireLock(join(state, "daemon.lock"));
    let transferred = false;
    try {
      await assertLinuxOperationAllowed(host, "start", config);
      await assertNoRestoreInProgress(host, data);
      const daemon = new Daemon(config, log, projectRoot, release);
      transferred = true;
      return daemon;
    } finally {
      if (!transferred) release();
    }
  }
  private constructor(
    config: DaemonConfig,
    readonly log: Log,
    readonly projectRoot: string,
    release: () => void,
  ) {
    this.config = config;
    this.release = release;
    const slackConfig = slackRuntimeConfig(config);
    const data = config.runtime.dataDir;
    if (lstatSync(data).isSymbolicLink() || within(realpathSync(projectRoot), realpathSync(data)))
      throw new Error("Data directory must be outside the application checkout and not a symlink");
    const state = join(data, "state");
    if (lstatSync(state).isSymbolicLink()) throw new Error("State path must not be a symlink");
    let opened: Store | undefined;
    try {
      this.store = opened = new Store(join(state, "mate.sqlite"));
      this.store.db.exec("BEGIN IMMEDIATE");
      const previous = storedConfiguration(this.store);
      // One format has one startup path: a changed configuration of this same release
      // keeps every Agent identity and re-baselines only the sessions it invalidates.
      let configurationChanged = false;
      if (previous && !sameConfiguration(previous, config)) {
        assertConfigurationEvolution(previous, config);
        configurationChanged = true;
      }
      // Every Agent row in this database must belong to the running configuration.
      // A row without a configured identity has no owner to act as, so it is reported
      // instead of being kept as an unreachable identity.
      const orphans = (
        this.store.db.prepare("SELECT id FROM agents ORDER BY id").all() as { id: string }[]
      )
        .map((row) => row.id)
        .filter((id) => !config.mate.agents.some((agent) => agent.id === id));
      if (orphans.length)
        throw new Error(
          `This data directory holds Agents that are not in the configuration (${orphans.join(", ")}). Add them back to the configuration, restore the database from a checkpoint, or start with a new, empty data directory.`,
        );
      const c = config.mate;
      const agentsDir = join(data, "agents");
      if (!config.runtime.linuxUsers) mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
      if (existsSync(agentsDir) && lstatSync(agentsDir).isSymbolicLink())
        throw new Error("Agents directory must not be a symlink");
      for (const agent of c.agents) {
        const linux = config.runtime.linuxUsers?.[agent.id];
        const root = linux?.home ?? join(data, "agents", agent.id);
        if (linux) {
          if (!existsSync(root))
            throw new Error(`Linux Agent home must be provisioned first: ${agent.id}`);
          const status = lstatSync(root);
          if (
            !status.isDirectory() ||
            status.uid !== linux.uid ||
            status.gid !== linux.gid ||
            (status.mode & 0o777) !== 0o700
          )
            throw new Error(`Linux Agent home must be private and owned by its user: ${agent.id}`);
          if (
            within(realpathSync(data), realpathSync(root)) ||
            within(realpathSync(root), realpathSync(data))
          )
            throw new Error("Linux Agent home must be outside Mate data");
        } else mkdirSync(root, { recursive: true, mode: 0o700 });
        if (lstatSync(root).isSymbolicLink()) throw new Error("Agent memory must not be a symlink");
        this.memoryRoots[agent.id] = canonicalRoot(root, [projectRoot, state]);
        const memory = join(root, "MEMORY.md");
        if (!existsSync(memory)) {
          if (linux)
            throw new Error(`Provision Linux Agent memory entry before startup: ${agent.id}`);
          for (const name of ["notes", "artifacts"])
            mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
          writeFileSync(memory, initialMemory(agent.name), { flag: "wx", mode: 0o600 });
        }
        if (linux) {
          const status = lstatSync(memory);
          if (
            !status.isFile() ||
            status.uid !== linux.uid ||
            status.gid !== linux.gid ||
            (status.mode & 0o600) !== 0o600
          )
            throw new Error(`Linux Agent memory entry is not writable by its user: ${agent.id}`);
        }
      }
      if (config.runtime.linuxUsers) {
        const homes = Object.values(this.memoryRoots);
        for (const [index, root] of homes.entries())
          for (const other of homes.slice(index + 1))
            if (within(root, other) || within(other, root))
              throw new Error("Linux Agent homes overlap");
      }
      const protectedRoots = reservedAgentHomePaths(projectRoot, state, agentsDir),
        privateBase = new Set(pathVariants(agentsDir));
      const privateForbidden = protectedRoots.filter((root) => !privateBase.has(root));
      for (const root of Object.values(this.memoryRoots)) canonicalRoot(root, privateForbidden);
      if (config.runtime.sharedRoot) {
        const shared = canonicalRoot(config.runtime.sharedRoot, [
            ...protectedRoots,
            ...Object.values(this.memoryRoots),
          ]),
          stat = lstatSync(shared);
        if (
          (process.platform === "linux" && stat.uid !== 0) ||
          stat.mode & 0o022 ||
          (stat.mode & 0o005) !== 0o005
        )
          throw new Error("Shared root must be root-owned and readable, not writable, by Agents");
        for (const [agentId, user] of Object.entries(config.runtime.linuxUsers ?? {})) {
          const own = join(shared, agentId);
          if (!existsSync(own)) {
            mkdirSync(own, { mode: 0o755 });
            chmodSync(own, 0o755);
            chownSync(own, user.uid, user.gid);
          }
          const ownStat = lstatSync(own);
          if (
            !ownStat.isDirectory() ||
            ownStat.uid !== user.uid ||
            ownStat.gid !== user.gid ||
            (ownStat.mode & 0o777) !== 0o755
          )
            throw new Error(
              `Shared Agent directory must be owned by its user and peer-readable: ${agentId}`,
            );
        }
      }
      const identities =
        config.runtime.linuxUsers ??
        Object.fromEntries(
          Object.entries(this.memoryRoots).map(([id, home]) => [
            id,
            { uid: process.getuid!(), gid: process.getgid!(), home },
          ]),
        );
      const linuxProcesses = config.runtime.linuxUsers
        ? new LinuxProcessManager(
            Object.fromEntries(
              Object.entries(config.runtime.linuxUsers).map(([agentId, user]) => [
                agentId,
                user.uid,
              ]),
            ),
          )
        : undefined;
      // One assembly gives this entry a complete application; everything below is already wired.
      this.application = Application.create({
        store: this.store,
        team: c,
        ...(config.adapters.local ? { local: config.adapters.local } : {}),
        runtime: {
          limits: config.runtime.limits,
          researchHosts: config.runtime.researchHosts,
          ...(config.runtime.sharedRoot ? { sharedRoot: config.runtime.sharedRoot } : {}),
          ...(config.runtime.systemAgents ? { systemAgents: config.runtime.systemAgents } : {}),
        },
        ports: {
          backend: new LinuxUserBackend(identities),
          memoryRoots: this.memoryRoots,
          ...(slackConfig
            ? { slack: { config: slackConfig, artifacts: () => this.slackRuntime?.service } }
            : {}),
          ...(linuxProcesses ? { linuxProcesses } : {}),
          reviewWorkspace: (actor) => this.verifyReviewWorkspace(actor),
          controlProjection: (user, command, id, args) =>
            this.slackRuntime?.projections.control(user, command, id, args),
        },
      });
      this.collaboration = this.application.collaboration;
      this.broker = this.application.broker;
      this.system = this.application.system;
      this.supervisor = this.application.supervisor;
      this.controls = this.application.controls;
      this.local = this.application.local;
      this.backend = this.application.backend;
      if (configurationChanged) {
        // A changed configuration can change the baseline each Agent starts from.
        // Fence any run left by the previous process, then move affected sessions to
        // the new baseline without discarding their journal or pending delivery.
        this.store.recover();
        this.recoveredDuringStartup = true;
        for (const agent of c.agents) {
          const baseline = buildBaseline(agent, operationDocumentation);
          const row = this.store.db
            .prepare(
              "SELECT a.session_id,s.config_version FROM agents a JOIN sessions s ON s.id=a.session_id WHERE a.id=?",
            )
            .get(agent.id) as { session_id: string; config_version: string } | undefined;
          if (!row || row.config_version === baseline.configVersion) continue;
          const history = repairTranscript(
            this.store.context(row.session_id) as AgentMessage[],
            (id) => {
              const action = this.store.action(`${row.session_id}:${id}`);
              return action
                ? JSON.stringify({
                    recoveredAction: action.id,
                    state: action.state,
                    receipt: action.receipt ? JSON.parse(action.receipt) : null,
                  })
                : undefined;
            },
          );
          this.store.rotateSession(
            agent.id,
            baseline.configVersion,
            [...baseline.messages, ...history.filter((message) => message.role !== "system")],
            "configuration_change",
          );
        }
      }
      this.supervisor.register();
      const slackTransport = this.application.transport;
      this.adapter = this.slackRuntime =
        slackConfig && slackTransport
          ? new SlackRuntime(
              this.collaboration,
              slackTransport,
              this.controls,
              (message) => this.log.error({}, message),
              this.system,
            )
          : undefined;
      this.store.atomic(() => {
        configureLocalRooms(
          this.collaboration,
          this.local,
          previous?.adapters.local,
          config.adapters.local,
        );
        saveConfiguration(this.store, config);
        if (configurationChanged)
          this.store.audit("configuration_change", {
            agents: config.mate.agents.map((agent) => agent.id),
          });
      });
      this.store.db.exec("COMMIT");
    } catch (error) {
      try {
        if (opened?.db.inTransaction) opened.db.exec("ROLLBACK");
      } finally {
        try {
          opened?.close();
        } finally {
          this.release();
        }
      }
      throw error;
    }
  }
  private verifyReviewWorkspace(actor: string): string {
    const root = this.memoryRoots[actor],
      agent = this.collaboration.agents.get(actor);
    if (!root || !agent) throw new Error("Unknown review identity");
    const names = readdirSync(root);
    if (names.some((name) => !["MEMORY.md", "notes", "artifacts"].includes(name)))
      throw new Error("Review workspace is not clean");
    for (const dir of ["notes", "artifacts"]) {
      if (!names.includes(dir)) continue;
      const path = join(root, dir);
      if (lstatSync(path).isSymbolicLink() || readdirSync(path).length)
        throw new Error("Review workspace contains prior material");
    }
    const memory = join(root, "MEMORY.md");
    if (
      lstatSync(memory).isSymbolicLink() ||
      lstatSync(memory).nlink !== 1 ||
      readFileSync(memory, "utf8") !== initialMemory(agent.name)
    )
      throw new Error("Review memory contains prior material");
    return root;
  }
  start(progress?: () => void): Promise<void> {
    if (!this.startPromise) {
      this.opening = this.open(progress);
      this.startPromise = this.opening.catch(async (error) => {
        await this.close();
        throw error;
      });
    }
    return this.startPromise;
  }
  private async open(progress?: () => void): Promise<void> {
    if (this.stopping) throw new Error("Daemon stopped during startup");
    if (!this.recoveredDuringStartup) this.store.recover();
    this.system.recover();
    this.adapter?.recover();
    this.supervisor.recoverSessions();
    const models = builtinModels();
    for (const agent of this.config.mate.agents) {
      requireSecret(process.env, agent.model.apiKeyEnv);
      if (!models.getModel(agent.model.provider, agent.model.id))
        throw new Error(`Unknown provider/model for ${agent.id}`);
    }
    const slackConfig = slackRuntimeConfig(this.config);
    if (slackConfig && this.slackRuntime)
      this.slackRuntime.transport.configure(
        Object.fromEntries(
          slackConfig.agents.map((agent) => [
            agent.id,
            requireSecret(process.env, agent.botTokenEnv),
          ]),
        ),
      );
    await this.adapter?.start(this.abort.signal, progress);
    if (this.stopping) throw new Error("Daemon stopped during startup");
    this.application.gate.adoptPending();
    this.loopPromise = this.loop();
    this.log.info({}, "Mate daemon started");
  }
  private async flushExternal(): Promise<void> {
    try {
      for (const row of this.collaboration.output.ready(20, "external")) {
        if (this.stopping || this.paused) return;
        const target = this.collaboration.messages.records.targetedEffect("outbox", row.id).target;
        if (
          this.collaboration.messages.references.conversation(target.conversationId).authority ===
          "external"
        )
          await this.collaboration.output.send(row.id);
      }
    } catch {
      this.log.error({}, "External output flush failed; durable state retained");
    }
    if (!this.stopping && !this.paused)
      try {
        await this.adapter?.flush();
      } catch {
        this.log.error({}, "Adapter maintenance failed; internal scheduling continues");
      }
  }
  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        if (!this.paused) this.adapter?.poll();
      } catch {
        this.log.error({}, "Adapter replay failed; internal scheduling continues");
      }
      try {
        if (!this.paused) {
          this.collaboration.tick();
          for (const row of this.collaboration.output.ready(20, "internal")) {
            const target = this.collaboration.messages.records.targetedEffect(
              "outbox",
              row.id,
            ).target;
            if (
              this.collaboration.messages.references.conversation(target.conversationId)
                .authority === "internal"
            )
              await this.collaboration.output.send(row.id);
          }
          this.collaboration.activateDelegations();
          if (!this.privileged)
            this.privileged = this.system
              .dispatchApproved()
              .catch(() => {
                this.log.error({}, "Privileged execution dispatch failed; durable state retained");
              })
              .finally(() => {
                delete this.privileged;
              });
          if (!this.background)
            this.background = this.flushExternal().finally(() => {
              delete this.background;
            });
          if (!this.paused && !this.stopping)
            for (const agent of this.collaboration.agents.list()) {
              const run = this.supervisor.step(agent.id).catch(() => {
                this.log.error({ agentId: agent.id }, "Agent scheduling failed");
              });
              this.runs.add(run);
              void run.then(() => this.runs.delete(run));
            }
        }
      } catch {
        this.log.error({}, "Daemon tick failed; durable state retained");
      }
      if (!this.stopping)
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            this.abort.signal.removeEventListener("abort", wake);
            resolve();
          };
          const timer = setTimeout(wake, 500);
          this.abort.signal.addEventListener("abort", wake, { once: true });
        });
    }
  }
  close(): Promise<void> {
    return (this.closePromise ??= this.shutdown());
  }
  /**
   * Shutdown of this entry: stop accepting new work, run the application's ordered close, then
   * release the database and finally the single-instance lock. A step that never settles keeps
   * the database open on purpose; releasing it while owned work is still live would break the
   * durability guarantee this order protects.
   */
  private async shutdown(): Promise<void> {
    const failures: unknown[] = [];
    // The loop stops polling and ticking before anything else can wait.
    this.stopping = true;
    this.abort.abort();
    try {
      await this.application.close({
        stopIntake: () => this.adapter?.close(),
        settleOwnedWork: async () => {
          await this.opening?.catch(() => {});
          await this.loopPromise;
          await this.background;
          await this.privileged;
          await Promise.allSettled([...this.runs]);
        },
      });
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        this.store.close();
      } finally {
        this.release();
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Daemon cleanup failed after draining owned work");
  }
}
