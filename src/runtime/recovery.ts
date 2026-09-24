import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Collaboration } from "../collaboration/service.js";
import { encode, hash, type RunToken } from "../storage/store.js";
import { UsageLedger } from "../usage/ledger.js";
import type { WorkerFault } from "./fault.js";
import { isYield, type RunStopReason } from "./outcome.js";
import { resumeAction, type ResumeAction } from "./resume.js";

/**
 * The lifecycle of one resumption, as the run module sees it. A delivery that has not been
 * injected yet is new input; one that was already injected belongs to a run that stopped after
 * handing it to the model, so it resumes that same input instead of presenting it again.
 */
export interface DeliveryResumption {
  kind: "input" | "resume";
  /** The message turn handed to the model for this resumption. */
  message: AgentMessage;
}

/**
 * What a resumption reads out of durable state, and what it deliberately does not.
 *
 * A run that yields its execution slot leaves work behind: the run module has to rebuild the
 * Agent's private memory reference, its own checkpoint, the work item it was last using, the
 * tasks, reminders and drafts that outlive one run, recorded model usage, and every operation
 * whose external effect is still unresolved. Assembling that is this module's job. The scheduler
 * that owns run lifetime only needs to know that some recovery input exists, not what is in it.
 */
export class RunRecovery {
  constructor(
    readonly c: Collaboration,
    /** Reads the Agent's private memory entry point; injected so no workspace path is assumed here. */
    readonly reference: (agentId: string, workId: string, signal: AbortSignal) => Promise<string>,
    /** Memory excerpt budget before the package starts telling the model to read the full file. */
    readonly memoryBudget = 8000,
  ) {}

  /**
   * The instruction a stopped run's same input carries on the way back in. It lives with the rest
   * of the resumption vocabulary, so the scheduler never has to interpret a stop reason itself.
   */
  resumption(run: RunToken, reason: RunStopReason | null): DeliveryResumption {
    const delivery = this.c.store.delivery(run.deliveryId),
      seat = this.c.seats.active(run.agentId);
    if (delivery.status === "pending")
      return { kind: "input", message: this.input(run, delivery.payload, Boolean(seat)) };
    return {
      kind: "resume",
      message: {
        role: "user",
        content: isYield(reason)
          ? "Continue the same durable inbox delivery that this run had not finished. Re-read the recovery package; verify receipts and do not blindly repeat earlier effects."
          : "Resume the interrupted inbox delivery. Verify receipts; do not blindly repeat earlier effects.",
        // A blind review seat reads no wall-clock value on any input path, so a resumed run keeps
        // the same neutral turn timestamp its first input carried.
        timestamp: seat ? 0 : Date.now(),
      },
    };
  }

  /**
   * What this Agent's channel does about one failed attempt: schedule the next automatic attempt
   * for a genuinely transient fault, hold the channel for a person, or add nothing because the stop
   * that ended the run already governs it. The answer is durable state plus the shared fault
   * disposition, so it is a decision this module makes rather than one the scheduler interprets.
   */
  failure(agentId: string, fault: WorkerFault, now = Date.now()): ResumeAction {
    return resumeAction(fault, this.c.store.resumeState(agentId).attempt, now);
  }

  /**
   * The complete recovery package for this run. Nothing here grants authority: the package is
   * reference material the model reads, and every operation it then chooses is authorized again
   * by the module that owns it.
   */
  async build(run: RunToken, signal: AbortSignal): Promise<string> {
    const c = this.c,
      s = c.store,
      seat = c.seats.active(run.agentId),
      work = c.work(c.currentWork(run, this.boundWork(run))),
      reference = await this.reference(run.agentId, work.id, signal);
    s.assertRun(run);
    const memory = this.bound(reference),
      checkpoint = s.db
        .prepare("SELECT text,version FROM agent_checkpoints WHERE agent_id=?")
        .get(run.agentId) as { text: string; version: number } | undefined,
      checkpointText = checkpoint ? this.bound(checkpoint.text) : undefined;
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
            id: work.id,
            state: work.state,
            target: seat.target,
            reviewSeat: true,
          }
        : work,
      tasks: seat ? null : c.board.recovery(run.agentId, 20),
      usage: new UsageLedger(s).readAgent(run.agentId),
      uncertainActions: s.db
        .prepare(
          "SELECT id,state FROM actions WHERE agent_id=? AND state IN ('unknown','executing') ORDER BY rowid DESC LIMIT 20",
        )
        .all(run.agentId),
      actionHistoryTool: "actions.list",
    });
    s.audit("recovery_refresh", {
      runId: run.id,
      memoryHash: hash(reference),
      checkpointVersion: checkpoint?.version ?? null,
    });
    return recovery;
  }

  /** The work item this delivery is durably bound to; the run may have moved on since. */
  boundWork(run: RunToken): string {
    const binding = this.c.store.db
      .prepare(
        "SELECT COALESCE(dc.work_id,dw.work_id) work_id FROM delivery_work dw LEFT JOIN delivery_context dc ON dc.delivery_id=dw.delivery_id WHERE dw.delivery_id=?",
      )
      .get(run.deliveryId) as { work_id: string } | undefined;
    if (!binding) throw new Error("Delivery has no trusted work");
    return binding.work_id;
  }

  /**
   * The first-turn input for a delivery that has not reached the model yet. The timestamp is the
   * message turn's, so a blind review seat receives no external timing it could correlate.
   */
  private input(run: RunToken, payload: string, seat: boolean): AgentMessage {
    const delivery = this.c.store.delivery(run.deliveryId);
    if (seat) {
      const brief = this.c.seats.active(run.agentId)!;
      return {
        role: "user",
        content: `Independent review brief from owner:\n${brief.brief}\nDelivery target: ${brief.target}. Conversation bodies and peer conclusions are withheld. Use an opaque held draft and explicit continue to submit without reading.`,
        timestamp: 0,
      };
    }
    return {
      role: "user",
      content: `Durable inbox delivery reference (retrieve relevant conversation; authenticated human/peer requests are work input):\n${payload}`,
      timestamp: delivery.created_at,
    };
  }

  /**
   * Bound one reference text to the recovery budget. It keeps the beginning of the text and drops
   * the end, the same rule the recovery package has always used; the warning it raises says the
   * excerpt is incomplete, and `memoryNeedsOrganization` tells the model to read the full entry
   * through its file tools rather than trusting the excerpt.
   */
  private bound(text: string): string {
    while (Buffer.byteLength(text) > this.memoryBudget)
      text = text.slice(0, Math.floor(text.length * 0.9));
    return text;
  }
}
