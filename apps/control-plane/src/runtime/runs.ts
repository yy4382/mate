import { z } from "zod";
import { queueUncertainOperationFacts } from "./recovery-context.js";
import { AgentSession } from "./session/service.js";
import { AgentLoop, type AgentLoopTestDependencies } from "./loop.js";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ModelCredentialDirectory } from "../providers/credentials.js";
import { providerCredentialExistsSql } from "../providers/credentials.js";
import type { OwnerChat } from "../conversations/service.js";
import { NodeDirectory } from "../nodes/directory.js";
import { AgentProcessOperationBroker } from "./process-operations.js";
import type { AgentTools } from "./tools/registry.js";
import { recordAgentActivity } from "./activity.js";

const schedulerIntervalMs = 250;
const retryDelayMs = 1500;
const maxRetryDelayMs = 5 * 60_000;

interface RunCandidate {
  agent_id: string;
  node_id: string;
  home: string | null;
  home_marker: string | null;
  session_id: string;
  name: string;
  role: string;
  description: string;
  provider: string;
  model_id: string;
  channel_id: string;
  channel_visibility: "public" | "private";
  delivery_id: string;
}

/** Durable owner-channel run admission and the single primary run path for each Agent. */
export class AgentRunCoordinator {
  private readonly activeAgents = new Map<
    string,
    { runId: string; nodeId: string; provider: string; loop: AgentLoop }
  >();
  /** Deliveries already announced to their run: delivery id to the run that was told. */
  private readonly noticedDeliveries = new Map<string, string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private draining = false;
  private closed = false;
  private readonly now: () => number;

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
    this.now = now;
    this.recoverInterruptedRuns();
    nodes.setProcessReceiptHandler(
      (nodeId, receipt) => {
        if (this.reconcileStop(nodeId, receipt)) return;
        const outcome = this.processOperations.reconcile(
          nodeId,
          receipt,
          (agentId, operationId, state) =>
            this.chat.notifyAgentReceiptCorrection(agentId, operationId, state),
        );
        if (outcome.corrected) this.wake();
        if (this.nodes.list().some((node) => node.id === nodeId && node.online))
          void this.dispatchPendingStops(false);
      },
      () => {
        this.activateEnabledAgents();
        this.wake();
        void this.dispatchPendingStops(true);
      },
    );
    nodes.setOfflineHandler((nodeId) => {
      for (const [agentId, active] of this.activeAgents) {
        if (active.nodeId !== nodeId) continue;
        this.finishRun(active.runId, agentId, false, "node_disconnected");
        this.cancelRun(active.runId, agentId);
      }
    });
    this.timer = setInterval(() => this.wake(), schedulerIntervalMs);
    this.timer.unref?.();
    this.wake();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    for (const [agentId, active] of this.activeAgents) {
      this.finishRun(active.runId, agentId, false, "aborted");
      this.cancelRun(active.runId, agentId);
    }
  }

  wake(): void {
    if (!this.closed) {
      void this.drain();
      void this.dispatchPendingStops(false);
    }
  }

  credentialsChanged(provider: string, ready: boolean): number {
    if (ready)
      this.db
        .prepare(
          `UPDATE owner_agent_run_control SET paused_reason=NULL,temporary_failures=0,updated_at=?
       WHERE paused_reason='credentials' AND agent_id IN (SELECT id FROM owner_agents WHERE provider=?)`,
        )
        .run(this.now(), provider);
    const running = [...this.activeAgents].filter(([, run]) => run.provider === provider);
    for (const [agentId, run] of running) this.invalidateRun(run.runId, agentId);
    return running.length;
  }

  modelChanged(agentId: string): void {
    this.db
      .prepare(
        "UPDATE owner_agent_run_control SET paused_reason=NULL,temporary_failures=0,updated_at=? WHERE agent_id=? AND paused_reason IN ('credentials','context')",
      )
      .run(this.now(), agentId);
    // The current loop owns its admitted configuration; edits apply to the next run.
    this.wake();
  }

  private invalidateRun(runId: string, agentId: string): void {
    this.db
      .transaction(() => {
        this.db
          .prepare(
            "UPDATE owner_agent_runs SET state='failed',error_code='configuration_changed',retry_at=?,completed_at=? WHERE id=? AND state='running'",
          )
          .run(this.now(), this.now(), runId);
        recordAgentActivity(this.db, {
          agentId,
          kind: "run.interrupted",
          referenceId: runId,
          summary: "模型或凭据变更使旧运行失效；待处理消息将从已确认记录恢复。",
          at: this.now(),
        });
      })
      .immediate();
    this.cancelRun(runId, agentId);
  }

  pauseAgent(agentId: string): boolean {
    const agent = this.db
      .prepare<unknown[], { id: string; node_id: string }>(
        "SELECT id,node_id FROM owner_agents WHERE id=?",
      )
      .get(agentId);
    if (!agent) return false;
    let stopId: string | undefined;
    this.db
      .transaction(() => {
        const existing = this.db
          .prepare<unknown[], { paused_reason: string | null }>(
            "SELECT paused_reason FROM owner_agent_run_control WHERE agent_id=?",
          )
          .get(agentId);
        const lastStop = this.stopStatus(agentId);
        if (
          existing?.paused_reason !== "manual" ||
          (lastStop.state === "unknown" &&
            receiptFields(lastStop.receipt)?.reason !== "pending_process_receipts") ||
          lastStop.state === "failed"
        ) {
          stopId = randomUUID();
          this.db
            .prepare(
              "INSERT INTO owner_agent_stop_intents(operation_id,agent_id,node_id,state,created_at,updated_at) VALUES(?,?,?,'executing',?,?)",
            )
            .run(stopId, agentId, agent.node_id, this.now(), this.now());
        }
        this.db
          .prepare(
            `INSERT INTO owner_agent_run_control(agent_id,paused_reason,updated_at) VALUES(?,'manual',?)
         ON CONFLICT(agent_id) DO UPDATE SET paused_reason='manual',updated_at=excluded.updated_at`,
          )
          .run(agentId, this.now());
        this.db
          .prepare(
            `UPDATE owner_agent_runs SET state='failed',error_code='manual_pause',retry_at=NULL,completed_at=?
         WHERE agent_id=? AND state='running'`,
          )
          .run(this.now(), agentId);
        recordAgentActivity(this.db, {
          agentId,
          kind: "run.paused",
          summary: "所有者已暂停 Agent 运行。",
          at: this.now(),
        });
      })
      .immediate();
    const pending = this.db
      .prepare<unknown[], { id: string }>(
        `SELECT id FROM owner_agent_runs WHERE agent_id=? AND error_code='manual_pause' ORDER BY started_at DESC LIMIT 1`,
      )
      .get(agentId);
    if (pending) this.cancelRun(pending.id, agentId);
    if (stopId) void this.dispatchStop(stopId, agentId, agent.node_id);
    return true;
  }

  stopStatus(agentId: string): {
    state: string;
    receipt: unknown | null;
    /** The stop's own scope, when the node reported one. */
    scope?: string;
    /** Started commands whose termination neither the node nor its restart could confirm. */
    unconfirmedOperationIds?: string[];
  } {
    const row = this.db
      .prepare<unknown[], { state: string; receipt_json: string | null }>(
        "SELECT state,receipt_json FROM owner_agent_stop_intents WHERE agent_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get(agentId);
    if (!row) return { state: "unknown", receipt: { reason: "stop_not_confirmed" } };
    const receipt = parseReceipt(row.receipt_json) ?? { reason: "stop_receipt_unreadable" },
      scope = receiptScope(receipt),
      unconfirmedOperationIds = unconfirmedCommandIds(receipt, this.unconfirmedCommands(agentId));
    return {
      state: row.state,
      receipt,
      ...(scope === undefined ? {} : { scope }),
      ...(unconfirmedOperationIds.length === 0 ? {} : { unconfirmedOperationIds }),
    };
  }

  /**
   * Started commands whose termination nothing has proven.
   *
   * The node's tracker is per-node-process memory, so a command that outlived the node process it
   * started under is out of Mate's reach: the durable row keeps whatever the node could still say,
   * and a node that restarted says only that it does not know. Neither is a stopped command, and the
   * owner must be told so instead of reading the stop's success as "everything is gone".
   */
  private unconfirmedCommands(agentId: string): string[] {
    const rows = this.db
      .prepare<
        unknown[],
        {
          operation_id: string;
          request_json: string;
          state: string;
          receipt_json: string | null;
        }
      >(
        `SELECT operation_id,request_json,state,receipt_json FROM owner_agent_process_operations
         WHERE agent_id=?
         ORDER BY created_at`,
      )
      .all(agentId);
    return rows
      .filter((row) => {
        if (!startedACommand(row.request_json)) return false;
        const node = receiptFields(parseReceipt(row.receipt_json));
        // A command that never launched a shell has a definite result, whatever else it reported.
        if (node?.reason === "command_not_started") return false;
        // `executing` and `unknown` say the node gave no verdict at all. A verdict is still not a
        // termination while the receipt sees the command's process group alive — that covers a
        // timed-out shell that could not be killed and a successful shell that left a descendant.
        return (
          node?.processGroupRunning === true || row.state === "executing" || row.state === "unknown"
        );
      })
      .map((row) => row.operation_id);
  }

  private readonly activeStops = new Set<string>();

  private activateEnabledAgents(): void {
    const online = new Set(
      this.nodes
        .list()
        .filter((node) => node.online)
        .map((node) => node.id),
    );
    const rows = this.db
      .prepare<unknown[], { id: string; node_id: string }>(
        `SELECT a.id,a.node_id FROM owner_agents a
       LEFT JOIN owner_agent_run_control c ON c.agent_id=a.id
       WHERE (c.paused_reason IS NULL OR c.paused_reason<>'manual')`,
      )
      .all();
    for (const row of rows)
      if (online.has(row.node_id)) this.nodes.activateAgent(row.node_id, row.id);
  }

  private unsettledProcessReceipt(agentId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM owner_agent_process_operations WHERE agent_id=? AND (state='executing' OR (state='unknown' AND node_receipt_confirmed=0)) LIMIT 1",
        )
        .get(agentId),
    );
  }

  private async dispatchPendingStops(all: boolean): Promise<void> {
    if (this.closed) return;
    const rows = this.db
      .prepare<
        unknown[],
        {
          operation_id: string;
          agent_id: string;
          node_id: string;
          state: string;
          receipt_json: string | null;
        }
      >(
        `SELECT s.operation_id,s.agent_id,s.node_id,s.state,s.receipt_json
         FROM owner_agent_stop_intents s
         JOIN owner_agent_run_control c ON c.agent_id=s.agent_id AND c.paused_reason='manual'
         WHERE s.state IN ('executing','unknown') AND NOT EXISTS (
           SELECT 1 FROM owner_agent_stop_intents later
           WHERE later.agent_id=s.agent_id AND later.rowid>s.rowid)`,
      )
      .all();
    for (const row of rows) {
      const reason = receiptFields(parseReceipt(row.receipt_json))?.reason;
      if (reason === "pending_process_receipts") {
        if (this.unsettledProcessReceipt(row.agent_id)) continue;
        const nextId = randomUUID();
        this.db
          .prepare(
            "INSERT INTO owner_agent_stop_intents(operation_id,agent_id,node_id,state,created_at,updated_at) VALUES(?,?,?,'executing',?,?)",
          )
          .run(nextId, row.agent_id, row.node_id, this.now(), this.now());
        void this.dispatchStop(nextId, row.agent_id, row.node_id);
      } else if (all && row.state === "unknown") {
        // A node may have durably returned unknown for the old ID. A fresh idempotent stop
        // request rechecks all scopes after the node has finished receipt reconciliation.
        const nextId = randomUUID();
        this.db
          .prepare(
            "INSERT INTO owner_agent_stop_intents(operation_id,agent_id,node_id,state,created_at,updated_at) VALUES(?,?,?,'executing',?,?)",
          )
          .run(nextId, row.agent_id, row.node_id, this.now(), this.now());
        void this.dispatchStop(nextId, row.agent_id, row.node_id);
      } else if (all) void this.dispatchStop(row.operation_id, row.agent_id, row.node_id);
    }
  }

  private async dispatchStop(operationId: string, agentId: string, nodeId: string): Promise<void> {
    if (this.activeStops.has(operationId)) return;
    this.activeStops.add(operationId);
    try {
      const result = await this.nodes.executeAgentProcessOperation(nodeId, {
        operationId,
        agentId,
        operation: { kind: "process.stop_all" },
      });
      if (this.closed) return;
      this.reconcileStop(nodeId, result);
    } catch {
      if (this.closed) return;
      this.db
        .transaction(() => {
          const changed = this.db
            .prepare(
              "UPDATE owner_agent_stop_intents SET state='unknown',receipt_json=?,updated_at=? WHERE operation_id=? AND state='executing'",
            )
            .run(
              JSON.stringify({ reason: "node_stop_result_unavailable" }),
              this.now(),
              operationId,
            ).changes;
          if (changed)
            recordAgentActivity(this.db, {
              agentId,
              nodeId,
              kind: "operation.finished",
              referenceId: operationId,
              summary: "普通命令停止结果未知；请检查节点连接与操作收据。",
              detail: { state: "unknown", reason: "node_stop_result_unavailable" },
              at: this.now(),
            });
        })
        .immediate();
    } finally {
      this.activeStops.delete(operationId);
    }
  }

  private reconcileStop(
    nodeId: string,
    result: {
      operationId: string;
      agentId: string;
      state: string;
      receipt: unknown | null;
    },
  ): boolean {
    const row = this.db
      .prepare<unknown[], { agent_id: string; node_id: string; state: string }>(
        "SELECT agent_id,node_id,state FROM owner_agent_stop_intents WHERE operation_id=?",
      )
      .get(result.operationId);
    if (!row) return false;
    if (row.node_id !== nodeId || row.agent_id !== result.agentId) return true;
    if (row.state !== "succeeded" && row.state !== "failed")
      this.db
        .transaction(() => {
          const unsettled =
            result.state === "succeeded" && this.unsettledProcessReceipt(result.agentId);
          const state = unsettled ? "unknown" : result.state;
          const receipt = unsettled ? { reason: "pending_process_receipts" } : result.receipt;
          // The durable record names the same gap the owner page shows, so the activity log and the
          // page cannot drift into saying different things about one stop.
          const unconfirmed = unsettled
            ? []
            : unconfirmedCommandIds(receipt, this.unconfirmedCommands(result.agentId));
          this.db
            .prepare(
              "UPDATE owner_agent_stop_intents SET state=?,receipt_json=?,updated_at=? WHERE operation_id=?",
            )
            .run(
              state,
              receipt === null ? null : JSON.stringify(receipt),
              this.now(),
              result.operationId,
            );
          if (state === "succeeded" || state === "failed")
            new AgentSession(this.db).queueCorrection(
              result.agentId,
              { operationId: result.operationId, state, receipt },
              this.now(),
            );
          recordAgentActivity(this.db, {
            agentId: result.agentId,
            nodeId,
            kind: "operation.finished",
            referenceId: result.operationId,
            summary:
              state === "succeeded"
                ? unconfirmed.length === 0
                  ? "本次节点运行启动的普通命令已确认停止。"
                  : `本次节点运行中可确认的普通命令已停止；另有 ${unconfirmed.length} 条命令的终止无法确认。`
                : state === "failed"
                  ? unconfirmed.length === 0
                    ? "部分普通命令的终止无法确认；保持停用，请检查节点诊断。"
                    : `本次节点运行中仍有 ${unconfirmed.length} 条命令的终止无法确认。保持停用，请检查节点诊断。`
                  : "普通命令停止结果未知；请检查节点诊断。",
            detail: {
              state,
              receipt,
              ...(unconfirmed.length === 0 ? {} : { unconfirmedOperationIds: unconfirmed }),
            },
            at: this.now(),
          });
        })
        .immediate();
    return true;
  }

  async resumeAgent(agentId: string): Promise<{ ok: boolean; error?: string }> {
    const row = this.db
      .prepare<
        unknown[],
        {
          node_id: string;
          home: string | null;
          home_marker: string | null;
          paused_reason: string | null;
        }
      >(
        `SELECT a.node_id,a.home,a.home_marker,c.paused_reason
       FROM owner_agents a JOIN owner_agent_run_control c ON c.agent_id=a.id WHERE a.id=?`,
      )
      .get(agentId);
    if (row?.paused_reason !== "manual" && row?.paused_reason !== "context")
      return { ok: false, error: "Agent 尚未停用。" };
    const verification = await this.verifyExecutionEnvironment(agentId, row);
    if (!verification.ok) return verification;
    if (this.pauseReason(agentId) !== row.paused_reason)
      return { ok: false, error: "停用状态已变化，请重试。" };
    this.db
      .prepare(
        "UPDATE owner_agent_run_control SET paused_reason=NULL,temporary_failures=0,updated_at=? WHERE agent_id=?",
      )
      .run(this.now(), agentId);
    recordAgentActivity(this.db, {
      agentId,
      kind: "run.resumed",
      summary: "所有者已恢复 Agent 运行。",
      at: this.now(),
    });
    this.nodes.activateAgent(row.node_id, agentId);
    this.wake();
    return { ok: true };
  }

  private async verifyExecutionEnvironment(
    agentId: string,
    row: { node_id: string; home: string | null; home_marker: string | null },
  ): Promise<{ ok: boolean; error?: string }> {
    let verified;
    try {
      verified = await this.nodes.provisionAgent(
        row.node_id,
        randomUUID(),
        agentId,
        () => {},
        true,
      );
    } catch {
      return { ok: false, error: "原节点未能核验运行账号与 Agent 工作区，请恢复原节点后重试。" };
    }
    // Re-verify against the node's recorded account plus this Agent's own workspace and marker.
    const nodeAccount = this.nodes.account(row.node_id);
    if (
      !verified.ok ||
      !row.home_marker ||
      !nodeAccount ||
      verified.identity.workspaceMarker !== row.home_marker ||
      verified.identity.username !== nodeAccount.username ||
      verified.identity.uid !== nodeAccount.uid ||
      verified.identity.gid !== nodeAccount.gid ||
      verified.identity.workspace !== row.home
    )
      return { ok: false, error: "原运行账号或 Agent 工作区未通过核验；请修复原数据。" };
    return { ok: true };
  }

  pauseReason(agentId: string): string | null {
    const row = this.db
      .prepare<unknown[], { paused_reason: string | null }>(
        "SELECT paused_reason FROM owner_agent_run_control WHERE agent_id=?",
      )
      .get(agentId);
    return row?.paused_reason ?? null;
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
      for (const candidate of this.pendingCandidates(onlineNodeIds)) {
        if (this.closed) return;
        if (this.activeAgents.has(candidate.agent_id)) continue;
        const apiKey = this.credentials.readForRun(candidate.provider);
        if (!apiKey) continue;
        const runId = this.beginRun(candidate);
        if (!runId) continue;
        const loop = new AgentLoop(),
          active = { runId, nodeId: candidate.node_id, provider: candidate.provider, loop };
        this.activeAgents.set(candidate.agent_id, active);
        void this.advance(candidate, active, apiKey).finally(() => {
          if (this.activeAgents.get(candidate.agent_id) === active) {
            // Heartbeat age may invalidate current() before the directory's offline sweep runs.
            // End any still-owned durable run before releasing the admission slot.
            this.finishRun(active.runId, candidate.agent_id, false, "node_disconnected");
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
         ORDER BY d.seq LIMIT 100`,
      )
      .all(...announced);
    for (const arrival of arrivals)
      if (this.noticeRun(arrival.run_id, arrival.agent_id, arrival.channel_id))
        this.noticedDeliveries.set(arrival.delivery_id, arrival.run_id);
  }

  private pendingCandidates(onlineNodeIds: string[]): RunCandidate[] {
    if (onlineNodeIds.length === 0) return [];
    const onlineNodePlaceholders = onlineNodeIds.map(() => "?").join(",");
    return this.db
      .prepare<unknown[], RunCandidate>(
        `SELECT a.id AS agent_id,a.node_id,a.home,a.home_marker,s.id AS session_id,a.name,a.role,a.description,
                a.provider,a.model_id,d.channel_id,c.visibility AS channel_visibility,
                d.id AS delivery_id
         FROM owner_message_deliveries d
         JOIN owner_messages m ON m.id=d.message_id
         JOIN owner_agents a ON a.id=d.recipient_id
         JOIN owner_agent_sessions s ON s.agent_id=a.id
         JOIN owner_channels c ON c.id=d.channel_id
         WHERE d.recipient_kind='agent' AND d.state='pending'
           AND (c.archived=0 OR m.internal_kind='reminder')
           AND a.node_id IN (${onlineNodePlaceholders})
           AND a.stage='complete'
           AND NOT EXISTS (SELECT 1 FROM owner_agent_run_control ctl WHERE ctl.agent_id=a.id AND ctl.paused_reason IS NOT NULL)
           AND ${providerCredentialExistsSql}
           AND NOT EXISTS (SELECT 1 FROM owner_agent_runs r WHERE r.agent_id=a.id AND r.state='running')
           AND NOT EXISTS (
             SELECT 1 FROM owner_message_deliveries earlier
             JOIN owner_messages earlier_message ON earlier_message.id=earlier.message_id
             JOIN owner_channels earlier_source
               ON earlier_source.id=earlier.channel_id
             WHERE earlier.recipient_kind='agent' AND earlier.recipient_id=a.id
               AND earlier.state='pending' AND earlier.seq<d.seq
               AND (earlier_source.archived=0 OR earlier_message.internal_kind='reminder')
           )
           AND NOT EXISTS (
             SELECT 1 FROM owner_agent_runs retry
             WHERE retry.delivery_id=d.id AND retry.state='failed' AND retry.retry_at>?
           )
         ORDER BY d.seq LIMIT 100`,
      )
      .all(...onlineNodeIds, this.now());
  }

  private beginRun(candidate: RunCandidate): string | undefined {
    const id = randomUUID();
    try {
      return this.db
        .transaction(() => {
          const current = this.db
            .prepare<unknown[], { visibility: "public" | "private" }>(
              `SELECT c.visibility FROM owner_agents a
               JOIN owner_message_deliveries d ON d.recipient_id=a.id AND d.recipient_kind='agent'
               JOIN owner_messages m ON m.id=d.message_id
               JOIN owner_channels c ON c.id=d.channel_id
               WHERE a.id=? AND a.stage='complete'
                 AND ${providerCredentialExistsSql}
                 AND (c.archived=0 OR m.internal_kind='reminder')
                 AND d.id=? AND d.state='pending'`,
            )
            .get(candidate.agent_id, candidate.delivery_id);
          if (!current) return undefined;
          candidate.channel_visibility = current.visibility;
          const inputStart = this.db
            .prepare<unknown[], { seq: number }>(
              `SELECT seq FROM owner_message_deliveries WHERE id=?`,
            )
            .get(candidate.delivery_id);
          if (!inputStart) return undefined;
          const firstDifferentSource = this.db
            .prepare<unknown[], { seq: number | null }>(
              `SELECT MIN(seq) AS seq FROM owner_message_deliveries
               WHERE recipient_id=? AND recipient_kind='agent' AND seq>? AND channel_id<>?`,
            )
            .get(candidate.agent_id, inputStart.seq, candidate.channel_id);
          const maxSequence = this.db
            .prepare<unknown[], { seq: number }>(
              `SELECT COALESCE(MAX(seq),0) AS seq
               FROM owner_message_deliveries WHERE recipient_id=? AND recipient_kind='agent'`,
            )
            .get(candidate.agent_id);
          if (!maxSequence) throw new Error("Message delivery aggregate did not return a row");
          const inputEndSequence =
            firstDifferentSource?.seq === null || firstDifferentSource === undefined
              ? maxSequence.seq
              : firstDifferentSource.seq - 1;
          this.db
            .prepare(
              `INSERT INTO owner_agent_runs(
                 id,agent_id,node_id,delivery_id,state,started_at,input_end_seq,
                 context_history_end_seq
               ) VALUES(?,?,?,?,'running',?,?,?)`,
            )
            .run(
              id,
              candidate.agent_id,
              candidate.node_id,
              candidate.delivery_id,
              this.now(),
              Math.max(inputStart.seq, inputEndSequence),
              maxSequence.seq,
            );
          recordAgentActivity(this.db, {
            agentId: candidate.agent_id,
            nodeId: candidate.node_id,
            kind: "run.started",
            referenceId: id,
            summary: "Agent 运行已开始。",
            at: this.now(),
          });
          return id;
        })
        .immediate();
    } catch {
      // A competing scheduler or the partial unique index already owns this Agent's run.
      return undefined;
    }
  }

  private readRunContext(
    runId: string,
    agentId: string,
  ): import("./session/record.js").ModelContextMessage[] | undefined {
    const run = this.db
      .prepare<
        unknown[],
        {
          input_end_seq: number;
          context_history_end_seq: number;
          delivery_id: string;
          channel_id: string;
        }
      >(
        `SELECT r.input_end_seq,r.context_history_end_seq,r.delivery_id,d.channel_id
         FROM owner_agent_runs r JOIN owner_message_deliveries d ON d.id=r.delivery_id
         WHERE r.id=? AND r.agent_id=? AND r.state='running'`,
      )
      .get(runId, agentId);
    if (!run) return undefined;
    const inputStart = this.db
      .prepare<unknown[], { seq: number }>(`SELECT seq FROM owner_message_deliveries WHERE id=?`)
      .get(run.delivery_id);
    if (!inputStart) return undefined;
    queueUncertainOperationFacts(this.db, agentId, this.now());
    const history = new AgentSession(this.db).context(agentId);
    const input = this.db
      .prepare<
        unknown[],
        {
          id: string;
          text: string;
          created_at: number;
          root_id: string | null;
          quote_id: string | null;
          visibility: string;
        }
      >(
        `SELECT d.id,m.text,m.created_at,m.root_id,m.quote_id,c.visibility
      FROM owner_message_deliveries d JOIN owner_messages m ON m.id=d.message_id
      JOIN owner_channels c ON c.id=d.channel_id
      WHERE d.recipient_kind='agent' AND d.recipient_id=? AND d.channel_id=? AND d.state='pending'
        AND d.seq>=? AND d.seq<=?
        AND NOT EXISTS (SELECT 1 FROM owner_agent_session_records experienced
          WHERE experienced.agent_id=d.recipient_id AND experienced.id=d.id)
        AND (NOT EXISTS (SELECT 1 FROM owner_message_deliveries seed JOIN owner_messages sm ON sm.id=seed.message_id WHERE seed.id=? AND sm.internal_kind='reminder') OR m.internal_kind='reminder')
      ORDER BY d.seq`,
      )
      .all(agentId, run.channel_id, inputStart.seq, run.input_end_seq, run.delivery_id);
    const messages = [
      ...history,
      ...input.map((row) => ({
        id: row.id,
        actionScopeId: run.delivery_id,
        pending: true,
        message: {
          role: "user" as const,
          timestamp: row.created_at,
          content: `[消息来源：频道 ${run.channel_id}；可见范围：${row.visibility === "public" ? "公开" : "私密"}；讨论串：${row.root_id ?? "无"}；引用：${row.quote_id ?? "无"}]\n${row.text}`,
        },
      })),
      // Append pending late-receipt corrections after the admitted input batch.
      ...new AgentSession(this.db).pendingCorrections(agentId, run.delivery_id),
    ];
    return messages;
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
      !!this.db
        .prepare("SELECT 1 FROM owner_agent_runs WHERE id=? AND agent_id=? AND state='running'")
        .get(runId, candidate.agent_id)
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
      const verification = await this.verifyExecutionEnvironment(candidate.agent_id, candidate);
      if (!this.current(active.runId, candidate)) return;
      if (!verification.ok) {
        this.finishRun(
          active.runId,
          candidate.agent_id,
          false,
          "execution_environment",
          verification.error,
        );
        return;
      }
      const messages = this.readRunContext(active.runId, candidate.agent_id);
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
        this.finishRun(
          active.runId,
          candidate.agent_id,
          result.ok,
          result.ok ? undefined : result.code,
          result.ok ? undefined : result.reason,
        );
    } catch {
      if (this.current(active.runId, candidate))
        this.finishRun(active.runId, candidate.agent_id, false, "model_failed");
    }
  }

  private finishRun(
    runId: string,
    agentId: string,
    ok: boolean,
    code?: string,
    reason?: string,
  ): void {
    const existing = this.db
      .prepare<unknown[], { state: string }>(
        "SELECT state FROM owner_agent_runs WHERE id=? AND agent_id=?",
      )
      .get(runId, agentId);
    if (!existing || existing.state !== "running") return;
    if (ok) {
      if (this.chat.completeAgentRun(runId, agentId))
        recordAgentActivity(this.db, {
          agentId,
          kind: "run.completed",
          referenceId: runId,
          summary: "Agent 运行已完成。",
          at: this.now(),
        });
      this.db
        .prepare(
          "UPDATE owner_agent_run_control SET temporary_failures=0,updated_at=? WHERE agent_id=?",
        )
        .run(this.now(), agentId);
      return;
    }
    const interrupted = code === "node_disconnected" || code === "aborted";
    const credentialFailure = code === "credentials_invalid" || code === "model_unavailable";
    const contextFailure = code === "context_failed";
    const environmentFailure = code === "execution_environment";
    let contextPaused = false;
    let delay = 0;
    if (credentialFailure)
      this.db
        .prepare(
          `INSERT INTO owner_agent_run_control(agent_id,paused_reason,updated_at) VALUES(?,'credentials',?)
       ON CONFLICT(agent_id) DO UPDATE SET paused_reason='credentials',updated_at=excluded.updated_at`,
        )
        .run(agentId, this.now());
    else if (!interrupted) {
      const row = this.db
        .prepare<unknown[], { temporary_failures: number }>(
          `INSERT INTO owner_agent_run_control(agent_id,temporary_failures,updated_at) VALUES(?,1,?)
         ON CONFLICT(agent_id) DO UPDATE SET temporary_failures=temporary_failures+1,updated_at=excluded.updated_at
         RETURNING temporary_failures`,
        )
        .get(agentId, this.now());
      if (!row) throw new Error("Run retry update did not return a row");
      delay = Math.min(
        maxRetryDelayMs,
        retryDelayMs * 2 ** Math.min(row.temporary_failures - 1, 16),
      );
      const priorFailure = this.db
        .prepare<unknown[], { error_code: string }>(
          "SELECT error_code FROM owner_agent_runs WHERE agent_id=? AND state='failed' ORDER BY rowid DESC LIMIT 1",
        )
        .get(agentId);
      if (
        contextFailure &&
        row.temporary_failures >= 2 &&
        priorFailure?.error_code === "context_failed"
      ) {
        this.db
          .prepare(
            "UPDATE owner_agent_run_control SET paused_reason='context',updated_at=? WHERE agent_id=?",
          )
          .run(this.now(), agentId);
        contextPaused = true;
      }
    }
    this.db
      .prepare(
        "UPDATE owner_agent_runs SET state='failed',error_code=?,retry_at=?,completed_at=? WHERE id=? AND agent_id=? AND state='running'",
      )
      .run(
        interrupted ? "interrupted" : safeFailureCode(code),
        credentialFailure || contextPaused ? null : this.now() + delay,
        this.now(),
        runId,
        agentId,
      );
    recordAgentActivity(this.db, {
      agentId,
      kind: interrupted ? "run.interrupted" : "run.failed",
      referenceId: runId,
      summary: interrupted
        ? "运行因连接中断而停止；待处理消息仍在队列中。"
        : credentialFailure
          ? "模型凭据或模型配置需要所有者处理，运行已暂停。"
          : contextPaused
            ? "上下文压缩连续失败，运行已暂停；请检查模型容量或摘要响应。"
            : environmentFailure
              ? "原节点运行账号或 Agent 工作区未通过核验；保留队列，稍后退避重试。"
              : "模型服务暂时失败，稍后退避重试。",
      detail: {
        code: safeFailureCode(code),
        ...((contextFailure || environmentFailure) && reason ? { reason } : {}),
      },
      at: this.now(),
    });
  }

  private recoverInterruptedRuns(): void {
    this.db
      .transaction(() => {
        const at = this.now();
        const interrupted = this.db
          .prepare<unknown[], { id: string; agent_id: string; node_id: string }>(
            `UPDATE owner_agent_runs SET state='failed',error_code='interrupted',retry_at=?,completed_at=?
           WHERE state='running' RETURNING id,agent_id,node_id`,
          )
          .all(at, at);
        for (const run of interrupted)
          recordAgentActivity(this.db, {
            agentId: run.agent_id,
            nodeId: run.node_id,
            kind: "run.interrupted",
            referenceId: run.id,
            summary: "控制面重启中断了运行；待处理消息仍在队列中。",
            at,
          });
      })
      .immediate();
  }
}

function safeFailureCode(code: string | undefined): string {
  return code && /^[a-z_]{1,40}$/.test(code) ? code : "run_failed";
}

/** The scope a node's stop receipt named, when it named one. */
function receiptScope(receipt: unknown): string | undefined {
  const scope = receiptFields(receipt)?.scope;
  return typeof scope === "string" ? scope : undefined;
}

/**
 * Every command whose termination is still unproven: the durable rows nothing has settled, plus the
 * operation IDs the node's own stop receipt named as process groups it could not end. The two sets
 * come from different questions — "what did the control plane never see finished" and "what did this
 * stop fail to kill" — and the owner needs both.
 */
function unconfirmedCommandIds(receipt: unknown, durable: string[]): string[] {
  const reported = receiptFields(receipt)?.unconfirmedOperationIds;
  const ids = new Set(durable);
  if (Array.isArray(reported)) for (const id of reported) if (typeof id === "string") ids.add(id);
  return [...ids];
}

function parseReceipt(receiptJson: string | null): unknown {
  try {
    return receiptJson === null ? undefined : JSON.parse(receiptJson);
  } catch {
    return undefined;
  }
}

/** Whether a durable operation row describes a command that really launched a shell. */
function startedACommand(requestJson: string): boolean {
  try {
    return receiptFields(receiptFields(JSON.parse(requestJson))?.operation)?.kind === "exec";
  } catch {
    return false;
  }
}

// Receipts from interrupted operations can be incomplete. Inspect fields without inventing a
// complete success/error shape or treating missing evidence as a definite outcome.
const receiptFieldsSchema = z.record(z.string(), z.unknown());
function receiptFields(value: unknown) {
  const parsed = receiptFieldsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
