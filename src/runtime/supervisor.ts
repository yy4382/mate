import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentDefinition } from "../domain/agents.js";
import { encode, type RunToken } from "../storage/store.js";
import type { Collaboration } from "../collaboration/service.js";
import { WorkerClient } from "./client.js";
import { toolDefinition, type EngineHooks, type EngineResult, type RunSpec } from "./engine.js";
import { ToolRouter, operationDocumentation } from "./tools.js";
import { repairTranscript } from "./context.js";
import { FairAdmission, type Admission } from "../concurrency/admission.js";
import { UsageLedger } from "../usage/ledger.js";
import { describeFault, retryDisposition, toWorkerFault, type WorkerFault } from "./fault.js";
import type { RunStopReason } from "./outcome.js";
import { RunRecovery } from "./recovery.js";
export interface Worker {
  run(
    spec: RunSpec,
    hooks: EngineHooks,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<EngineResult>;
  close(): void;
}
export interface SupervisorResources {
  runAdmission?: Admission;
  workerIdleMs?: number;
}
/**
 * The scheduler for the one main run channel each Agent has.
 *
 * It owns run lifetime and nothing about what a run remembers: admission, binding a run to the
 * delivery it serves, aborting it, and recording why it ended. The recovery input a resumption
 * reads — private memory, the Agent's own checkpoint, tasks, usage and unresolved operations — is
 * built by the run module, so the scheduler never has to know what a resumption contains.
 */
export class Supervisor {
  private effects = new Set<Promise<unknown>>();
  private workers = new Map<string, Worker>();
  private active = new Map<string, { run: RunToken; abort: AbortController }>();
  private queued = new Map<string, AbortController>();
  private idle = new Map<string, NodeJS.Timeout>();
  private stopped = false;
  private closed = false;
  private readonly admission: Admission;
  private readonly workerIdleMs: number;
  /** The run module: recovery input construction, kept out of the scheduler's lifetime rules. */
  readonly runs: RunRecovery;
  constructor(
    readonly collaboration: Collaboration,
    readonly router: ToolRouter,
    readonly config: { runTimeoutMs: number },
    readonly factory: (agent: AgentDefinition) => Worker = (agent) =>
      new WorkerClient(
        agent.model.provider,
        agent.model.id,
        process.env[agent.model.apiKeyEnv] ?? "",
      ),
    readonly recovery: (
      agentId: string,
      workId: string,
      signal: AbortSignal,
    ) => Promise<string> = async () => "",
    resources: SupervisorResources = {},
  ) {
    this.admission = resources.runAdmission ?? new FairAdmission(32);
    this.workerIdleMs = zIdle(resources.workerIdleMs ?? 0);
    this.runs = new RunRecovery(collaboration, recovery);
  }
  register(): void {
    for (const agent of this.collaboration.agents.list()) {
      const baseline = this.router.sessions.baseline(agent);
      this.collaboration.store.register(agent.id, baseline.configVersion, baseline.messages);
    }
  }
  recoverSessions(): void {
    for (const agent of this.collaboration.agents.list())
      if (this.router.sessions.apply(agent.id)) {
        this.workers.get(agent.id)?.close();
        this.workers.delete(agent.id);
      }
  }
  async step(agentId: string): Promise<boolean> {
    if (this.stopped || this.closed || this.active.has(agentId) || this.queued.has(agentId))
      return false;
    const waiting = new AbortController();
    this.queued.set(agentId, waiting);
    let release: () => void;
    try {
      release = await this.admission.acquire(waiting.signal);
    } catch {
      return false;
    } finally {
      this.queued.delete(agentId);
    }
    try {
      if (waiting.signal.aborted) return false;
      const c = this.collaboration,
        s = c.store;
      const run = s.beginRun(agentId, Date.now(), true);
      if (!run) return false;
      this.clearIdle(agentId);
      const abort = waiting;
      this.active.set(agentId, { run, abort });
      let worker: Worker | undefined;
      try {
        const work = c.work(this.runs.boundWork(run));
        c.bindRunWork(run, work.id);
        // Present the delivery's input, or resume the input an earlier run of this same delivery
        // already received. What that says is the run module's decision, not the scheduler's.
        const { kind, message } = this.runs.resumption(run, s.stopReasonOf(agentId));
        if (kind === "input") s.input(run, message);
        else s.appendMessage(run, "resume", message);
        const buildRecovery = async (): Promise<string> => this.runs.build(run, abort.signal);
        const recovery = await buildRecovery();
        // Shutdown may have arrived while this run was preparing: never start a new worker
        // process after the application stopped advancing work.
        if (this.stopped || this.closed)
          throw new Error("Supervisor stopped while starting this run");
        const agent = this.collaboration.agents.get(agentId);
        worker = this.workers.get(agentId) ?? this.factory(agent);
        this.workers.set(agentId, worker);
        let seq = 0,
          lastNotice = "";
        const messages = repairTranscript(s.context(run.sessionId) as AgentMessage[], (id) => {
          const action = s.action(`${run.sessionId}:${id}`);
          return action
            ? encode({
                recoveredAction: action.id,
                state: action.state,
                receipt: action.receipt ? JSON.parse(action.receipt) : null,
                warning: "Historical receipt, not a new execution.",
              })
            : undefined;
        });
        s.audit("context_restore", {
          runId: run.id,
          sessionId: run.sessionId,
          memoryHash: JSON.parse(recovery).memoryHash,
          projectedMessages: messages.length,
        });
        const usage = new UsageLedger(s);
        const result = await worker.run(
          { sessionId: run.sessionId, messages, recovery, maxTurns: 8 },
          {
            usageBegin: async (index, provider, modelId) =>
              usage.begin(run, c.currentWork(run, work.id), index, provider, modelId),
            usageComplete: async (index, message) => usage.complete(run, index, message),
            refreshRecovery: buildRecovery,
            invalidateViews: async () => {
              s.assertRun(run);
              c.attention.invalidate(run.sessionId);
            },
            notice: async () => {
              s.assertRun(run);
              const notice = encode(c.attention.peek(agentId));
              if (notice === "[]" || notice === lastNotice) return;
              lastNotice = notice;
              return notice;
            },
            journal: async (message) => {
              s.atomic(() => {
                s.appendMessage(run, `message:${seq++}`, message);
                c.attention.presented(run, message);
              });
            },
            tool: async (id, operation, args) => {
              const effect = this.router.call(run, work.id, id, operation, args, abort.signal);
              this.effects.add(effect);
              try {
                return await effect;
              } finally {
                this.effects.delete(effect);
              }
            },
          },
          this.config.runTimeoutMs,
          abort.signal,
        );
        let rotated = false;
        s.atomic(() => {
          s.assertRun(run);
          // Whether this delivery was already finished before the run stopped decides the kind of
          // stop: a delivery this run replaced with a session reset is complete, while one it
          // never finished is a yield whose input stays durable for the next run of this channel.
          const handled = s.delivery(run.deliveryId).status === "handled",
            reason = this.reasonFor(result, handled);
          // The receipt is written before the run ends, so a run that gave up its execution slot
          // is recorded as a yield instead of as a failure or a human pause.
          s.finish(run, undefined, reason);
          c.attention.invalidate(run.sessionId);
          s.snapshot(
            run.sessionId,
            result.snapshot ?? repairTranscript(s.context(run.sessionId) as AgentMessage[]),
          );
          rotated = this.router.sessions.apply(agentId);
          // A run that finished its own delivery by replacing its context leaves one durable
          // continuation naming the work item it was last using. A yield needs no such row: the
          // unfinished delivery is itself the durable pointer back into this channel.
          if (!rotated && handled && result.continuation) {
            const selected = s.db
              .prepare("SELECT work_id FROM run_context WHERE run_id=?")
              .get(run.id) as { work_id: string } | undefined;
            const continuationWork = c.work(selected?.work_id ?? work.id);
            if (continuationWork.state === "active")
              c.enqueue(agentId, continuationWork.id, `continue:${run.id}`, {
                kind: "continuation",
                target: JSON.parse(continuationWork.target),
                receivedAt: Date.now(),
              });
          }
        });
        if (rotated) {
          worker.close();
          this.workers.delete(agentId);
        }
      } catch (error) {
        abort.abort();
        worker?.close();
        this.workers.delete(agentId);
        // A run that never reached the worker failed in this process; the run module reads the
        // shared fault instead of the message text to decide what happens next.
        const fault = toWorkerFault(error, "recovery");
        try {
          s.finish(run, describeFault(fault), "model_failure", pausesAgent(fault));
        } catch {
          /* already fenced by stop */
        }
        this.router.sessions.apply(agentId);
        s.audit("run_failure", { agentId, runId: run.id, fault });
      } finally {
        this.active.delete(agentId);
        this.scheduleIdle(agentId);
      }
      return true;
    } finally {
      release();
    }
  }
  /**
   * Why this run stopped, as the scheduler observed it. The scheduler records the fact; the run
   * module reads it back when the same delivery is resumed.
   */
  private reasonFor(result: EngineResult, deliveryHandled: boolean): RunStopReason {
    if (deliveryHandled) {
      // The delivery was already dealt with when this run's work ended — most often a context
      // replacement finished it — so this run completed its delivery rather than yielding it.
      return "complete";
    }
    if (!result.certain) {
      // A fault the worker reported as a result rather than as a thrown value still failed the run.
      return "model_failure";
    }
    // The run left work outstanding: either the model loop reached its own turn budget or a
    // context replacement, or a tool deliberately released the execution slot. The input stays
    // durable and the next run of this channel resumes the same delivery.
    return result.waiting || result.continuation ? "yielded" : "complete";
  }
  stopRuns(runIds: string[]): void {
    for (const { run, abort } of this.active.values()) if (runIds.includes(run.id)) abort.abort();
  }
  stopAgent(agentId: string): void {
    this.collaboration.store.pause(agentId);
    this.queued.get(agentId)?.abort();
    this.active.get(agentId)?.abort.abort();
    this.clearIdle(agentId);
    this.workers.get(agentId)?.close();
    this.workers.delete(agentId);
  }
  async drain(): Promise<void> {
    while (this.effects.size) await Promise.allSettled([...this.effects]);
  }
  /** Stop advancing business state: refuse new runs, then abort the queued and active ones. */
  stopAdvancing(): void {
    this.stopped = true;
    for (const abort of this.queued.values()) abort.abort();
    this.queued.clear();
    for (const { abort } of this.active.values()) abort.abort();
  }
  /** Collect local worker processes after their runs stopped advancing. */
  collectWorkers(): void {
    this.closed = true;
    for (const timer of this.idle.values()) clearTimeout(timer);
    this.idle.clear();
    for (const worker of this.workers.values()) worker.close();
    this.workers.clear();
  }
  close(): void {
    this.stopAdvancing();
    this.collectWorkers();
  }
  private clearIdle(agentId: string): void {
    const timer = this.idle.get(agentId);
    if (timer) clearTimeout(timer);
    this.idle.delete(agentId);
  }
  private scheduleIdle(agentId: string): void {
    if (!this.workerIdleMs || !this.workers.has(agentId)) return;
    this.clearIdle(agentId);
    const timer = setTimeout(() => {
      this.idle.delete(agentId);
      if (this.active.has(agentId) || this.queued.has(agentId)) return;
      this.workers.get(agentId)?.close();
      this.workers.delete(agentId);
    }, this.workerIdleMs);
    timer.unref();
    this.idle.set(agentId, timer);
  }
}
/**
 * Whether a failed run leaves its Agent paused.
 *
 * A failure that waits for something outside this Agent pauses its channel: a transient model
 * fault backs off, a credential or configuration problem needs a human, and an unconfirmed
 * external effect needs verification. A shared-persistence failure is different — the durable
 * record itself is the broken part, so the work that depends on it stops without pausing the
 * Agent as though a person had decided the question.
 */
function pausesAgent(fault: WorkerFault): boolean {
  const disposition = retryDisposition(fault);
  return (
    disposition === "human_action" ||
    disposition === "retry_backoff" ||
    disposition === "verify_effect"
  );
}
function zIdle(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 3600000)
    throw new Error("Invalid worker idle timeout");
  return value;
}
