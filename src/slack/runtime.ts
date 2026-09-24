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
/** One installation's connection, kept next to the readiness this runtime reports for it. */
interface Installation extends SlackInstallationReadiness {
  connecting?: Promise<void> | undefined;
  socket?: SocketTransport;
  app?: App;
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
  private readonly pending = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly backoff: { baseMs: number; maxMs: number };
  private stopped = false;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private cleanup?: Promise<void>;
  private nextReconcile = 0;
  private nextMembership = Date.now() + 300000;
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
    this.publishReadiness();
    this.advance(progress);
  }
  /** Start a connection attempt for every installation that is due for one. */
  private advance(progress?: () => void): void {
    if (this.stopped) return;
    for (const installation of this.installations.values()) {
      if (installation.connecting || installation.state === "ready") continue;
      // An installation that needs an operator keeps that state until Mate restarts; retrying a
      // revoked or under-scoped token forever would report hope instead of the action required.
      if (installation.state === "needs-human") continue;
      if ((installation.nextAttemptAt ?? 0) > this.now()) continue;
      const attempt = this.attempt(installation, progress);
      this.pending.add(attempt);
      void attempt.finally(() => this.pending.delete(attempt));
    }
  }
  private async attempt(installation: Installation, progress?: () => void): Promise<void> {
    if (this.stopped || installation.connecting) return;
    installation.attempts += 1;
    this.transition(installation, { state: "connecting", reason: "connecting" });
    const running = this.connect(installation, progress);
    installation.connecting = running;
    try {
      await running;
      if (this.stopped) return;
      this.transition(installation, { state: "ready", reason: "connected" });
    } catch (error) {
      if (this.stopped) return;
      const failure =
        error instanceof SlackOperatorActionError
          ? error.failure
          : classifySlackFailure(error, installation.agentId);
      // A credential or permission problem replaces the socket with the action a human owes;
      // a temporary failure keeps a live socket and waits for the next attempt.
      if (failure.state === "needs-human") {
        await this.release(installation);
        this.report(
          `Slack installation ${installation.agentId} needs an operator: ${failure.reason}`,
        );
        this.transition(installation, {
          state: "needs-human",
          reason: failure.reason,
          ...(failure.action ? { action: failure.action } : {}),
        });
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
  /** The complete readiness of one installation: identity, membership and history catch-up. */
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
    const scope = [agent];
    await this.service.discoverMembership(true, progress, scope);
    if (this.stopped) return;
    await this.service.membership(true, progress, scope);
    if (this.stopped) return;
    if (!(await this.service.catchUp(true, progress, scope)))
      throw new Error("Slack history recovery did not complete");
    if (this.stopped) return;
    if (!(await this.projections.catchUp(progress, new Set([agent.id]))))
      throw new Error("Slack projection history recovery did not complete");
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
      () => this.report("Slack receiver error; uncommitted events are not acknowledged"),
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
      await this.release(installation);
      throw error;
    }
  }
  /** A dropped socket is a temporary condition: report it and reconnect on the retry schedule. */
  private disconnected(agentId: string): void {
    const installation = this.installations.get(agentId);
    if (this.stopped || !installation) return;
    this.service.recordTransportGap(agentId);
    this.nextMembership = 0;
    const released = this.release(installation);
    const waiting = released.then(() => {
      if (this.stopped || this.installations.get(agentId) !== installation) return;
      this.transition(installation, {
        state: "waiting",
        reason: "transport_gap",
        nextAttemptAt: this.now() + this.retryDelay(installation),
      });
    });
    this.pending.add(waiting);
    void waiting.finally(() => this.pending.delete(waiting));
  }
  private async release(installation: Installation): Promise<void> {
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
  /** The current readiness of every installation, without the connection resources behind it. */
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
    };
  }
  /** Readiness is a report: failing to persist it never stops the connection state machine. */
  private publishReadiness(): void {
    const readiness = this.snapshot();
    this.transport.setReadiness(readiness);
    try {
      recordSlackReadiness(this.c.store, readiness);
    } catch {
      this.report("Slack readiness could not be recorded; the connection state is unaffected");
    }
    this.options.onReadiness?.(readiness);
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
      // Every daemon tick is a chance to retry a pending connection on its own schedule.
      this.advance();
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
    if (!this.stopped && Date.now() >= this.nextMembership) {
      this.nextMembership = Date.now() + 300000;
      const scope = this.transport.mapper.config.agents.filter((agent) =>
        this.transport.readyFor(agent.id),
      );
      if (!scope.length) return;
      await this.service.discoverMembership(false, undefined, scope);
      if (this.stopped) return;
      await this.service.membership(false, undefined, scope);
      if (this.stopped) return;
      await this.service.catchUp(false, undefined, scope);
      if (this.stopped) return;
      await this.projections.catchUp(undefined, publishers);
      if (this.stopped) return;
    }
  }
  private stopResources(): Promise<void> {
    this.stopped = true;
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
