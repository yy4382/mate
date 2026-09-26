import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ModelCredentialDirectory } from "./model-credentials.js";
import type { AgentRunContextPage, OwnerChat } from "./owner-chat.js";
import { NodeDirectory, type NodeAgentRunStart } from "./nodes/directory.js";
import {
  AgentProcessOperationBroker,
  deriveAgentProcessOperationId,
} from "./agent-process-operations.js";
import {
  agentConversationOperations,
  agentProcessToolOperations,
  agentToolSchemas,
} from "./agent-tools.js";
import { z } from "zod";
import { recordAgentActivity } from "./activity.js";
import { PrivilegedApprovals } from "./privileged-approvals.js";
import { agentSystemToolOperations } from "./agent-tools.js";

const schedulerIntervalMs = 250;
const retryDelayMs = 1500;
const maxRetryDelayMs = 5 * 60_000;

interface RunCandidate {
  agent_id: string;
  node_id: string;
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
  private readonly activeAgents = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private draining = false;
  private closed = false;
  private readonly now: () => number;
  readonly processOperations: AgentProcessOperationBroker;

  constructor(
    private readonly db: Database.Database,
    private readonly nodes: NodeDirectory,
    private readonly credentials: ModelCredentialDirectory,
    private readonly chat: OwnerChat,
    private readonly approvals: PrivilegedApprovals,
    now: () => number = Date.now,
  ) {
    this.now = now;
    this.processOperations = new AgentProcessOperationBroker(db, nodes, now);
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
    nodes.setAgentRunHandlers({
      context: (runId, agentId, cursor, limit) =>
        this.readRunContext(runId, agentId, cursor, limit),
      journal: (runId, nodeId, agentId, requestId, text, replayOnly) =>
        chat.commitAgentReply(runId, nodeId, agentId, requestId, text, replayOnly),
      tool: (runId, nodeId, agentId, toolCallId, operation, input) =>
        this.executeAgentTool(runId, nodeId, agentId, toolCallId, operation, input),
      result: (runId, agentId, ok, code) => this.finishRun(runId, agentId, ok, code),
    });
    this.timer = setInterval(() => this.wake(), schedulerIntervalMs);
    this.timer.unref?.();
    this.wake();
  }

  private async executeAgentTool(
    runId: string,
    nodeId: string,
    agentId: string,
    toolCallId: string,
    operation: string,
    input: Record<string, unknown>,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    if (operation !== "tools.call")
      return this.chat.executeAgentTool(runId, nodeId, agentId, toolCallId, operation, input);
    const request = agentToolSchemas["tools.call"].safeParse(input);
    if (request.success && request.data.name === "session.compact") {
      try {
        return {
          ok: true,
          result: this.commitCompaction(runId, nodeId, agentId, toolCallId, request.data.input),
        };
      } catch {
        return { ok: false, error: "Session compaction was refused" };
      }
    }
    if (request.success && request.data.name === "system.exec") {
      try {
        const command = agentSystemToolOperations["system.exec"].schema.parse(request.data.input);
        const channelId = this.chat.authorizeAgentPrivilegedOperation(runId, nodeId, agentId);
        const requestId = deriveAgentProcessOperationId(agentId, toolCallId);
        const approval = this.approvals.request({
          requestId,
          agentId,
          nodeId,
          channelId,
          program: command.program,
          args: command.args,
          cwd: command.cwd,
        });
        return {
          ok: true,
          result: { requestId, state: approval.state, expiresAt: approval.expiresAt },
        };
      } catch {
        return { ok: false, error: "系统特权请求被拒绝。" };
      }
    }
    if (request.success && request.data.name === "system.status") {
      try {
        this.chat.authorizeAgentPrivilegedOperation(runId, nodeId, agentId);
        const { requestId } = agentSystemToolOperations["system.status"].schema.parse(
          request.data.input,
        );
        const approval = this.approvals.status(requestId);
        if (!approval || approval.agentId !== agentId)
          throw new Error("Unknown privileged request");
        return {
          ok: true,
          result: { requestId, state: approval.state, receipt: approval.receipt },
        };
      } catch {
        return { ok: false, error: "系统特权请求不可访问。" };
      }
    }
    if (!request.success || !Object.hasOwn(agentProcessToolOperations, request.data.name))
      return this.chat.executeAgentTool(runId, nodeId, agentId, toolCallId, operation, input);

    try {
      const authorized = this.chat.authorizeAgentProcessOperation(
          runId,
          nodeId,
          agentId,
          request.data.name,
          request.data.input,
        ),
        operationId = deriveAgentProcessOperationId(agentId, toolCallId),
        result = await this.processOperations.execute({
          runId,
          nodeId,
          agentId,
          actionScopeId: authorized.actionScopeId,
          stableActionId: toolCallId,
          operationId,
          operation: authorized.operation,
        });
      return {
        ok: true,
        result: { operationId: result.operationId, state: result.state, receipt: result.receipt },
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof z.ZodError ? "Invalid tool input" : "Agent tool request was refused",
      };
    }
  }

