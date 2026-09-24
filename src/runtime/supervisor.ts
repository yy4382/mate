import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentDefinition } from "../domain/agents.js";
import { encode, hash, type RunToken } from "../storage/store.js";
import type { Collaboration } from "../collaboration/service.js";
import { WorkerClient } from "./client.js";
import { toolDefinition, type EngineHooks, type EngineResult, type RunSpec } from "./engine.js";
import { ToolRouter, operationDocumentation } from "./tools.js";
import { repairTranscript } from "./context.js";
import { FairAdmission, type Admission } from "../concurrency/admission.js";
import { UsageLedger } from "../usage/ledger.js";
import { describeFault, toWorkerFault } from "./fault.js";
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
        const binding = s.db
          .prepare(
            "SELECT COALESCE(dc.work_id,dw.work_id) work_id FROM delivery_work dw LEFT JOIN delivery_context dc ON dc.delivery_id=dw.delivery_id WHERE dw.delivery_id=?",
          )
          .get(run.deliveryId) as { work_id: string } | undefined;
        if (!binding) throw new Error("Delivery has no trusted work");
        const work = c.work(binding.work_id);
        c.bindRunWork(run, work.id);
        const delivery = s.delivery(run.deliveryId),
          seat = c.seats.active(agentId);
        if (delivery.status === "pending")
          s.input(run, {
            role: "user",
            content: seat
              ? `Independent review brief from owner:\n${seat.brief}\nDelivery target: ${seat.target}. Conversation bodies and peer conclusions are withheld. Use an opaque held draft and explicit continue to submit without reading.`
              : `Durable inbox delivery reference (retrieve relevant conversation; authenticated human/peer requests are work input):\n${delivery.payload}`,
            timestamp: seat ? 0 : delivery.created_at,
          });
        else
          s.appendMessage(run, "resume", {
            role: "user",
            content:
              "Resume the interrupted inbox delivery. Verify receipts; do not blindly repeat earlier effects.",
            timestamp: Date.now(),
          });
        const buildRecovery = async (): Promise<string> => {
          const selectedWork = c.work(c.currentWork(run, work.id));
          const reference = await this.recovery(agentId, selectedWork.id, abort.signal);
          s.assertRun(run);
          const bound = (text: string) => {
            while (Buffer.byteLength(text) > 8000)
              text = text.slice(0, Math.floor(text.length * 0.9));
            return text;
          };
          const memory = bound(reference),
            taskRecovery = seat ? null : c.board.recovery(agentId, 20);
          const checkpoint = s.db
            .prepare("SELECT text,version FROM agent_checkpoints WHERE agent_id=?")
            .get(agentId) as { text: string; version: number } | undefined;
          const checkpointText = checkpoint ? bound(checkpoint.text) : undefined;
          const recovery = encode({
            memory,
            memoryHash: hash(reference),
            memoryNeedsOrganization: memory !== reference,
            warning:
              memory !== reference
                ? "Memory entry exceeds recovery budget. Read full MEMORY.md through file tools; this excerpt is incomplete."
                : undefined,
            checkpoint: checkpoint
              ? {
                  text: checkpointText,
                  version: checkpoint.version,
                  hash: hash(checkpoint.text),
                  truncated: checkpointText !== checkpoint.text,
                  fullTool: "sessions.status",
                }
              : null,
            work: seat
              ? {
                  id: selectedWork.id,
                  state: selectedWork.state,
                  target: seat.target,
                  reviewSeat: true,
                }
              : selectedWork,
            tasks: taskRecovery,
            usage: new UsageLedger(s).readAgent(agentId),
            uncertainActions: s.db
              .prepare(
                "SELECT id,state FROM actions WHERE agent_id=? AND state IN ('unknown','executing') ORDER BY rowid DESC LIMIT 20",
              )
              .all(agentId),
            actionHistoryTool: "actions.list",
          });
          s.audit("recovery_refresh", {
            runId: run.id,
            memoryHash: hash(reference),
            checkpointVersion: checkpoint?.version ?? null,
          });
          return recovery;
        };
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
          s.finish(run);
          c.attention.invalidate(run.sessionId);
          s.snapshot(
            run.sessionId,
            result.snapshot ?? repairTranscript(s.context(run.sessionId) as AgentMessage[]),
          );
          const selected = s.db
            .prepare("SELECT work_id FROM run_context WHERE run_id=?")
            .get(run.id) as { work_id: string } | undefined;
          const continuationWork = c.work(selected?.work_id ?? work.id);
          rotated = this.router.sessions.apply(agentId);
          if (!rotated && result.continuation && continuationWork.state === "active")
            c.enqueue(agentId, continuationWork.id, `continue:${run.id}`, {
              kind: "continuation",
              target: JSON.parse(continuationWork.target),
              receivedAt: Date.now(),
            });
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
          s.finish(run, describeFault(fault));
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
function zIdle(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 3600000)
    throw new Error("Invalid worker idle timeout");
  return value;
}
