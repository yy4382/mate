import { slackControlCommand, slackWireEvents } from "./capabilities.js";
import { App } from "@slack/bolt";
import { ManagedSocket } from "./socket.js";
import { DurableReceiver, type SocketTransport } from "./receiver.js";
import { SlackProjectionInput, SlackProjectionTransport } from "./projections.js";
import { SlackProjectionService } from "./projection-service.js";
import { CanonicalSlackNormalizer } from "./normalize.js";
import type { CanonicalSlackTransport } from "./transport.js";
import { Projections } from "../conversations/projections.js";
import { ProjectionImports } from "../conversations/projection-imports.js";
import { SlackService } from "../slack/service.js";
import { Ingress } from "../daemon/ingress.js";
import {
  classifySlackFailure,
  missingCredentialFailure,
  recordSlackReadiness,
  SlackOperatorActionError,
  type SlackInstallationReadiness,
  type SlackReadiness,
  type SlackTargetReadiness,
} from "./readiness.js";
import type { Controls } from "../daemon/control.js";
import type { AdapterLifecycle, AdapterReadiness } from "../daemon/adapter.js";
import type { Collaboration } from "../collaboration/service.js";
import type { AgentConfig as SlackInstallation } from "../config.js";
import { requireSecret } from "../config.js";
import type { SystemOperations } from "../policy/system-operations.js";

export interface SlackRuntimeOptions {
  /** Harness seam: the socket one connection attempt opens. A deployed Mate uses Socket Mode. */
  socket?: (agent: SlackInstallation) => SocketTransport;
  now?: () => number;
  /** How long to wait before the next automatic attempt after a temporary failure. */
  backoff?: { baseMs: number; maxMs: number };
  onReadiness?: (readiness: SlackReadiness) => void;
}
const defaultBackoff = { baseMs: 5000, maxMs: 300000 };
/** How long a verified target keeps its conditions before they are checked again. */
const defaultTargetIntervalMs = 300000;
/** One installation's connection, kept next to the readiness this runtime reports for it. */
interface Installation extends SlackInstallationReadiness {
  connecting?: Promise<void> | undefined;
  syncing?: Promise<void> | undefined;
  socket?: SocketTransport;
  app?: App;
  /** Bumped whenever the connection this attempt is verifying is gone; see `disconnected`. */
  generation: number;
  /** Whether conversation discovery already succeeded on this connection. */
  discovered?: boolean;
  /** Failed discovery attempts since this connection, and when the next one is due. */
  discoveryAttempts?: number;
  nextDiscoveryAt?: number;
}
/**
 * One external target's own platform conditions, tracked while this runtime is connected. A target
 * that is not ready only holds the work that names it; the installation's other targets and every
 * internal conversation keep running.
 */
interface Target extends SlackTargetReadiness {
  /** The external Slack channel these conditions describe. */
  channel: string;
  /** The projection binding this conversation presents; absent for a plain channel or DM. */
  projectionId?: string | undefined;
  /** Set until this connection caught the target up, so its recovery scans offline replies fully. */
  fresh: boolean;
  nextAttemptAt: number;
  attempts: number;
}

/**
 * Slack owns sockets, replay, HTTP maintenance and projections, not Agent scheduling. Starting
 * this adapter registers the local recovery work and lets the connection attempts run in the
 * background: the daemon is running as soon as its own startup finishes, and every Slack-dependent
 * operation waits for the readiness of its own installation instead of failing the process.
 */
