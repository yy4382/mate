import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { recordAgentActivity } from "./activity.js";
import {
  agentProcessOperationSchema,
  type AgentProcessOperation,
  type AgentProcessOperationState,
} from "../nodes/process-operations.js";

const uuidSchema = z.string().uuid();
const stableActionIdSchema = z
  .string()
  .regex(
    /^mate:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{64}):([1-9][0-9]{0,8})$/i,
  );

export interface AgentProcessNodeResult {
  operationId: string;
  agentId: string;
  state: Exclude<AgentProcessOperationState, "started">;
  receipt: unknown | null;
}

export interface AgentProcessNodePort {
  executeAgentProcessOperation(
    nodeId: string,
    request: { operationId: string; agentId: string; operation: AgentProcessOperation },
  ): Promise<AgentProcessNodeResult>;
}

export interface AgentProcessOperationRequest {
  runId: string;
  nodeId: string;
  agentId: string;
  actionScopeId: string;
  stableActionId: string;
  operationId: string;
  operation: unknown;
}

export interface AgentProcessOperationResult {
  operationId: string;
  agentId: string;
  state: "executing" | Exclude<AgentProcessOperationState, "started">;
  receipt: unknown | null;
}

interface OperationRow {
  operation_id: string;
  run_id: string;
  agent_id: string;
  node_id: string;
  stable_action_id: string;
  request_hash: string;
  request_json: string;
  state: "executing" | Exclude<AgentProcessOperationState, "started">;
  receipt_json: string | null;
}

/**
 * The control-plane half of the ordinary process broker. It commits an immutable intent before
 * sending the stable operation ID to a node, then stores the receipt or an explicit unknown.
 */
export class AgentProcessOperationBroker {
  private readonly inFlight = new Map<string, Promise<AgentProcessOperationResult>>();

  constructor(
    private readonly database: Database.Database,
    private readonly nodes: AgentProcessNodePort,
    private readonly now: () => number = Date.now,
  ) {
    database.pragma("synchronous = FULL");
  }

  async execute(request: AgentProcessOperationRequest): Promise<AgentProcessOperationResult> {
    const runId = uuidSchema.parse(request.runId),
      nodeId = uuidSchema.parse(request.nodeId),
      agentId = uuidSchema.parse(request.agentId),
      actionScopeId = uuidSchema.parse(request.actionScopeId),
      stableActionId = stableActionIdSchema.parse(request.stableActionId),
      operationId = uuidSchema.parse(request.operationId),
      operation = agentProcessOperationSchema.parse(request.operation),
      requestJson = JSON.stringify({ actionScopeId, stableActionId, nodeId, agentId, operation }),
      requestHash = createHash("sha256").update(requestJson).digest("hex");
    if (stableActionScopeId(stableActionId) !== actionScopeId)
      throw new Error("Agent process action scope does not match the active delivery");
    if (operationId !== deriveAgentProcessOperationId(agentId, stableActionId))
      throw new Error("Agent process operation ID does not match its stable action identity");

    const row = this.database
      .transaction(() => {
        this.assertActiveRun(runId, nodeId, agentId, actionScopeId);
        const existing = this.read(operationId);
        if (existing) {
          if (
            existing.agent_id !== agentId ||
            existing.node_id !== nodeId ||
            existing.request_hash !== requestHash
          )
            throw new Error("Agent process operation identity conflict");
          if (existing.state === "succeeded" || existing.state === "failed") return existing;
          this.database
            .prepare(
              "UPDATE owner_agent_process_operations SET state='executing',updated_at=? WHERE operation_id=? AND state='unknown'",
            )
            .run(this.now(), operationId);
          return this.read(operationId)!;
        }
        this.database
          .prepare(
            `INSERT INTO owner_agent_process_operations(
              operation_id,run_id,agent_id,node_id,action_scope_id,stable_action_id,
              request_hash,request_json,state,created_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,'executing',?,?)`,
          )
          .run(
            operationId,
            runId,
            agentId,
            nodeId,
            actionScopeId,
            stableActionId,
            requestHash,
            requestJson,
            this.now(),
            this.now(),
          );
        recordAgentActivity(this.database, {
          agentId,
          nodeId,
          kind: "operation.started",
          referenceId: operationId,
          summary: "普通操作已提交节点执行。",
          detail: { operation },
          at: this.now(),
        });
        return this.read(operationId)!;
      })
      .immediate();

    if (row.state === "succeeded" || row.state === "failed") return toResult(row);
    const active = this.inFlight.get(operationId);
    if (active) return active;
    const dispatch = this.dispatch(nodeId, { operationId, agentId, operation });
    this.inFlight.set(operationId, dispatch);
    const clear = () => {
      if (this.inFlight.get(operationId) === dispatch) this.inFlight.delete(operationId);
    };
    void dispatch.then(clear, clear);
    return dispatch;
  }

