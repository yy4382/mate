import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NodeDirectory } from "../../nodes/directory.js";
import { recordAgentActivity } from "../activity.js";
import { AgentSession } from "../session/service.js";

export class RunControl {
  private readonly activeStops = new Set<string>();
  constructor(
    private readonly db: Database.Database,
    private readonly nodes: NodeDirectory,
    private readonly now: () => number,
    private readonly isClosed: () => boolean,
  ) {}
  pauseAgent(agentId: string) {
    const agent = this.db
      .prepare<unknown[], { id: string; node_id: string }>(
        "SELECT id,node_id FROM owner_agents WHERE id=?",
      )
      .get(agentId);
    if (!agent) return undefined;
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
    return { runId: pending?.id, stopId, nodeId: agent.node_id };
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
    const receipt = parseReceipt(row.receipt_json) ?? { reason: "stop_receipt_unreadable" };
    const scope = receiptScope(receipt);
    const unconfirmedOperationIds = unconfirmedCommandIds(
      receipt,
      this.unconfirmedCommands(agentId),
    );
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

  activateEnabledAgents(): void {
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

  async dispatchPendingStops(mode: "settled_receipts" | "node_ready"): Promise<void> {
    if (this.isClosed()) return;
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
        void this.dispatchStop({ operationId: nextId, agentId: row.agent_id, nodeId: row.node_id });
      } else if (mode === "node_ready" && row.state === "unknown") {
        // A node may have durably returned unknown for the old ID. A fresh idempotent stop
        // request rechecks all scopes after the node has finished receipt reconciliation.
        const nextId = randomUUID();
        this.db
          .prepare(
            "INSERT INTO owner_agent_stop_intents(operation_id,agent_id,node_id,state,created_at,updated_at) VALUES(?,?,?,'executing',?,?)",
          )
          .run(nextId, row.agent_id, row.node_id, this.now(), this.now());
        void this.dispatchStop({ operationId: nextId, agentId: row.agent_id, nodeId: row.node_id });
      } else if (mode === "node_ready")
        void this.dispatchStop({
          operationId: row.operation_id,
          agentId: row.agent_id,
          nodeId: row.node_id,
        });
    }
  }

  async dispatchStop({
    operationId,
    agentId,
    nodeId,
  }: {
    operationId: string;
    agentId: string;
    nodeId: string;
  }): Promise<void> {
    if (this.activeStops.has(operationId)) return;
    this.activeStops.add(operationId);
    try {
      const result = await this.nodes.operations.executeAgentProcessOperation(nodeId, {
        operationId,
        agentId,
        operation: { kind: "process.stop_all" },
      });
      if (this.isClosed()) return;
      this.reconcileStop(nodeId, result);
    } catch {
      if (this.isClosed()) return;
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

  reconcileStop(
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

  async resumeAgent(
    agentId: string,
    onResumed: () => void,
  ): Promise<{ ok: boolean; error?: string }> {
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
    onResumed();
    return { ok: true };
  }

  async verifyExecutionEnvironment(
    agentId: string,
    row: { node_id: string; home: string | null; home_marker: string | null },
  ): Promise<{ ok: boolean; error?: string }> {
    let verified;
    try {
      verified = await this.nodes.operations.provisionAgent({
        nodeId: row.node_id,
        requestId: randomUUID(),
        agentId,
        onProgress: () => {},
        verifyOnly: true,
      });
    } catch {
      return { ok: false, error: "原节点未能核验运行账号与 Agent 工作区，请恢复原节点后重试。" };
    }
    // Re-verify against the node's recorded account plus this Agent's own workspace and marker.
    const nodeAccount = this.nodes.identity.account(row.node_id);
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
