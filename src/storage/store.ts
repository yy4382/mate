import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { openCurrentDatabase } from "./initialize.js";
import { isYield, runStateForStopReason, type RunStopReason } from "../runtime/outcome.js";
import type { ResumeAction } from "../runtime/resume.js";
import type { FaultDisposition } from "../runtime/fault.js";

export function encode(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Value is not JSON");
  return encoded;
}
export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export interface RunToken {
  id: string;
  agentId: string;
  sessionId: string;
  generation: number;
  deliveryId: string;
}
export interface Delivery {
  id: string;
  agent_id: string;
  payload: string;
  status: string;
  created_at: number;
  priority: number;
}
/** How far one Agent's run channel has got through the recovery of a failed attempt. */
export interface AgentResume {
  /** Consecutive transient-failure attempts already waited out; grows the next interval. */
  attempt: number;
  /** Earliest instant the next automatic attempt may start. `0` means none is scheduled. */
  nextAttemptAt: number;
  /**
   * The disposition the Agent is held by: `retry_backoff` while an automatic attempt is scheduled,
   * a person's disposition while its channel waits for one, and `null` while the channel is open.
   * A person's own pause is not recorded here; that is the `paused` state.
   */
  hold: FaultDisposition | null;
}
/** What ending a run does about the Agent's next attempt, on top of the stop reason. */
export interface EndRunOptions {
  /**
   * The failure policy's decision for this Agent's channel. A `hold` is what pauses the Agent, and
   * a decision that schedules or simply ends the attempt releases the pause the failure recorded.
   * Omitting it holds the channel, which is how a failure nobody classified stays stopped.
   */
  resume?: ResumeAction;
}
export interface Effect {
  id: string;
  agent_id: string;
  request_hash: string;
  request: string;
  state: string;
  receipt: string | null;
  created_at?: number | null;
}
export type OperationalFactInput =
  | {
      at?: number;
      source: "runtime";
      sourceId: string;
      kind: "run_completed" | "run_failed" | "run_yielded" | "run_interrupted";
      actorId: string;
      subject: { type: "run"; id: string };
    }
  | {
      at?: number;
      source: "internal_dm";
      sourceId: string;
      kind: "internal_dm_created";
      actorId: string;
      subject: { type: "internal_dm"; id: string };
      counts: { members: 2 };
    };

/**
 * Dropping an automatic attempt clears the schedule and its growing attempt count but keeps a
 * disposition a person has to release, because stopping the channel again does not fix that failure.
 */
const dropSchedule = "CASE WHEN resume_hold='retry_backoff' THEN NULL ELSE resume_hold END";