  /** Read the durable CP receipt as a seam for late-result reconciliation. */
  status(agentId: string, operationId: string): AgentProcessOperationResult | undefined {
    const parsedAgentId = uuidSchema.parse(agentId),
      parsedOperationId = uuidSchema.parse(operationId),
      row = this.read(parsedOperationId);
    if (!row || row.agent_id !== parsedAgentId) return undefined;
    return toResult(row);
  }

  /** Accept only a receipt for a control-plane intent assigned to this node. */
  reconcile(
    nodeId: string,
    result: AgentProcessNodeResult,
    onCorrection?: (agentId: string, operationId: string, state: "succeeded" | "failed") => void,
  ): { corrected: boolean; result?: AgentProcessOperationResult } {
    const row = this.read(uuidSchema.parse(result.operationId));
    if (
      !row ||
      row.node_id !== uuidSchema.parse(nodeId) ||
      row.agent_id !== uuidSchema.parse(result.agentId)
    )
      return { corrected: false };
    if (row.state === "succeeded" || row.state === "failed")
      return { corrected: false, result: toResult(row) };
    if (result.state === "unknown" && row.state === "unknown")
      return { corrected: false, result: toResult(row) };
    this.database
      .transaction(() => {
        this.database
          .prepare(
            `UPDATE owner_agent_process_operations SET state=?,receipt_json=?,updated_at=?
         WHERE operation_id=? AND state IN ('executing','unknown')`,
          )
          .run(
            result.state,
            result.receipt === null ? null : JSON.stringify(result.receipt),
            this.now(),
            result.operationId,
          );
        this.appendSessionResult(this.read(result.operationId)!);
        recordAgentActivity(this.database, {
          agentId: row.agent_id,
          nodeId: row.node_id,
          kind:
            row.state === "unknown" && result.state !== "unknown"
              ? "receipt.corrected"
              : "operation.finished",
          referenceId: row.operation_id,
          summary:
            result.state === "unknown"
              ? "操作结果尚无可靠证据。"
              : `操作收据已核对：${result.state === "succeeded" ? "成功" : "失败"}。`,
          detail: { state: result.state, receipt: result.receipt },
          at: this.now(),
        });
        if (row.state === "unknown" && result.state !== "unknown")
          onCorrection?.(row.agent_id, row.operation_id, result.state);
      })
      .immediate();
    return {
      corrected: row.state === "unknown" && result.state !== "unknown",
      result: toResult(this.read(result.operationId)!),
    };
  }

  private async dispatch(
    nodeId: string,
    request: { operationId: string; agentId: string; operation: AgentProcessOperation },
  ): Promise<AgentProcessOperationResult> {
    let result: AgentProcessNodeResult;
    try {
      result = await this.nodes.executeAgentProcessOperation(nodeId, request);
    } catch {
      result = {
        operationId: request.operationId,
        agentId: request.agentId,
        state: "unknown",
        receipt: { reason: "node_response_unavailable" },
      };
    }
    if (result.operationId !== request.operationId || result.agentId !== request.agentId)
      result = {
        operationId: request.operationId,
        agentId: request.agentId,
        state: "unknown",
        receipt: { reason: "node_receipt_identity_mismatch" },
      };
    this.database
      .transaction(() => {
        this.database
          .prepare(
            `UPDATE owner_agent_process_operations SET state=?,receipt_json=?,updated_at=?
           WHERE operation_id=? AND state IN ('executing','unknown')`,
          )
          .run(
            result.state,
            result.receipt === null ? null : JSON.stringify(result.receipt),
            this.now(),
            request.operationId,
          );
        this.appendSessionResult(this.read(request.operationId)!);
        recordAgentActivity(this.database, {
          agentId: request.agentId,
          nodeId,
          kind: "operation.finished",
          referenceId: request.operationId,
          summary:
            result.state === "unknown"
              ? "操作结果尚无可靠证据。"
              : `操作收据已确认：${result.state === "succeeded" ? "成功" : "失败"}。`,
          detail: { state: result.state, receipt: result.receipt },
          at: this.now(),
        });
      })
      .immediate();
    const stored = this.read(request.operationId);
    if (!stored) throw new Error("Agent process operation receipt was not persisted");
    return toResult(stored);
  }