  private commitCompaction(
    runId: string,
    nodeId: string,
    agentId: string,
    actionId: string,
    input: unknown,
  ): unknown {
    const { summary, snapshot } =
      agentConversationOperations["session.compact"].schema.parse(input);
    const snapshotJson = JSON.stringify(snapshot);
    if (summary.length + snapshotJson.length > 19_000) throw new Error("Snapshot is too large");
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ summary, snapshot }))
      .digest("hex");
    return this.db
      .transaction(() => {
        const run = this.db
          .prepare(
            `SELECT r.delivery_id,r.context_history_end_seq,r.input_end_seq,r.independent_review,s.id AS logical_session_id
         FROM owner_agent_runs r JOIN owner_agent_sessions s ON s.agent_id=r.agent_id
         WHERE r.id=? AND r.node_id=? AND r.agent_id=? AND r.state='running'`,
          )
          .get(runId, nodeId, agentId) as
          | {
              delivery_id: string;
              context_history_end_seq: number;
              input_end_seq: number;
              independent_review: number;
              logical_session_id: string;
            }
          | undefined;
        if (
          !run ||
          run.independent_review ||
          run.context_history_end_seq < 1 ||
          !actionId.startsWith(`mate:${run.delivery_id}:`)
        )
          throw new Error("Run cannot compact session");
        const old = this.db
          .prepare(
            `SELECT request_hash,model_session_id,through_seq FROM owner_agent_session_snapshots
         WHERE agent_id=? AND action_id=?`,
          )
          .get(agentId, actionId) as
          { request_hash: string; model_session_id: string; through_seq: number } | undefined;
        if (old) {
          if (old.request_hash !== requestHash)
            throw new Error("Compaction action identity conflict");
          return {
            committed: true,
            effective: "next_run",
            sessionId: old.model_session_id,
            throughSequence: old.through_seq,
          };
        }
        // A later source can already be journaled but still be pending and unseen by this run.
        // Keep it beyond the snapshot boundary so delivery can later become visible history.
        const throughSequence = Math.min(run.context_history_end_seq, run.input_end_seq),
          modelSessionId = randomUUID(),
          at = this.now();
        this.db
          .prepare(
            `INSERT INTO owner_agent_session_snapshots(
          id,agent_id,action_id,request_hash,through_seq,model_session_id,summary,snapshot_json,created_at
         ) VALUES(?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            randomUUID(),
            agentId,
            actionId,
            requestHash,
            throughSequence,
            modelSessionId,
            summary,
            snapshotJson,
            at,
          );
        this.db
          .prepare("UPDATE owner_agent_sessions SET model_session_id=? WHERE id=?")
          .run(modelSessionId, run.logical_session_id);
        recordAgentActivity(this.db, {
          agentId,
          nodeId,
          kind: "session.compacted",
          referenceId: modelSessionId,
          summary: "会话摘要和快照已由控制面确认；下一次运行使用新模型会话。",
          detail: { summary, snapshot, throughSequence },
          at,
        });
        return {
          committed: true,
          effective: "next_run",
          sessionId: modelSessionId,
          throughSequence,
        };
      })
      .immediate();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
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
    const running = this.db
      .prepare(
        `SELECT r.id,a.id AS agent_id FROM owner_agent_runs r
         JOIN owner_agents a ON a.id=r.agent_id
         WHERE r.state='running' AND a.provider=?`,
      )
      .all(provider) as Array<{ id: string; agent_id: string }>;
    for (const run of running) this.invalidateRun(run.id, run.agent_id);
    return running.length;
  }

  modelChanged(agentId: string): void {
    this.db
      .prepare(
        "UPDATE owner_agent_run_control SET paused_reason=NULL,temporary_failures=0,updated_at=? WHERE agent_id=? AND paused_reason='credentials'",
      )
      .run(this.now(), agentId);
    const running = this.db
      .prepare("SELECT id FROM owner_agent_runs WHERE agent_id=? AND state='running'")
      .all(agentId) as Array<{ id: string }>;
    for (const run of running) this.invalidateRun(run.id, agentId);
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
    this.nodes.cancelAgentRun(runId, agentId, "credentials_changed");
  }

  pauseAgent(agentId: string): boolean {
    const agent = this.db.prepare("SELECT id,node_id FROM owner_agents WHERE id=?").get(agentId) as
      { id: string; node_id: string } | undefined;
    if (!agent) return false;
    let stopId: string | undefined;
    this.db
      .transaction(() => {
        const existing = this.db
          .prepare("SELECT paused_reason FROM owner_agent_run_control WHERE agent_id=?")
          .get(agentId) as { paused_reason: string | null } | undefined;
        const lastStop = this.stopStatus(agentId);
        if (
          existing?.paused_reason !== "manual" ||
          (lastStop.state === "unknown" &&
            (lastStop.receipt as { reason?: string } | null)?.reason !==
              "pending_process_receipts") ||
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
      .prepare(
        `SELECT id FROM owner_agent_runs WHERE agent_id=? AND error_code='manual_pause' ORDER BY started_at DESC LIMIT 1`,
      )
      .get(agentId) as { id: string } | undefined;
    if (pending) this.nodes.cancelAgentRun(pending.id, agentId, "manual_pause");
    if (stopId) void this.dispatchStop(stopId, agentId, agent.node_id);
    return true;
  }

  stopStatus(agentId: string): { state: string; receipt: unknown | null } {
    const row = this.db
      .prepare(
        "SELECT state,receipt_json FROM owner_agent_stop_intents WHERE agent_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get(agentId) as { state: string; receipt_json: string | null } | undefined;
    return row
      ? { state: row.state, receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null }
      : { state: "unknown", receipt: { reason: "stop_not_confirmed" } };
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
      .prepare(
        `SELECT a.id,a.node_id FROM owner_agents a
       LEFT JOIN owner_agent_run_control c ON c.agent_id=a.id
       WHERE c.paused_reason IS NULL OR c.paused_reason<>'manual'`,
      )
      .all() as Array<{ id: string; node_id: string }>;
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
      .prepare(
        `SELECT s.operation_id,s.agent_id,s.node_id,s.state,s.receipt_json
         FROM owner_agent_stop_intents s
         JOIN owner_agent_run_control c ON c.agent_id=s.agent_id AND c.paused_reason='manual'
         WHERE s.state IN ('executing','unknown') AND NOT EXISTS (
           SELECT 1 FROM owner_agent_stop_intents later
           WHERE later.agent_id=s.agent_id AND later.rowid>s.rowid)`,
      )
      .all() as Array<{
      operation_id: string;
      agent_id: string;
      node_id: string;
      state: string;
      receipt_json: string | null;
    }>;
    for (const row of rows) {
      const reason = row.receipt_json
        ? (JSON.parse(row.receipt_json) as { reason?: string }).reason
        : undefined;
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
              summary: "后台进程停止结果未知；请检查节点连接与操作收据。",
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
      .prepare("SELECT agent_id,node_id,state FROM owner_agent_stop_intents WHERE operation_id=?")
      .get(result.operationId) as { agent_id: string; node_id: string; state: string } | undefined;
    if (!row) return false;
    if (row.node_id !== nodeId || row.agent_id !== result.agentId) return true;
    if (row.state !== "succeeded" && row.state !== "failed")
      this.db
        .transaction(() => {
          const unsettled =
            result.state === "succeeded" && this.unsettledProcessReceipt(result.agentId);
          const state = unsettled ? "unknown" : result.state;
          const receipt = unsettled ? { reason: "pending_process_receipts" } : result.receipt;
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
          recordAgentActivity(this.db, {
            agentId: result.agentId,
            nodeId,
            kind: "operation.finished",
            referenceId: result.operationId,
            summary:
              state === "succeeded"
                ? "后台进程已确认停止。"
                : state === "failed"
                  ? "后台进程停止失败；保持停用，请检查节点诊断。"
                  : "后台进程停止结果未知；请检查节点诊断。",
            detail: { state, receipt },
            at: this.now(),
          });
        })
        .immediate();
    return true;
  }

  async resumeAgent(agentId: string): Promise<{ ok: boolean; error?: string }> {
    const row = this.db
      .prepare(
        `SELECT a.node_id,a.linux_username,a.uid,a.gid,a.home,a.home_marker,c.paused_reason
       FROM owner_agents a JOIN owner_agent_run_control c ON c.agent_id=a.id WHERE a.id=?`,
      )
      .get(agentId) as
      | {
          node_id: string;
          linux_username: string | null;
          uid: number | null;
          gid: number | null;
          home: string | null;
          home_marker: string | null;
          paused_reason: string | null;
        }
      | undefined;
    if (row?.paused_reason !== "manual") return { ok: false, error: "Agent 尚未停用。" };
    const stop = this.stopStatus(agentId);
    if (stop.state !== "succeeded")
      return { ok: false, error: "后台进程停止结果尚未确认，请检查节点诊断。" };
    if (this.unsettledProcessReceipt(agentId))
      return { ok: false, error: "仍有普通操作收据待对账，暂不能复启。" };
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
      return { ok: false, error: "原节点未能核验 Agent 身份与 home，请恢复原节点后重试。" };
    }
    if (
      !verified.ok ||
      !row.home_marker ||
      verified.identity.homeMarker !== row.home_marker ||
      verified.identity.username !== row.linux_username ||
      verified.identity.uid !== row.uid ||
      verified.identity.gid !== row.gid ||
      verified.identity.home !== row.home
    )
      return { ok: false, error: "原 Linux 身份或 home 已缺失或改变；保持停用，请修复原数据。" };
    if (this.stopStatus(agentId).state !== "succeeded" || this.pauseReason(agentId) !== "manual")
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

  pauseReason(agentId: string): string | null {
    const row = this.db
      .prepare("SELECT paused_reason FROM owner_agent_run_control WHERE agent_id=?")
      .get(agentId) as { paused_reason: string | null } | undefined;
    return row?.paused_reason ?? null;
  }

  private async drain(): Promise<void> {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      this.chat.fireDueReminders();
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
        this.activeAgents.add(candidate.agent_id);
        const request: NodeAgentRunStart = {
          type: "control.agent.run",
          requestId: runId,
          runId,
          agentId: candidate.agent_id,
          sessionId: candidate.session_id,
          actionScopeId: candidate.delivery_id,
          provider: candidate.provider,
          modelId: candidate.model_id,
          apiKey,
          channelId: candidate.channel_id,
          channelVisibility: candidate.channel_visibility,
          prompt: {
            name: candidate.name,
            role: candidate.role,
            description: candidate.description,
          },
        };
        void this.nodes
          .runAgent(candidate.node_id, request)
          .catch(() => {
            if (!this.closed) this.finishRun(runId, candidate.agent_id, false, "node_disconnected");
          })
          .finally(() => {
            this.activeAgents.delete(candidate.agent_id);
            if (!this.closed) this.wake();
          });
      }
    } finally {
      this.draining = false;
    }
  }

  private pendingCandidates(onlineNodeIds: string[]): RunCandidate[] {
    if (onlineNodeIds.length === 0) return [];
    const onlineNodePlaceholders = onlineNodeIds.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT a.id AS agent_id,a.node_id,COALESCE(s.model_session_id,s.id) AS session_id,a.name,a.role,a.description,
                a.provider,a.model_id,d.channel_id,c.visibility AS channel_visibility,
                d.id AS delivery_id
         FROM owner_message_deliveries d
         JOIN owner_messages m ON m.id=d.message_id
         JOIN owner_agents a ON a.id=d.recipient_id
         JOIN owner_agent_sessions s ON s.agent_id=a.id
         JOIN owner_channels c ON c.id=d.channel_id
         JOIN owner_agent_session_journal j
           ON j.agent_id=a.id AND j.message_id=d.message_id AND j.role='user'
         WHERE d.recipient_kind='agent' AND d.state='pending'
           AND (c.archived=0 OR m.internal_kind='reminder')
           AND a.node_id IN (${onlineNodePlaceholders})
           AND a.status='waiting_credentials' AND a.model_ready=1
           AND NOT EXISTS (SELECT 1 FROM owner_agent_run_control ctl WHERE ctl.agent_id=a.id AND ctl.paused_reason IS NOT NULL)
           AND NOT EXISTS (SELECT 1 FROM owner_agent_recovery_holds hold WHERE hold.agent_id=a.id)
           AND EXISTS (SELECT 1 FROM model_credentials c WHERE c.provider=a.provider)
           AND NOT EXISTS (SELECT 1 FROM owner_agent_runs r WHERE r.agent_id=a.id AND r.state='running')
           AND NOT EXISTS (
             SELECT 1 FROM owner_message_deliveries earlier
             JOIN owner_messages earlier_message ON earlier_message.id=earlier.message_id
             JOIN owner_channels earlier_source
               ON earlier_source.id=earlier.channel_id
             WHERE earlier.recipient_kind='agent' AND earlier.recipient_id=a.id
               AND earlier.state='pending' AND earlier.seq<d.seq
               AND (earlier_source.archived=0 OR earlier_message.internal_kind='reminder')
               AND EXISTS (
                 SELECT 1 FROM owner_agent_session_journal prior
                 WHERE prior.agent_id=a.id AND prior.message_id=earlier.message_id
                   AND prior.role='user'
               )
           )
           AND NOT EXISTS (
             SELECT 1 FROM owner_agent_runs retry
             WHERE retry.delivery_id=d.id AND retry.state='failed' AND retry.retry_at>?
           )
         ORDER BY d.seq LIMIT 100`,
      )
      .all(...onlineNodeIds, this.now()) as RunCandidate[];
  }

  private beginRun(candidate: RunCandidate): string | undefined {
    const id = randomUUID();
    try {
      return this.db
        .transaction(() => {
          const current = this.db
            .prepare(
              `SELECT c.visibility FROM owner_agents a
               JOIN owner_message_deliveries d ON d.recipient_id=a.id AND d.recipient_kind='agent'
               JOIN owner_messages m ON m.id=d.message_id
               JOIN owner_agent_session_journal j
                 ON j.agent_id=a.id AND j.message_id=d.message_id AND j.role='user'
               JOIN owner_channels c ON c.id=d.channel_id
               WHERE a.id=? AND a.status='waiting_credentials' AND a.model_ready=1
                 AND (c.archived=0 OR m.internal_kind='reminder')
                 AND d.id=? AND d.state='pending'`,
            )
            .get(candidate.agent_id, candidate.delivery_id) as
            { visibility: "public" | "private" } | undefined;
          if (!current) return undefined;
          candidate.channel_visibility = current.visibility;
          const inputStart = this.db
            .prepare(
              `SELECT j.seq FROM owner_message_deliveries d
               JOIN owner_agent_session_journal j
                 ON j.agent_id=d.recipient_id AND j.message_id=d.message_id AND j.role='user'
               WHERE d.id=?`,
            )
            .get(candidate.delivery_id) as { seq: number } | undefined;
          if (!inputStart) return undefined;
          const firstDifferentSource = this.db
            .prepare(
              `SELECT MIN(seq) AS seq FROM owner_agent_session_journal
               WHERE agent_id=? AND role='user' AND seq>? AND channel_id<>?`,
            )
            .get(candidate.agent_id, inputStart.seq, candidate.channel_id) as
            { seq: number | null } | undefined;
          const maxSequence = this.db
            .prepare(
              `SELECT COALESCE(MAX(seq),0) AS seq
               FROM owner_agent_session_journal WHERE agent_id=?`,
            )
            .get(candidate.agent_id) as { seq: number };
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
    cursor: number,
    limit: number,
  ): AgentRunContextPage | undefined {
    const run = this.db
      .prepare(
        `SELECT r.input_end_seq,r.context_history_end_seq,r.delivery_id,d.channel_id
         FROM owner_agent_runs r JOIN owner_message_deliveries d ON d.id=r.delivery_id
         WHERE r.id=? AND r.agent_id=? AND r.state='running'`,
      )
      .get(runId, agentId) as
      | {
          input_end_seq: number;
          context_history_end_seq: number;
          delivery_id: string;
          channel_id: string;
        }
      | undefined;
    if (!run) return undefined;
    const inputStart = this.db
      .prepare(
        `SELECT j.seq FROM owner_message_deliveries d
         JOIN owner_agent_session_journal j
           ON j.agent_id=d.recipient_id AND j.message_id=d.message_id AND j.role='user'
         WHERE d.id=?`,
      )
      .get(run.delivery_id) as { seq: number } | undefined;
    return inputStart
      ? this.chat.listAgentRunContext(
          agentId,
          cursor,
          limit,
          run.context_history_end_seq,
          run.channel_id,
          inputStart.seq,
          run.input_end_seq,
        )
      : undefined;
  }

  private finishRun(runId: string, agentId: string, ok: boolean, code?: string): void {
    const existing = this.db
      .prepare("SELECT state FROM owner_agent_runs WHERE id=? AND agent_id=?")
      .get(runId, agentId) as { state: string } | undefined;
    if (!existing || existing.state !== "running") return;
    if (ok) {
      if (this.chat.completeAgentRunSilently(runId, agentId))
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
        .prepare(
          `INSERT INTO owner_agent_run_control(agent_id,temporary_failures,updated_at) VALUES(?,1,?)
         ON CONFLICT(agent_id) DO UPDATE SET temporary_failures=temporary_failures+1,updated_at=excluded.updated_at
         RETURNING temporary_failures`,
        )
        .get(agentId, this.now()) as { temporary_failures: number };
      delay = Math.min(
        maxRetryDelayMs,
        retryDelayMs * 2 ** Math.min(row.temporary_failures - 1, 16),
      );
    }
    this.db
      .prepare(
        "UPDATE owner_agent_runs SET state='failed',error_code=?,retry_at=?,completed_at=? WHERE id=? AND agent_id=? AND state='running'",
      )
      .run(
        interrupted ? "interrupted" : safeFailureCode(code),
        credentialFailure ? null : this.now() + delay,
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
          : "模型服务暂时失败，稍后退避重试。",
      detail: { code: safeFailureCode(code) },
      at: this.now(),
    });
  }

  private recoverInterruptedRuns(): void {
    this.db
      .transaction(() => {
        const at = this.now();
        const interrupted = this.db
          .prepare(
            `UPDATE owner_agent_runs SET state='failed',error_code='interrupted',retry_at=?,completed_at=?
           WHERE state='running' RETURNING id,agent_id,node_id`,
          )
          .all(at, at) as Array<{ id: string; agent_id: string; node_id: string }>;
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

export type AgentRunContext = AgentRunContextPage;