export class SlackRuntime implements AdapterLifecycle {
  readonly service: SlackService;
  readonly projections: SlackProjectionService;
  private readonly installations: Map<string, Installation>;
  private readonly tracked = new Map<string, Target>();
  private readonly pending = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly backoff: { baseMs: number; maxMs: number };
  private stopped = false;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private cleanup?: Promise<void>;
  private nextReconcile = 0;
  constructor(
    readonly c: Collaboration,
    readonly transport: CanonicalSlackTransport,
    controls: Controls,
    readonly report: (message: string) => void,
    system?: SystemOperations,
    private readonly options: SlackRuntimeOptions = {},
  ) {
    const projections = new Projections(
      c.messages,
      new Map([["slack", new SlackProjectionTransport(transport)]]),
    );
    const imports = new ProjectionImports(c, projections),
      input = new SlackProjectionInput(projections, imports, transport);
    this.projections = new SlackProjectionService(projections, imports, input, transport);
    const ingress = new Ingress(
      c,
      new CanonicalSlackNormalizer(c.messages, transport.mapper, c.output, input),
    );
    this.service = new SlackService(c, transport, ingress, controls, () => this.stopped, system);
    this.now = options.now ?? Date.now;
    this.backoff = options.backoff ?? defaultBackoff;
    this.installations = new Map(
      transport.mapper.config.agents.map((agent) => [
        agent.id,
        {
          agentId: agent.id,
          state: "connecting" as const,
          reason: "starting",
          attempts: 0,
          changedAt: this.now(),
          generation: 0,
        },
      ]),
    );
  }
  private agent(agentId: string): SlackInstallation {
    const agent = this.transport.mapper.config.agents.find((item) => item.id === agentId);
    if (!agent) throw new Error(`Unknown Slack installation: ${agentId}`);
    return agent;
  }
  recover(): void {
    this.projections.core.recover();
  }
  /**
   * Start serving without waiting for a connection or for history catch-up: the daemon schedules
   * internal work now, and each installation becomes ready on its own.
   */
  start(signal: AbortSignal, progress?: () => void): Promise<void> {
    return (this.opening ??= this.begin(signal, progress));
  }
  private async begin(signal: AbortSignal, progress?: () => void): Promise<void> {
    const abort = () => {
      void this.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    signal.throwIfAborted();
    if (this.stopped) throw new Error("Slack adapter closed");
    // The only work startup owes locally: publish unconfirmed owner replies and the first
    // responsibility watermark. Everything that needs the platform happens in the background.
    this.service.bootstrapRecovery();
    // The targets are known locally before any connection: work that names one of them waits for
    // its conditions instead of crossing the boundary on a permission nothing confirmed yet.
    for (const installation of this.installations.values()) this.trackTargets(installation.agentId);
    this.publishReadiness();
    this.startDueAttempts(progress);
  }
  /**
   * Keep background work for close(), and handle a rejection no in-attempt handler expected: an
   * unhandled rejection ends the daemon process on this Node version, which is exactly the
   * process-wide outage a per-installation failure must not cause.
   */
  private track(work: Promise<void>): void {
    this.pending.add(work);
    void work.then(
      () => this.pending.delete(work),
      () => {
        this.pending.delete(work);
        // Reported, never rethrown: the installation keeps whatever schedule it already has.
        this.notice("Slack background work failed; the installation keeps its own retry schedule");
      },
    );
  }
  /** Operator-facing notice. A logger that throws must not change the connection state machine. */
  private notice(message: string): void {
    try {
      this.report(message);
    } catch {
      /* The readiness record still carries this state. */
    }
  }
  /** Start a connection attempt for every installation that is due for one. */
  private startDueAttempts(progress?: () => void): void {
    if (this.stopped) return;
    for (const installation of this.installations.values()) {
      if (installation.connecting || installation.state === "ready") continue;
      // An installation that needs an operator keeps that state until Mate restarts; retrying a
      // revoked or under-scoped token forever would report hope instead of the action required.
      if (installation.state === "needs-human") continue;
      if ((installation.nextAttemptAt ?? 0) > this.now()) continue;
      this.track(this.attempt(installation, progress));
    }
  }
  private async attempt(installation: Installation, progress?: () => void): Promise<void> {
    if (this.stopped || installation.connecting) return;
    const generation = installation.generation;
    installation.attempts += 1;
    this.transition(installation, { state: "connecting", reason: "connecting" });
    const running = this.connect(installation, progress);
    installation.connecting = running;
    try {
      await running;
      // The connection this attempt verified may have dropped while it finished; the dropped
      // socket already scheduled its own attempt, so claiming ready here would strand it.
      if (this.stopped || installation.generation !== generation) return;
      // A fresh, complete connection starts its retry schedule from the base wait again.
      installation.attempts = 0;
      this.transition(installation, { state: "ready", reason: "connected" });
      // The connection is this installation's own condition; every target's platform facts are
      // confirmed next, each on its own, so the daemon and the other targets are not held back.
      this.syncTargets(installation, progress);
    } catch (error) {
      if (this.stopped) return;
      const failure =
        error instanceof SlackOperatorActionError
          ? error.failure
          : classifySlackFailure(error, installation.agentId);
      // A credential or permission problem replaces the socket with the action a human owes;
      // a temporary failure keeps a live socket and waits for the next attempt.
      if (failure.state === "needs-human") {
        await this.closeConnection(installation);
        // The state and its wait schedule are recorded before the notice, so a failing reporter
        // cannot leave this installation retrying every tick without an operator action.
        this.transition(installation, {
          state: "needs-human",
          reason: failure.reason,
          ...(failure.action ? { action: failure.action } : {}),
        });
        this.notice(
          `Slack installation ${installation.agentId} needs an operator: ${failure.reason}`,
        );
      } else {
        this.transition(installation, {
          state: "waiting",
          reason: failure.reason,
          nextAttemptAt: this.now() + this.retryDelay(installation, failure.retryAfterMs),
        });
      }
    } finally {
      installation.connecting = undefined;
    }
  }
  /** The wait between attempts grows with each failure and stays under the configured cap. */
  private retryDelay(installation: Installation, retryAfterMs?: number): number {
    const grown = this.backoff.baseMs * 2 ** Math.max(0, installation.attempts - 1);
    return Math.min(this.backoff.maxMs, Math.max(grown, retryAfterMs ?? 0));
  }
  /**
   * The installation's own conditions: its connection and its verified identity. Membership,
   * history and projections belong to single targets and are confirmed for each of them
   * afterwards, so one unfinished channel never keeps the whole installation out of service.
   */
  private async connect(installation: Installation, progress?: () => void): Promise<void> {
    const agent = this.agent(installation.agentId),
      missing = [agent.botTokenEnv, agent.appTokenEnv].filter(
        (reference) => !process.env[reference]?.trim(),
      );
    if (missing.length)
      throw new SlackOperatorActionError(missingCredentialFailure(installation.agentId, missing));
    // The token exists in the environment but this process never built its client.
    if (!this.transport.clients.has(agent.id))
      throw new SlackOperatorActionError(
        missingCredentialFailure(installation.agentId, [agent.botTokenEnv]),
      );
    if (!installation.app) await this.openConnection(installation, agent);
    if (this.stopped) return;
    await this.service.verifyAgent(agent);
    if (this.stopped) return;
    // A fresh connection has not confirmed any target's platform facts yet, including the
    // permissions cached by the previous one.
    installation.discovered = false;
    installation.discoveryAttempts = 0;
    delete installation.nextDiscoveryAt;
    this.trackTargets(agent.id, true);
  }
  /**
   * The platform facts of every target this installation acts on. Discovery, membership and
   * history coverage are attempted per target and on their own schedule; a target that is not
   * ready waits in its own record instead of failing the connection or the other targets.
   */
  private syncTargets(installation: Installation, progress?: () => void): void {
    if (this.stopped || installation.state !== "ready" || installation.syncing) return;
    const work = this.sync(installation, progress);
    installation.syncing = work;
    this.pending.add(work);
    void work.finally(() => {
      this.pending.delete(work);
      if (installation.syncing === work) delete installation.syncing;
    });
  }
  private async sync(installation: Installation, progress?: () => void): Promise<void> {
    const agent = this.agent(installation.agentId),
      // The watermark may only name the moment this pass started: a message that arrives while it
      // runs must not be skipped by the next scan.
      started = this.now();
    try {
      if (!installation.discovered && (installation.nextDiscoveryAt ?? 0) <= this.now()) {
        // Discovery is the connection's own platform read; an incomplete catalog leaves the
        // targets it did not cover unconfirmed instead of failing the installation, and a failed
        // attempt waits on its own growing schedule instead of repeating on every daemon tick.
        try {
          installation.discovered = await this.service.discoverMembership(false, progress, [agent]);
        } catch (error) {
          this.notice(`Slack conversation discovery of ${agent.id} failed: ${String(error)}`);
        }
        if (installation.discovered) {
          installation.discoveryAttempts = 0;
          delete installation.nextDiscoveryAt;
        } else {
          installation.discoveryAttempts = (installation.discoveryAttempts ?? 0) + 1;
          installation.nextDiscoveryAt =
            this.now() + this.grownDelay(installation.discoveryAttempts);
        }
      }
      // A conversation invited, opened or projected since the last check becomes a target here,
      // unconfirmed until its own permission and coverage are established.
      this.trackTargets(agent.id);
      const due = [...this.tracked.values()].filter(
        (target) => target.agentId === agent.id && target.nextAttemptAt <= this.now(),
      );
      for (const target of due) {
        if (this.stopped) return;
        try {
          await this.verifyTarget(agent, target, progress);
        } catch (error) {
          // One target's failure is that target's own fact: the others in this pass still run,
          // and this one waits on its own growing schedule instead of every tick.
          if (this.stopped) return;
          this.notice(
            `Slack target ${target.conversationId} of ${agent.id} could not be verified: ${String(error)}`,
          );
          target.history = "pending";
          target.reason = "verification_failed";
          target.nextAttemptAt = this.now() + this.targetRetryDelay(target);
          this.publishReadiness();
        }
      }
      // The responsibility watermark only moves once the whole installation caught up, so a
      // channel that has not been recovered yet is never skipped by a later scan.
      if (this.allCaughtUp(agent.id)) this.advanceWatermark(agent.id, started);
    } catch (error) {
      if (this.stopped) return;
      this.notice(`Slack target verification of ${agent.id} failed: ${String(error)}`);
      for (const target of this.tracked.values())
        if (target.agentId === agent.id && target.permission === "unconfirmed")
          target.nextAttemptAt = this.now() + this.targetRetryDelay(target);
      this.publishReadiness();
    }
  }
  /** Confirms one target's permission and local coverage, and schedules its next check. */
  private async verifyTarget(
    agent: SlackInstallation,
    target: Target,
    progress?: () => void,
  ): Promise<void> {
    target.attempts += 1;
    // While the platform answer is outstanding this permission is pending again: nothing may
    // cross on the cached grant, and a queued publication keeps waiting instead of failing.
    target.permission = "unconfirmed";
    target.reason = "checking_permission";
    this.publishReadiness();
    const permission = await this.service.confirmMembership(
      agent,
      target.channel,
      target.projectionId ? target.conversationId : undefined,
    );
    if (this.stopped) return;
    target.changedAt = this.now();
    if (permission === "denied") {
      // The platform stated this Agent is not a member: an operation naming this target is a
      // definite access answer, not a wait, and the target is re-checked on the maintenance cadence.
      target.permission = "denied";
      target.history = "pending";
      target.reason = "not_a_member";
      target.nextAttemptAt = this.now() + defaultTargetIntervalMs;
      this.publishReadiness();
      return;
    }
    if (permission !== "confirmed") {
      target.permission = "unconfirmed";
      target.reason =
        permission === "superseded" ? "membership_changed_during_check" : "membership_unconfirmed";
      target.nextAttemptAt = this.now() + this.targetRetryDelay(target);
      this.publishReadiness();
      return;
    }
    target.permission = "confirmed";
    let covered: boolean,
      // Only a failed old-thread scan needs the unbounded pass again; a completed one resumes from
      // its durable page cursor.
      scanned = true;
    if (target.projectionId)
      covered = await this.projections.catchUpBinding(target.projectionId, progress);
    else {
      const outcome = await this.service.recoverChannel(agent, target.conversationId, {
        // A target this connection has not caught up yet may have missed replies in old threads.
        forceFullOldThreads: target.fresh,
        progress,
      });
      covered = outcome === "complete";
      scanned = outcome !== "incomplete_threads";
    }
    if (this.stopped) return;
    if (scanned) target.fresh = false;
    target.history = covered ? "complete" : "pending";
    target.reason = covered ? "connected" : "history_incomplete";
    target.changedAt = this.now();
    if (covered) {
      target.attempts = 0;
      target.nextAttemptAt = this.now() + defaultTargetIntervalMs;
    } else target.nextAttemptAt = this.now() + this.targetRetryDelay(target);
    this.publishReadiness();
  }
  /** Whether every target of one installation is confirmed and its history caught up. */
  private allCaughtUp(agentId: string): boolean {
    const targets = [...this.tracked.values()].filter(
      // A denied target is a definite platform answer, not coverage this installation still owes.
      (target) => target.agentId === agentId && target.permission !== "denied",
    );
    return (
      targets.length > 0 &&
      targets.every((target) => target.permission === "confirmed" && target.history === "complete")
    );
  }
  /** The point this installation has fully recovered to, so unfetched older history stays bounded. */
  private advanceWatermark(agentId: string, at = this.now()): void {
    const watermark = `${Math.floor(at / 1000)}.000000`;
    this.transport.store.db
      .prepare(
        "INSERT INTO slack_cursors VALUES(?,?,?) ON CONFLICT(agent_id,channel) DO UPDATE SET ts=excluded.ts",
      )
      .run(agentId, "*", watermark);
  }
  /** The wait before one target's conditions are checked again; grows, and stays under the cap. */
  private targetRetryDelay(target: Target): number {
    return this.grownDelay(target.attempts);
  }
  /** The growing, capped wait after one failed attempt of any kind. */
  private grownDelay(attempts: number): number {
    return Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** Math.max(0, attempts - 1));
  }
  /**
   * Track every external target this installation acts on, keeping the conditions already
   * confirmed. `reset` marks all of them unconfirmed, which is what a fresh connection means.
   */
  private trackTargets(agentId: string, reset = false): void {
    const agent = this.agent(agentId),
      found = this.service.targets(agent),
      keep = new Set<string>();
    let changed = false;
    for (const entry of found) {
      // The platform channel is the target's identity: one room can be projected into several
      // channels, and each of those carries its own platform facts.
      const key = `${agentId}:${entry.channel}`;
      keep.add(key);
      const known = this.tracked.get(key);
      if (known && !reset) {
        if (known.channel !== entry.channel || known.projectionId !== entry.projectionId) {
          known.channel = entry.channel;
          known.projectionId = entry.projectionId;
          changed = true;
        }
        continue;
      }
      changed = true;
      this.tracked.set(key, {
        agentId,
        conversationId: entry.conversationId,
        channel: entry.channel,
        projectionId: entry.projectionId,
        permission: "unconfirmed",
        history: "pending",
        reason: reset ? "reconnected" : "connecting",
        fresh: true,
        changedAt: this.now(),
        nextAttemptAt: 0,
        attempts: 0,
      });
    }
    for (const key of [...this.tracked.keys()]) {
      const target = this.tracked.get(key)!;
      if (target.agentId === agentId && !keep.has(key)) {
        this.tracked.delete(key);
        changed = true;
      }
    }
    if (changed) this.publishReadiness();
  }
  /** Register the durable receiver and open this installation's socket. */
  private async openConnection(
    installation: Installation,
    agent: SlackInstallation,
  ): Promise<void> {
    const socket =
      this.options.socket?.(agent) ??
      new ManagedSocket(requireSecret(process.env, agent.appTokenEnv));
    socket.onDisconnect(() => {
      if (installation.socket === socket) this.disconnected(installation.agentId);
    });
    const receiver = new DurableReceiver(
      this.c.store,
      agent.slackAppId,
      this.transport.mapper.config.teamId,
      socket,
      () => this.notice("Slack receiver error; uncommitted events are not acknowledged"),
      () => this.service.replay(),
    );
    // Bolt's own token verification fires an auth.test whose rejection nobody awaits, which would
    // end the daemon process on exactly the revoked-credential case this runtime must report as an
    // operator action. The installation identity is verified here instead, with a handled error.
    const app = new App({
      token: requireSecret(process.env, agent.botTokenEnv),
      botId: agent.slackBotId,
      botUserId: agent.slackUserId,
      tokenVerificationEnabled: false,
      receiver,
    });
    // tests/deployment/diagnostics.test.ts asserts this registration text verbatim.
    // prettier-ignore
    for(const event of slackWireEvents)app.event(event,async()=>{});
    app.command(slackControlCommand, async () => {});
    app.action("mate_system_approve", async () => {});
    app.action("mate_system_reject", async () => {});
    installation.socket = socket;
    installation.app = app;
    try {
      await app.start();
    } catch (error) {
      await this.closeConnection(installation);
      throw error;
    }
  }
  /** A dropped socket is a temporary condition: report it and reconnect on the retry schedule. */
  private disconnected(agentId: string): void {
    const installation = this.installations.get(agentId);
    if (this.stopped || !installation) return;
    installation.generation += 1;
    this.service.recordTransportGap(agentId);
    // The gap invalidates every target's platform facts, including a permission cached before it.
    this.trackTargets(agentId, true);
    // Readiness stops claiming this installation is usable before the close is even awaited.
    this.transition(installation, {
      state: "waiting",
      reason: "transport_gap",
      nextAttemptAt: this.now() + this.retryDelay(installation),
    });
    this.track(this.closeConnection(installation));
  }
  private async closeConnection(installation: Installation): Promise<void> {
    const app = installation.app,
      socket = installation.socket;
    delete installation.app;
    delete installation.socket;
    try {
      await app?.stop();
    } catch {
      /* A socket already gone needs no second close. */
    }
    try {
      await socket?.disconnect();
    } catch {
      /* The transport reports its own close failures. */
    }
  }
  private transition(
    installation: Installation,
    next: {
      state: SlackInstallationReadiness["state"];
      reason: string;
      action?: string;
      nextAttemptAt?: number;
    },
  ): void {
    if (this.stopped) return;
    installation.state = next.state;
    installation.reason = next.reason;
    installation.changedAt = this.now();
    if (next.action) installation.action = next.action;
    else delete installation.action;
    if (next.nextAttemptAt === undefined) delete installation.nextAttemptAt;
    else installation.nextAttemptAt = next.nextAttemptAt;
    this.publishReadiness();
  }
  /**
   * The current readiness of every installation and of every target they act on, without the
   * connection resources behind it. This snapshot is what every caller reads before it crosses
   * the platform boundary.
   */
  private snapshot(): SlackReadiness {
    return {
      updatedAt: this.now(),
      installations: [...this.installations.values()].map((installation) => ({
        agentId: installation.agentId,
        state: installation.state,
        reason: installation.reason,
        ...(installation.action ? { action: installation.action } : {}),
        ...(installation.nextAttemptAt === undefined
          ? {}
          : { nextAttemptAt: installation.nextAttemptAt }),
        attempts: installation.attempts,
        changedAt: installation.changedAt,
      })),
      targets: [...this.tracked.values()].map((target) => ({
        agentId: target.agentId,
        channel: target.channel,
        conversationId: target.conversationId,
        permission: target.permission,
        history: target.history,
        reason: target.reason,
        changedAt: target.changedAt,
      })),
    };
  }
  /** Readiness is a report: failing to persist it never stops the connection state machine. */
  private publishReadiness(): void {
    const readiness = this.snapshot();
    this.transport.setReadiness(readiness);
    try {
      recordSlackReadiness(this.c.store, readiness);
    } catch {
      this.notice("Slack readiness could not be recorded; the connection state is unaffected");
    }
    try {
      this.options.onReadiness?.(readiness);
    } catch {
      this.notice("Slack readiness reporting failed; the connection state is unaffected");
    }
  }
  readiness(): AdapterReadiness {
    const { installations } = this.snapshot();
    return {
      ready: installations.every((installation) => installation.state === "ready"),
      installations,
    };
  }
  poll(): void {
    if (!this.stopped) {
      this.service.replay();
      this.projections.imports.replay();
      this.service.ingress.bindPeerEchoes();
      // Every daemon tick is a chance to retry a pending connection and every due target on
      // their own schedules.
      this.startDueAttempts();
      for (const installation of this.installations.values()) this.syncTargets(installation);
    }
  }
  async flush(): Promise<void> {
    if (this.stopped) return;
    // Only ready installations cross the boundary; the work of the others stays in its durable
    // record (message outbox, owner replies, approvals, projections) until it recovers.
    const ready = this.transport.readyAgents();
    if (!ready.length) return;
    const publishers = new Set(ready);
    await this.projections.core.flush();
    if (this.stopped) return;
    await this.service.flushAdmin();
    if (this.stopped) return;
    await this.service.flushApprovals();
    if (this.stopped) return;
    await this.service.flushResults();
    if (this.stopped) return;
    if (Date.now() >= this.nextReconcile) {
      this.nextReconcile = Date.now() + 60000;
      await this.service.reconcile();
      if (this.stopped) return;
      await this.projections.reconcile();
    }
    // Every ready installation checks the targets whose conditions are due again; a target that
    // is still unconfirmed waits in its own record rather than pausing the installation.
    for (const installation of this.installations.values())
      if (publishers.has(installation.agentId)) this.syncTargets(installation);
  }
  private stopResources(): Promise<void> {
    this.stopped = true;
    // Whatever the owner view reads next must not claim these installations are usable.
    for (const installation of this.installations.values()) {
      installation.state = "waiting";
      installation.reason = "mate_stopped";
      installation.changedAt = this.now();
      delete installation.action;
      delete installation.nextAttemptAt;
    }
    this.publishReadiness();
    this.transport.close();
    return (this.cleanup ??= Promise.allSettled(
      [...this.installations.values()].map((installation) =>
        Promise.resolve().then(() => installation.app?.stop()),
      ),
    ).then(() => {}));
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      await this.stopResources();
      // An attempt in flight writes durable state; it is awaited before the caller releases the
      // database. Every step it takes is bounded by the transport timeouts.
      await Promise.allSettled([...this.pending]);
      await this.opening?.catch(() => {});
    })());
  }
}