  private assertActiveRun(
    runId: string,
    nodeId: string,
    agentId: string,
    actionScopeId: string,
  ): void {
    const run = this.database
      .prepare(
        `SELECT r.state,r.node_id,r.delivery_id,a.status,a.node_id AS current_node_id
         FROM owner_agent_runs r JOIN owner_agents a ON a.id=r.agent_id
         WHERE r.id=? AND r.agent_id=?`,
      )
      .get(runId, agentId) as
      | {
          state: string;
          node_id: string;
          delivery_id: string;
          status: string;
          current_node_id: string;
        }
      | undefined;
    if (
      !run ||
      run.state !== "running" ||
      run.node_id !== nodeId ||
      run.delivery_id !== actionScopeId ||
      run.current_node_id !== nodeId ||
      run.status !== "waiting_credentials"
    )
      throw new Error("Agent process operation run is no longer active");
  }

  private appendSessionResult(row: OperationRow): void {
    if (row.state === "executing") return;
    const scope = this.database
      .prepare(
        `SELECT s.id AS session_id,d.channel_id FROM owner_agent_runs r
       JOIN owner_agent_sessions s ON s.agent_id=r.agent_id
       JOIN owner_message_deliveries d ON d.id=r.delivery_id
       WHERE r.id=?`,
      )
      .get(row.run_id) as { session_id: string; channel_id: string } | undefined;
    if (!scope) throw new Error("Process operation lost its session");
    const result = JSON.stringify({
      operationId: row.operation_id,
      state: row.state,
      receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json),
    });
    const text = `Mate 工具结果：${result}`;
    this.database
      .prepare(
        `INSERT OR IGNORE INTO owner_agent_session_journal(
        session_id,agent_id,channel_id,run_id,tool_action_id,process_operation_id,role,text,created_at
       ) VALUES(?,?,?,?,?,?,'assistant',?,?)`,
      )
      .run(
        scope.session_id,
        row.agent_id,
        scope.channel_id,
        row.run_id,
        `${row.operation_id}:${row.state}`,
        row.operation_id,
        text.length <= 20_000
          ? text
          : `Mate 工具结果：${row.operation_id} ${row.state}。收据过长，请在动态页查看详情。`,
        this.now(),
      );
  }

  private read(operationId: string): OperationRow | undefined {
    return this.database
      .prepare("SELECT * FROM owner_agent_process_operations WHERE operation_id=?")
      .get(operationId) as OperationRow | undefined;
  }
}

function toResult(row: OperationRow): AgentProcessOperationResult {
  return {
    operationId: row.operation_id,
    agentId: row.agent_id,
    state: row.state,
    receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json),
  };
}

function stableActionScopeId(stableActionId: string): string {
  return stableActionIdSchema.parse(stableActionId).split(":")[1]!;
}

/** Derive a UUID scope suffix from a worker-issued, normalized and delivery-scoped action ID. */
export function deriveAgentProcessOperationId(agentId: string, stableActionId: string): string {
  const parsedAgentId = uuidSchema.parse(agentId),
    parsedStableActionId = stableActionIdSchema.parse(stableActionId),
    hash = createHash("sha256")
      .update("mate-process-operation-v1\0")
      .update(parsedAgentId)
      .update("\0")
      .update(parsedStableActionId)
      .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
