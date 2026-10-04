import type Database from "better-sqlite3";
import type { OwnerChat } from "../../conversations/service.js";
import { NodeDirectory } from "../../nodes/directory.js";
import type { ModelCredentialDirectory } from "../../providers/credentials.js";
import { AgentLoop, type AgentLoopTestDependencies } from "../loop.js";
import { AgentProcessOperationBroker } from "../processes/operations.js";
import { AgentSession } from "../session/service.js";
import type { AgentTools } from "../tools/registry.js";
import { RunControl } from "./control.js";
import { RunRecords, type RunCandidate } from "./records.js";

const schedulerIntervalMs = 250;
// One scheduler pass remains bounded; later passes continue announcing arrivals.
const maxNoticesPerPass = 100;
/** Durable owner-channel run admission and the single primary run path for each Agent. */
export class AgentRunCoordinator {
  private readonly activeAgents = new Map<
    string,
    { runId: string; nodeId: string; provider: string; loop: AgentLoop }
  >();
  /** Deliveries already announced to their run: delivery id to the run that was told. */
  private readonly noticedDeliveries = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private draining = false;
  private closed = false;
  private readonly records: RunRecords;
  private readonly control: RunControl;

  constructor(
    private readonly db: Database.Database,
    private readonly nodes: NodeDirectory,
    private readonly credentials: ModelCredentialDirectory,
    private readonly chat: OwnerChat,
    private readonly tools: AgentTools,
    readonly processOperations: AgentProcessOperationBroker,
    now: () => number = Date.now,
    private readonly testDependencies: AgentLoopTestDependencies = {},
  ) {
    this.records = new RunRecords(db, chat, now);
    this.control = new RunControl(db, nodes, now, () => this.closed);
  }

  /** Begin recovery, node callbacks and scheduling after all services are assembled. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.records.recoverInterruptedRuns();
    this.nodes.setProcessReceiptHandler(
      (nodeId, receipt) => {
        if (this.control.reconcileStop(nodeId, receipt)) return;
        const outcome = this.processOperations.reconcile(
          nodeId,
          receipt,
          (agentId, operationId, state) =>
            this.chat.notifyAgentReceiptCorrection(agentId, operationId, state),
        );
        if (outcome.corrected) this.wake();
        if (this.nodes.list().some((node) => node.id === nodeId && node.online))
          void this.control.dispatchPendingStops("settled_receipts");
      },
      () => {
        this.control.activateEnabledAgents();
        this.wake();
        void this.control.dispatchPendingStops("node_ready");
      },
    );
    this.nodes.setOfflineHandler((nodeId) => {
      for (const [agentId, active] of this.activeAgents) {
        if (active.nodeId !== nodeId) continue;
        this.records.finishRun(active.runId, agentId, false, "node_disconnected");
        this.cancelRun(active.runId, agentId);
      }
    });
    this.timer = setInterval(() => this.wake(), schedulerIntervalMs);
    this.timer.unref?.();
    this.wake();
  }

  close(): void {
    // A failed durable update must still allow a later close to finish cancelling runs.
    this.closed = true;
    clearInterval(this.timer);
    for (const [agentId, active] of this.activeAgents) {
      this.records.finishRun(active.runId, agentId, false, "aborted");
      this.cancelRun(active.runId, agentId);
    }
  }

  wake(): void {
    if (this.started && !this.closed) {
      void this.drain();
      void this.control.dispatchPendingStops("settled_receipts");
    }
  }

  credentialsChanged(provider: string, ready: boolean): number {
    this.records.credentialsChanged(provider, ready);
    const running = [...this.activeAgents].filter(([, run]) => run.provider === provider);
    for (const [agentId, run] of running) {
      this.records.invalidateRun(run.runId, agentId);
      this.cancelRun(run.runId, agentId);
    }
    return running.length;
  }

  modelChanged(agentId: string): void {
    this.records.modelChanged(agentId);
    this.wake();
  }

  pauseAgent(agentId: string): boolean {
    const paused = this.control.pauseAgent(agentId);
    if (!paused) return false;
    if (paused.runId) this.cancelRun(paused.runId, agentId);
    if (paused.stopId) void this.control.dispatchStop(paused.stopId, agentId, paused.nodeId);
    return true;
  }
  stopStatus(agentId: string): ReturnType<RunControl["stopStatus"]> {
    return this.control.stopStatus(agentId);
  }
  pauseReason(agentId: string): ReturnType<RunControl["pauseReason"]> {
    return this.control.pauseReason(agentId);
  }
  resumeAgent(agentId: string): ReturnType<RunControl["resumeAgent"]> {
    return this.control.resumeAgent(agentId, () => this.wake());
  }

  private async drain(): Promise<void> {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      this.chat.fireDueReminders();
      this.notifyBusyRuns();
      const onlineNodeIds = this.nodes
        .list()
        .filter((node) => node.online)
        .map((node) => node.id);
      for (const candidate of this.records.pendingCandidates(onlineNodeIds)) {
        if (this.closed) return;
        if (this.activeAgents.has(candidate.agent_id)) continue;
        const apiKey = this.credentials.readForRun(candidate.provider);
        if (!apiKey) continue;
        const runId = this.records.beginRun(candidate);
        if (!runId) continue;
        const loop = new AgentLoop(),
          active = { runId, nodeId: candidate.node_id, provider: candidate.provider, loop };
        this.activeAgents.set(candidate.agent_id, active);
        void this.advance(candidate, active, apiKey).finally(() => {
          if (this.activeAgents.get(candidate.agent_id) === active) {
            // Heartbeat age may invalidate current() before the directory's offline sweep runs.
            // End any still-owned durable run before releasing the admission slot.
            this.records.finishRun(active.runId, candidate.agent_id, false, "node_disconnected");
            active.loop.cancel();
            this.activeAgents.delete(candidate.agent_id);
          }
          if (!this.closed) this.wake();
        });
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Tell each run that is still in progress that a message arrived after its context boundary.
   *
   * The notice is content-free and changes no state: the delivery stays pending, and only an
   * explicit tool call by the run reads, defers or ignores it. Notices are remembered per running
   * run so one arrival is announced once; the memory dies with the run, and a run that ends before
   * its notice is sent leaves the delivery for the next run of the same session.
   *
   * The eligibility rule mirrors `pendingCandidates`: a conversation the scheduler would refuse to
   * run — an archived channel, unless the message is a reminder — is never worth announcing.
   */
  private notifyBusyRuns(): void {
    const running = new Set(
      this.db
        .prepare<
          unknown[],
          {
            id: string;
          }
        >("SELECT id FROM owner_agent_runs WHERE state='running'")
        .all()
        .map((row) => row.id),
    );
    for (const [deliveryId, runId] of this.noticedDeliveries)
      if (!running.has(runId)) this.noticedDeliveries.delete(deliveryId);
    if (running.size === 0) return;
    // A delivery already announced stays pending until its run covers it, so it has to be excluded
    // in SQL: a pass limit applied before the skip would let a burst wider than the limit starve
    // the arrivals behind it.
    const announced = [...this.noticedDeliveries.keys()],
      announcedPlaceholders = announced.map(() => "?").join(",");
    const arrivals = this.db
      .prepare<
        unknown[],
        {
          run_id: string;
          node_id: string;
          agent_id: string;
          delivery_id: string;
          channel_id: string;
        }
      >(
        `SELECT r.id AS run_id,r.node_id,r.agent_id,d.id AS delivery_id,d.channel_id
         FROM owner_agent_runs r
         JOIN owner_message_deliveries d
           ON d.recipient_kind='agent' AND d.recipient_id=r.agent_id
         JOIN owner_messages m ON m.id=d.message_id
         JOIN owner_channels c ON c.id=d.channel_id
         WHERE r.state='running' AND d.state='pending' AND d.seq>r.context_history_end_seq
           AND (c.archived=0 OR m.internal_kind='reminder')
           ${announced.length ? `AND d.id NOT IN (${announcedPlaceholders})` : ""}
         ORDER BY d.seq LIMIT ${maxNoticesPerPass}`,
      )
      .all(...announced);
    for (const arrival of arrivals)
      if (this.noticeRun(arrival.run_id, arrival.agent_id, arrival.channel_id))
        this.noticedDeliveries.set(arrival.delivery_id, arrival.run_id);
  }