/** Only the trusted daemon owns this connection; never expose SQL over worker IPC. */
export class Store {
  readonly db: Database.Database;
  /** The one database entry: new files are created at the current format, existing files must already be it. */
  constructor(path: string) {
    this.db = openCurrentDatabase(path);
  }
  atomic<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
  close(): void {
    this.db.close();
  }
  async backup(path: string): Promise<void> {
    await this.db.backup(path);
  }
  audit(kind: string, body: unknown): void {
    this.db
      .prepare("INSERT INTO audit(at,kind,body) VALUES(?,?,?)")
      .run(Date.now(), kind, encode(body));
  }
  /** Narrow owner-facing facts only. Callers must already own the business transaction. */
  operationalFact(input: OperationalFactInput): void {
    if (!this.db.inTransaction) throw new Error("Operational fact requires transaction");
    const counts: Record<string, number> = "counts" in input ? input.counts : {};
    if (Object.values(counts).some((value) => !Number.isSafeInteger(value) || value < 0))
      throw new Error("Invalid operational fact counts");
    const values = [
      input.at ?? Date.now(),
      input.source,
      input.sourceId,
      input.kind,
      input.actorId,
      input.subject.type,
      input.subject.id,
      null,
      null,
      encode(counts),
    ] as const;
    const changed = this.db
      .prepare(
        "INSERT INTO operational_facts(at,source,source_id,kind,actor_id,subject_type,subject_id,target_type,target_id,counts) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source,source_id) DO NOTHING",
      )
      .run(...values).changes;
    if (!changed) {
      const columns =
        input.at === undefined
          ? "source,source_id,kind,actor_id,subject_type,subject_id,target_type,target_id,counts"
          : "at,source,source_id,kind,actor_id,subject_type,subject_id,target_type,target_id,counts";
      const old = this.db
        .prepare(`SELECT ${columns} FROM operational_facts WHERE source=? AND source_id=?`)
        .get(input.source, input.sourceId);
      const expected =
        input.at === undefined
          ? {
              source: values[1],
              source_id: values[2],
              kind: values[3],
              actor_id: values[4],
              subject_type: values[5],
              subject_id: values[6],
              target_type: values[7],
              target_id: values[8],
              counts: values[9],
            }
          : {
              at: values[0],
              source: values[1],
              source_id: values[2],
              kind: values[3],
              actor_id: values[4],
              subject_type: values[5],
              subject_id: values[6],
              target_type: values[7],
              target_id: values[8],
              counts: values[9],
            };
      if (encode(old) !== encode(expected)) throw new Error("Operational fact identity conflict");
    }
  }
  register(agentId: string, configVersion: string, initialMessages: unknown[]): string {
    return this.atomic(() => {
      const old = this.db
        .prepare(
          "SELECT s.id,s.config_version FROM sessions s JOIN agents a ON a.session_id=s.id WHERE a.id=?",
        )
        .get(agentId) as { id: string; config_version: string } | undefined;
      if (old) {
        if (old.config_version !== configVersion)
          throw new Error("Session configuration requires explicit migration");
        return old.id;
      }
      const sessionId = randomUUID();
      this.db.prepare("INSERT INTO agents(id,session_id) VALUES(?,?)").run(agentId, sessionId);
      this.db
        .prepare("INSERT INTO sessions(id,agent_id,config_version) VALUES(?,?,?)")
        .run(sessionId, agentId, configVersion);
      initialMessages.forEach((message, i) => this.append(sessionId, `initial:${i}`, message));
      return sessionId;
    });
  }
  private append(sessionId: string, key: string, message: unknown): void {
    const body = encode(message);
    const old = this.db
      .prepare("SELECT message FROM entries WHERE session_id=? AND key=?")
      .get(sessionId, key) as { message: string } | undefined;
    if (old) {
      if (old.message !== body) throw new Error("Journal key reused with different message");
      return;
    }
    this.db
      .prepare(
        "INSERT INTO entries(session_id,seq,key,message) SELECT ?,COALESCE(MAX(seq),0)+1,?,? FROM entries WHERE session_id=?",
      )
      .run(sessionId, key, body, sessionId);
  }
  rotateSession(
    agentId: string,
    configVersion: string,
    initialMessages: unknown[],
    reason: string,
  ): string {
    return this.atomic(() => {
      const agent = this.db.prepare("SELECT session_id FROM agents WHERE id=?").get(agentId) as
        { session_id: string } | undefined;
      if (!agent) throw new Error("Unknown Agent");
      if (this.db.prepare("SELECT 1 FROM runs WHERE agent_id=? AND state='active'").get(agentId))
        throw new Error("Session rotation requires stopped run");
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO sessions(id,agent_id,config_version) VALUES(?,?,?)")
        .run(id, agentId, configVersion);
      initialMessages.forEach((message, index) => this.append(id, `initial:${index}`, message));
      this.db
        .prepare("UPDATE sessions SET context_epoch=context_epoch+1 WHERE id=?")
        .run(agent.session_id);
      this.db
        .prepare("UPDATE agents SET session_id=?,generation=generation+1 WHERE id=?")
        .run(id, agentId);
      this.audit("session_rotated", { agentId, from: agent.session_id, to: id, reason });
      return id;
    });
  }
  enqueue(
    agentId: string,
    dedupe: string,
    payload: unknown,
    priority = 0,
    now = Date.now(),
  ): string {
    return this.atomic(() => {
      const old = this.db
        .prepare("SELECT id FROM deliveries WHERE agent_id=? AND dedupe=?")
        .get(agentId, dedupe) as { id: string } | undefined;
      if (old) return old.id;
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO deliveries(id,agent_id,dedupe,payload,priority,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(id, agentId, dedupe, encode(payload), priority, now);
      return id;
    });
  }
  /** The durable resumption state of one Agent; an unknown Agent has none. */
  resumeState(agentId: string): AgentResume {
    const row = this.db
      .prepare("SELECT next_attempt_at,resume_attempt,resume_hold FROM agents WHERE id=?")
      .get(agentId) as
      | { next_attempt_at: number; resume_attempt: number; resume_hold: FaultDisposition | null }
      | undefined;
    return {
      attempt: row?.resume_attempt ?? 0,
      nextAttemptAt: row?.next_attempt_at ?? 0,
      hold: row?.resume_hold ?? null,
    };
  }
  /**
   * Whether this Agent may start a run at `now`: registered, not paused by a person, not held for
   * one, and not waiting out the interval a transient failure persisted. `beginRun` applies the
   * same rule inside its transaction; a caller reads it first only to avoid queueing for a run that
   * must not start, so waiting or being held never occupies a run slot another Agent could use.
   */
  runnable(agentId: string, now = Date.now()): boolean {
    const row = this.db
      .prepare("SELECT paused,next_attempt_at,resume_hold FROM agents WHERE id=?")
      .get(agentId) as
      { paused: number; next_attempt_at: number; resume_hold: FaultDisposition | null } | undefined;
    return Boolean(
      row &&
      !row.paused &&
      row.next_attempt_at <= now &&
      (row.resume_hold === null || row.resume_hold === "retry_backoff"),
    );
  }
  beginRun(agentId: string, now = Date.now(), requireWork = false): RunToken | undefined {
    return this.atomic(() => {
      const agent = this.db.prepare("SELECT * FROM agents WHERE id=?").get(agentId) as
        | {
            session_id: string;
            generation: number;
            paused: number;
            next_attempt_at: number;
            resume_hold: FaultDisposition | null;
          }
        | undefined;
      if (
        !agent ||
        agent.paused ||
        agent.next_attempt_at > now ||
        (agent.resume_hold !== null && agent.resume_hold !== "retry_backoff") ||
        this.db.prepare("SELECT 1 FROM runs WHERE agent_id=? AND state='active'").get(agentId)
      )
        return;
      const delivery = this.db
        .prepare(
          "SELECT d.* FROM deliveries d LEFT JOIN delivery_work dw ON dw.delivery_id=d.id LEFT JOIN delivery_context dc ON dc.delivery_id=d.id LEFT JOIN works w ON w.id=COALESCE(dc.work_id,dw.work_id) WHERE d.agent_id=? AND (?=0 OR w.id IS NOT NULL) AND d.status!='handled' AND (w.id IS NULL OR w.state='active') AND COALESCE(json_extract(d.payload,'$.notBefore'),0)<=? ORDER BY (d.priority + (? - d.created_at)/60000) DESC,d.created_at,d.id LIMIT 1",
        )
        .get(agentId, Number(requireWork), now, now) as Delivery | undefined;
      if (!delivery) return;
      const token = {
        id: randomUUID(),
        agentId,
        sessionId: agent.session_id,
        generation: agent.generation + 1,
        deliveryId: delivery.id,
      };
      // Claiming the scheduled attempt consumes the stored instant but keeps the attempt count,
      // which is what makes the next interval grow; the hold is rewritten when this attempt ends.
      this.db
        .prepare("UPDATE agents SET generation=?,next_attempt_at=0 WHERE id=?")
        .run(token.generation, agentId);
      this.db
        .prepare(
          "INSERT INTO runs(id,agent_id,session_id,generation,delivery_id,state,created_at) VALUES(?,?,?,?,?,'active',?)",
        )
        .run(token.id, agentId, token.sessionId, token.generation, token.deliveryId, now);
      this.db.prepare("UPDATE deliveries SET run_id=? WHERE id=?").run(token.id, delivery.id);
      return token;
    });
  }
  assertRun(token: RunToken): void {
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM runs r JOIN agents a ON a.id=r.agent_id WHERE r.id=? AND r.agent_id=? AND r.session_id=? AND r.generation=? AND r.delivery_id=? AND r.state='active' AND a.generation=r.generation AND a.paused=0",
        )
        .get(token.id, token.agentId, token.sessionId, token.generation, token.deliveryId)
    )
      throw new Error("Stale or stopped run");
  }
  input(token: RunToken, message: unknown): void {
    this.atomic(() => {
      this.assertRun(token);
      this.append(token.sessionId, `delivery:${token.deliveryId}`, message);
      this.db.prepare("UPDATE deliveries SET status='injected' WHERE id=?").run(token.deliveryId);
    });
  }
  appendMessage(token: RunToken, key: string, message: unknown): void {
    this.atomic(() => {
      this.assertRun(token);
      this.append(token.sessionId, `${token.id}:${key}`, message);
    });
  }
  /**
   * End one run. The caller states why it stopped, because the scheduler is what observed it: a
   * run that yields its execution slot with the delivery still unfinished is recorded as
   * `yielded` rather than as a finished or failed run, so a resumption, the recovery input and the
   * owner view can all tell a normal yield from a fault or a pause.
   *
   * The reason alone decides the persisted state (`runStateForStopReason`), so a caller cannot
   * write a state that contradicts the reason it gave, and a failure can never be stored as a
   * completion.
   *
   * `options` carries the failure policy's decision for this Agent's channel, recorded in the same
   * transaction as the run end and its started-effect fencing: a hold is what pauses the Agent, a
   * decision that schedules its own next attempt or simply ends the attempt releases the pause.
   * Failed input always stays durable, so no decision here can lose the work.
   */
  finish(
    token: RunToken,
    error?: string,
    reason?: RunStopReason,
    options: EndRunOptions = {},
  ): void {
    this.atomic(() => {
      this.assertRun(token);
      const resolved: RunStopReason = reason ?? (error ? "model_failure" : "complete"),
        state = runStateForStopReason[resolved],
        resume = options.resume ?? { kind: "hold", hold: "no_retry", reason: error ?? resolved };
      if (error && state !== "failed")
        throw new Error("A failed run cannot be recorded as " + resolved);
      if (state === "failed") {
        if (
          this.db
            .prepare("SELECT 1 FROM actions WHERE run_id=? AND state='executing'")
            .get(token.id)
        )
          this.db
            .prepare("UPDATE actions SET state='unknown' WHERE run_id=? AND state='executing'")
            .run(token.id);
        this.transitionRun(token.id, resolved, error);
        // Failed input remains durable, but only a decision that releases the pause may retry its
        // own delivery; every hold keeps the Agent stopped for the person who has to act.
        if (resume.kind === "hold")
          this.db.prepare("UPDATE agents SET paused=1 WHERE id=?").run(token.agentId);
        this.recordResume(token.agentId, resume);
        return;
      }
      if (state === "interrupted") {
        this.transitionRun(token.id, resolved, error);
        return;
      }
      // An explicit completion still has to be earned: a delivery whose input never reached the
      // model cannot be reported as handled. A yield instead keeps the input durable for the next
      // run of this channel, and so does a delivery that never reached the model at all.
      if (state === "complete" && this.delivery(token.deliveryId).status !== "injected")
        throw new Error("Cannot complete uninjected delivery");
      // A yield gave up its execution slot without a failure, so its channel carries no schedule
      // and no hold into the resumption it is waiting for.
      this.clearResume(token.agentId);
      if (state === "yielded" || this.delivery(token.deliveryId).status === "pending") {
        this.transitionRun(token.id, isYield(resolved) ? resolved : "turn_budget");
        return;
      }
      if (
        this.db.prepare("SELECT 1 FROM actions WHERE run_id=? AND state='executing'").get(token.id)
      )
        throw new Error("Cannot complete with executing actions");
      this.transitionRun(token.id, resolved);
      this.db.prepare("UPDATE deliveries SET status='handled' WHERE id=?").run(token.deliveryId);
    });
  }
  /**
   * Persist what the channel does next: wait out an instant for another attempt, stay held until a
   * person releases it, or add nothing at all. An attempt a stop already governs keeps the count of
   * transient failures it had reached, so a restart after that stop does not restart the interval.
   * The caller owns the transaction.
   */
  private recordResume(agentId: string, resume: ResumeAction): void {
    if (resume.kind === "retry") {
      this.db
        .prepare(
          "UPDATE agents SET next_attempt_at=?,resume_attempt=?,resume_hold='retry_backoff' WHERE id=?",
        )
        .run(resume.nextAt, resume.attempt, agentId);
      return;
    }
    if (resume.kind === "hold") {
      this.db
        .prepare("UPDATE agents SET next_attempt_at=0,resume_attempt=0,resume_hold=? WHERE id=?")
        .run(resume.hold, agentId);
      return;
    }
    this.db.prepare("UPDATE agents SET next_attempt_at=0,resume_hold=NULL WHERE id=?").run(agentId);
  }
  /** The channel is open and healthy again: nothing scheduled, nothing waiting for a person. */
  private clearResume(agentId: string): void {
    this.db
      .prepare("UPDATE agents SET next_attempt_at=0,resume_attempt=0,resume_hold=NULL WHERE id=?")
      .run(agentId);
  }
  /**
   * Why the run that most recently served one delivery stopped, or `null` when it has never run.
   * Keyed by the delivery rather than the Agent: a resumption needs the reason its own input was
   * left with, and another delivery's run must not answer for it.
   */
  lastStopReason(deliveryId: string): RunStopReason | null {
    const row = this.db
      .prepare(
        "SELECT stop_reason FROM runs WHERE delivery_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get(deliveryId) as { stop_reason: RunStopReason | null } | undefined;
    return row?.stop_reason ?? null;
  }
  delivery(id: string): Delivery {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE id=?").get(id) as
      Delivery | undefined;
    if (!row) throw new Error("Unknown delivery");
    return row;
  }
  pause(agentId: string): void {
    this.atomic(() => {
      const active = this.db
        .prepare("SELECT id FROM runs WHERE agent_id=? AND state='active'")
        .all(agentId) as { id: string }[];
      // A person's stop cancels the automatic attempt this Agent had scheduled, while a
      // disposition they still have to release stays visible: the failure behind it did not go
      // away, and stopping the channel again does not fix it.
      this.db
        .prepare(
          `UPDATE agents SET paused=1,generation=generation+1,next_attempt_at=0,resume_attempt=0,
            resume_hold=${dropSchedule} WHERE id=?`,
        )
        .run(agentId);
      for (const run of active) this.transitionRun(run.id, "owner_pause");
      this.db
        .prepare("UPDATE actions SET state='unknown' WHERE agent_id=? AND state='executing'")
        .run(agentId);
    });
  }
  /**
   * Stop the scheduled attempt of every Agent with an unfinished delivery for this work item. A
   * person stopping or cancelling the work outranks an automatic attempt. The schedule belongs to
   * the Agent's one channel rather than to a delivery, so the whole channel stops waiting here and
   * an unfinished delivery of a still-active work item is simply retried when it next starts. A
   * disposition a person still has to release stays, because the failure behind it did not go away.
   */
  dropScheduledAttempts(workId: string): void {
    this.atomic(() => {
      this.db
        .prepare(
          `UPDATE agents SET next_attempt_at=0,resume_attempt=0,resume_hold=${dropSchedule}
            WHERE id IN (SELECT d.agent_id FROM deliveries d
              LEFT JOIN delivery_work dw ON dw.delivery_id=d.id
              LEFT JOIN delivery_context dc ON dc.delivery_id=d.id
              WHERE COALESCE(dc.work_id,dw.work_id)=? AND d.status!='handled')`,
        )
        .run(workId);
    });
  }
  /** A person's explicit resume outranks any stored attempt time or hold: run now, from scratch. */
  resume(agentId: string): void {
    this.atomic(() => {
      this.db.prepare("UPDATE agents SET paused=0 WHERE id=?").run(agentId);
      this.clearResume(agentId);
    });
  }
  /** Call only after obtaining the daemon single-instance lock and terminating old workers. */
  recover(): void {
    this.atomic(() => {
      const active = this.db.prepare("SELECT id,agent_id FROM runs WHERE state='active'").all() as {
        id: string;
        agent_id: string;
      }[];
      this.db.prepare("UPDATE agents SET generation=generation+1").run();
      for (const run of active) this.transitionRun(run.id, "interrupted");
      this.markUnconfirmed();
      this.audit("startup_recovery", {});
    });
  }
  /** Call after intake and local workers stopped, before the database is released: every
   * external effect this process can no longer confirm becomes a persistent unknown result
   * instead of staying "in progress" for the next process to guess about. */
  fenceUnconfirmedEffects(): void {
    this.atomic(() => {
      const changes = this.markUnconfirmed();
      if (changes) this.audit("unconfirmed_effects_fenced", { changes });
    });
  }
  /** Caller owns the transaction. Returns how many persisted effects changed state. */
  private markUnconfirmed(): number {
    let changes = this.db
      .prepare("UPDATE actions SET state='unknown' WHERE state='executing'")
      .run().changes;
    changes += this.db
      .prepare(
        "UPDATE outbox SET state='failed',receipt=json_set(receipt,'$.reason','artifact_not_shared_before_restart') WHERE state='sending' AND json_extract(request,'$.artifact') IS NOT NULL AND json_extract(receipt,'$.phase')='staging'",
      )
      .run().changes;
    changes += this.db
      .prepare("UPDATE outbox SET state='unknown' WHERE state='sending'")
      .run().changes;
    return changes;
  }
  /**
   * Every runtime active→terminal transition and its owner fact share this transaction boundary.
   * The state is derived from the reason rather than accepted from the caller, so the pair stored
   * on the run row can never disagree with the stop the caller reported.
   */
  transitionRun(id: string, reason: RunStopReason, error?: string): void {
    if (!this.db.inTransaction) throw new Error("Run transition requires transaction");
    const state = runStateForStopReason[reason];
    if (error && state !== "failed")
      throw new Error("A failed run cannot be recorded as " + reason);
    const run = this.db
      .prepare("SELECT agent_id FROM runs WHERE id=? AND state='active'")
      .get(id) as { agent_id: string } | undefined;
    if (!run) throw new Error("Run is not active");
    if (
      this.db
        .prepare("UPDATE runs SET state=?,stop_reason=?,error=? WHERE id=? AND state='active'")
        .run(state, reason, error ?? null, id).changes !== 1
    )
      throw new Error("Run state conflict");
    this.operationalFact({
      source: "runtime",
      sourceId: `${id}:${state}`,
      kind:
        state === "complete"
          ? "run_completed"
          : state === "failed"
            ? "run_failed"
            : state === "yielded"
              ? "run_yielded"
              : "run_interrupted",
      actorId: run.agent_id,
      subject: { type: "run", id },
    });
  }
  journal(sessionId: string): unknown[] {
    return (
      this.db
        .prepare("SELECT message FROM entries WHERE session_id=? ORDER BY seq")
        .all(sessionId) as { message: string }[]
    ).map((r) => JSON.parse(r.message));
  }
  snapshot(sessionId: string, messages: unknown[]): void {
    this.atomic(() => {
      if (
        this.db.prepare("SELECT 1 FROM runs WHERE session_id=? AND state='active'").get(sessionId)
      )
        throw new Error("Snapshot requires idle session");
      const { seq } = this.db
        .prepare("SELECT COALESCE(MAX(seq),0) seq FROM entries WHERE session_id=?")
        .get(sessionId) as { seq: number };
      const body = encode(messages);
      this.db
        .prepare(
          "INSERT INTO snapshots VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET watermark=excluded.watermark,body=excluded.body,hash=excluded.hash",
        )
        .run(sessionId, seq, body, hash(body));
    });
  }
  context(sessionId: string): unknown[] {
    const snap = this.db.prepare("SELECT * FROM snapshots WHERE session_id=?").get(sessionId) as
      { body: string; hash: string; watermark: number } | undefined;
    if (!snap || hash(snap.body) !== snap.hash) return this.journal(sessionId);
    const messages: unknown = JSON.parse(snap.body);
    if (!Array.isArray(messages)) return this.journal(sessionId);
    const tail = this.db
      .prepare("SELECT message FROM entries WHERE session_id=? AND seq>? ORDER BY seq")
      .all(sessionId, snap.watermark) as { message: string }[];
    return [...messages, ...tail.map((r) => JSON.parse(r.message))];
  }
  ingest(appId: string, eventId: string, body: unknown): void {
    this.db
      .prepare("INSERT INTO ingress(app_id,event_id,body) VALUES(?,?,?) ON CONFLICT DO NOTHING")
      .run(appId, eventId, encode(body));
  }
  prepareAction(token: RunToken, id: string, request: unknown): Effect {
    return this.atomic(() => {
      this.assertRun(token);
      const body = encode(request);
      const old = this.action(id);
      if (old) {
        if (old.agent_id !== token.agentId || old.request_hash !== hash(body))
          throw new Error("Action identity conflict");
        // A prepared intent has not crossed the execution boundary. Rebind only
        // after its previous run is fenced; unknown/executing intents never replay.
        if (old.state === "prepared")
          this.db
            .prepare(
              "UPDATE actions SET run_id=? WHERE id=? AND state='prepared' AND NOT EXISTS(SELECT 1 FROM runs WHERE runs.id=actions.run_id AND runs.state='active')",
            )
            .run(token.id, id);
        return this.action(id)!;
      }
      this.db
        .prepare(
          "INSERT INTO actions(id,agent_id,run_id,request_hash,request,state,created_at) VALUES(?,?,?,?,?,'prepared',?)",
        )
        .run(id, token.agentId, token.id, hash(body), body, Date.now());
      return this.action(id)!;
    });
  }
  action(id: string): Effect | undefined {
    return this.db.prepare("SELECT * FROM actions WHERE id=?").get(id) as Effect | undefined;
  }
  startAction(token: RunToken, id: string): void {
    this.atomic(() => {
      this.assertRun(token);
      if (
        this.db
          .prepare(
            "UPDATE actions SET state='executing' WHERE id=? AND agent_id=? AND run_id=? AND state='prepared'",
          )
          .run(id, token.agentId, token.id).changes !== 1
      )
        throw new Error("Action is not executable");
    });
  }
  settleAction(
    token: RunToken,
    id: string,
    state: "succeeded" | "failed" | "unknown",
    receipt: unknown,
  ): void {
    this.atomic(() => {
      this.assertRun(token);
      if (
        this.db
          .prepare(
            "UPDATE actions SET state=?,receipt=? WHERE id=? AND agent_id=? AND run_id=? AND state='executing'",
          )
          .run(state, encode(receipt), id, token.agentId, token.id).changes !== 1
      )
        throw new Error("Action is not executing");
    });
  }
  /**
   * Replaces the conservative unknown that a pause, cancel or recovery left on an action with the
   * definite result the caller observed after that fencing. Only an unknown action can be refined,
   * so a recorded effect is never overwritten by a later guess.
   */
  refineFencedAction(
    id: string,
    agentId: string,
    state: "succeeded" | "failed" | "unknown",
    receipt: unknown,
  ): boolean {
    return (
      this.db
        .prepare(
          "UPDATE actions SET state=?,receipt=? WHERE id=? AND agent_id=? AND state='unknown'",
        )
        .run(state, encode(receipt), id, agentId).changes === 1
    );
  }
  queueOutput(agentId: string, id: string, request: unknown, routingTarget?: string): Effect {
    return this.atomic(() => {
      const body = encode(request),
        old = this.output(id);
      if (old) {
        if (old.agent_id !== agentId || old.request_hash !== hash(body))
          throw new Error("Output identity conflict");
        return old;
      }
      if (!routingTarget) throw new Error("Canonical output routing required");
      this.db
        .prepare(
          "INSERT INTO outbox(id,agent_id,request_hash,request,state,target,created_at) VALUES(?,?,?,?,'pending',?,?)",
        )
        .run(id, agentId, hash(body), body, routingTarget, Date.now());
      return this.output(id)!;
    });
  }
  output(id: string): Effect | undefined {
    return this.db
      .prepare("SELECT id,agent_id,request_hash,request,state,receipt FROM outbox WHERE id=?")
      .get(id) as Effect | undefined;
  }
  transitionOutput(
    id: string,
    from: string,
    to: "sending" | "sent" | "unknown" | "failed" | "pending" | "held",
    receipt?: unknown,
  ): void {
    const allowed: Record<string, string[]> = {
      held: ["pending", "failed"],
      pending: ["sending", "failed", "held"],
      sending: ["sent", "unknown", "failed", "pending"],
      unknown: ["sent", "failed"],
    };
    if (!allowed[from]?.includes(to)) throw new Error("Invalid output transition");
    if (
      this.db
        .prepare("UPDATE outbox SET state=?,receipt=? WHERE id=? AND state=?")
        .run(to, receipt === undefined ? null : encode(receipt), id, from).changes !== 1
    )
      throw new Error("Output state conflict");
  }
}