  private cancelRun(runId: string, agentId: string): void {
    const active = this.activeAgents.get(agentId);
    if (active?.runId !== runId) return;
    this.activeAgents.delete(agentId);
    active.loop.cancel();
  }

  private noticeRun(runId: string, agentId: string, conversationId: string): boolean {
    const active = this.activeAgents.get(agentId);
    if (active?.runId !== runId) return false;
    active.loop.notice(conversationId);
    return true;
  }

  private current(runId: string, candidate: RunCandidate): boolean {
    return (
      !this.closed &&
      this.activeAgents.get(candidate.agent_id)?.runId === runId &&
      this.nodes.list().some((node) => node.id === candidate.node_id && node.online) &&
      this.records.current(runId, candidate.agent_id)
    );
  }

  private async advance(
    candidate: RunCandidate,
    active: { runId: string; loop: AgentLoop },
    apiKey: string,
  ): Promise<void> {
    try {
      await this.testDependencies.beforeRunStart?.(active.runId);
      if (!this.current(active.runId, candidate)) return;
      const verification = await this.control.verifyExecutionEnvironment(
        candidate.agent_id,
        candidate,
      );
      if (!this.current(active.runId, candidate)) return;
      if (!verification.ok) {
        this.records.finishRun(
          active.runId,
          candidate.agent_id,
          false,
          "execution_environment",
          verification.error,
        );
        return;
      }
      const messages = this.records.readRunContext(active.runId, candidate.agent_id);
      if (!messages) throw new Error("Run context is unavailable");
      const result = await active.loop.run(
        {
          sessionId: candidate.session_id,
          actionScopeId: candidate.delivery_id,
          messages,
          prompt: {
            name: candidate.name,
            role: candidate.role,
            description: candidate.description,
          },
          provider: candidate.provider,
          modelId: candidate.model_id,
          apiKey,
        },
        () => this.current(active.runId, candidate),
        (entry) =>
          new AgentSession(this.db).append(
            active.runId,
            candidate.node_id,
            candidate.agent_id,
            entry,
          ),
        (toolCallId, operation, input) =>
          Promise.resolve(
            this.tools.execute(
              {
                runId: active.runId,
                nodeId: candidate.node_id,
                agentId: candidate.agent_id,
                toolCallId,
              },
              operation,
              input,
            ),
          ),
        this.testDependencies,
      );
      await this.testDependencies.beforeRunFinish?.();
      if (this.current(active.runId, candidate))
        this.records.finishRun(
          active.runId,
          candidate.agent_id,
          result.ok,
          result.ok ? undefined : result.code,
          result.ok ? undefined : result.reason,
        );
    } catch {
      if (this.current(active.runId, candidate))
        this.records.finishRun(active.runId, candidate.agent_id, false, "model_failed");
    }
  }
}
