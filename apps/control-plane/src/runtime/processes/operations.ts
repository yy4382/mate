import {
  agentProcessOperationSchema,
  type AgentProcessOperation,
  type AgentProcessOperationState,
} from "@mate/protocol";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { recordAgentActivity } from "../activity.js";
import { parseHistory } from "../recovery/context.js";
import { AgentSession } from "../session/service.js";
import { defineAgentTool, type AgentToolContext } from "../tools/entry.js";

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
  revision?: number;
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
  request_hash: string;
  request_json: string;
  state: "executing" | Exclude<AgentProcessOperationState, "started">;
  receipt_json: string | null;
  node_receipt_confirmed: 0 | 1;
  node_receipt_revision: number | null;
}

/**
 * The control-plane half of the ordinary process broker. It commits an immutable intent before
 * sending the stable operation ID to a node, then stores the receipt or an explicit unknown.
 */
export class AgentProcessOperationBroker {
  agentTools() {
    return {
      "process.exec": defineAgentTool(
        {
          description:
            "在当前运行账号的普通 shell 子进程中运行命令，默认在 Agent 默认工作目录执行。Mate 返回有界输出、退出码，并在收据中标明输出是否完整以及命令是否因超时被结束；命令里的 sudo 原样交给宿主，成败只由宿主已有的 sudo 配置决定，Mate 不插入 sudo、不要求网页审批、也不配置 sudoers。",
          schema: z
            .object({
              command: z.string().min(1).max(16_000),
              cwd: z.string().max(4096).optional(),
            })
            .strict(),
        },
        (identity, input) =>
          this.executeTool(identity, {
            kind: "exec",
            command: input.command,
            cwd: input.cwd ?? ".",
          }),
      ),
      "process.list": defineAgentTool(
        {
          description:
            "列出本次节点运行期间由 process.exec 启动、进程组仍然存在的自己命令进程。Mate 的进程记录只属于当前这次节点进程：节点重启后它不再追踪此前的命令，也无法确认那些命令是否仍在运行。",
          schema: z.object({}).strict(),
        },
        (identity, input) => this.executeTool(identity, { kind: "process.list" }),
      ),
      "process.inspect": defineAgentTool(
        {
          description:
            "查询一个由实时 process.exec 返回的操作 ID 当前的进程状态。Mate 只报告本次节点运行期间自己启动并仍能看到的进程组；本次节点运行之前启动的普通命令不在报告范围内，Mate 不会声称它们正在运行或已经结束。",
          schema: z.object({ targetOperationId: uuidSchema }).strict(),
        },
        (identity, input) => this.executeTool(identity, { kind: "process.inspect", ...input }),
      ),
      "process.stop": defineAgentTool(
        {
          description:
            "尽力终止一个由本次节点运行期间的 process.exec 返回的操作 ID 对应的进程组。Mate 只能观察和终止它自己启动的进程组：以新会话离开该进程组或本账号无权信号的后代（例如 sudo 派生的 root 进程）不在报告范围内，Mate 不会声称它们已停止，只会如实报告无法确认。",
          schema: z.object({ targetOperationId: uuidSchema }).strict(),
        },
        (identity, input) => this.executeTool(identity, { kind: "process.stop", ...input }),
      ),
    };
  }

  private async executeTool(identity: AgentToolContext, operation: AgentProcessOperation) {
    const { runId, nodeId, agentId, toolCallId } = identity;
    const original = new AgentSession(this.database).toolAction(agentId, toolCallId);
    if (
      original &&
      (original.name !== identity.request.operation ||
        !isDeepStrictEqual(original.input, identity.request.input))
    )
      throw new Error("Recovered tool arguments differ from the committed call");
    this.database
      .prepare("UPDATE owner_durable_tool_calls SET operation_id=? WHERE agent_id=? AND identity=?")
      .run(deriveAgentProcessOperationId(agentId, toolCallId), agentId, toolCallId);
    const result = await this.execute(
      {
        runId,
        nodeId,
        agentId,
        actionScopeId: original?.actionScopeId ?? identity.run.action_scope_id,
        stableActionId: toolCallId,
        operationId: deriveAgentProcessOperationId(agentId, toolCallId),
        operation,
      },
      identity.committed,
      identity.requireCurrentRun,
    );
    return { operationId: result.operationId, state: result.state, receipt: result.receipt };
  }

  private readonly inFlight = new Map<string, Promise<AgentProcessOperationResult>>();

  constructor(
    private readonly database: Database.Database,
    private readonly nodes: AgentProcessNodePort,
    private readonly now: () => number = Date.now,
  ) {
    database.pragma("synchronous = FULL");
  }

  async execute(
    request: AgentProcessOperationRequest,
    committed: Promise<void> = Promise.resolve(),
    requireCurrentRun: () => void = () => {},
  ): Promise<AgentProcessOperationResult> {
    const runId = uuidSchema.parse(request.runId);
    const nodeId = uuidSchema.parse(request.nodeId);
    const agentId = uuidSchema.parse(request.agentId);
    const actionScopeId = uuidSchema.parse(request.actionScopeId);
    const stableActionId = stableActionIdSchema.parse(request.stableActionId);
    const operationId = uuidSchema.parse(request.operationId);
    const operation = agentProcessOperationSchema.parse(request.operation);
    const requestJson = JSON.stringify({
      actionScopeId,
      stableActionId,
      nodeId,
      agentId,
      operation,
    });
    const requestHash = createHash("sha256").update(requestJson).digest("hex");
    if (stableActionScopeId(stableActionId) !== actionScopeId)
      throw new Error("Agent process action scope does not match the active delivery");
    if (operationId !== deriveAgentProcessOperationId(agentId, stableActionId))
      throw new Error("Agent process operation ID does not match its stable action identity");

    let created = false;
    const row = this.database
      .transaction(() => {
        const existing = this.read(operationId);
        if (existing) {
          if (
            existing.agent_id !== agentId ||
            existing.node_id !== nodeId ||
            existing.request_hash !== requestHash
          )
            throw new Error("Agent process operation identity conflict");
          // A persisted intent may already have taken effect, even if the node lost its receipt.
          // Only the invocation that created it may dispatch; recovery only reads facts.
          return existing;
        }
        created = true;
        this.database
          .prepare(
            `INSERT INTO owner_agent_process_operations(
              operation_id,run_id,agent_id,node_id,
              request_hash,request_json,state,created_at,updated_at
            ) VALUES(?,?,?,?,?,?,'executing',?,?)`,
          )
          .run(
            operationId,
            runId,
            agentId,
            nodeId,
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
    if (!created) return toResult(row);
    const dispatch = committed.then(() => {
      requireCurrentRun();
      return this.dispatch(nodeId, { operationId, agentId, operation });
    });
    this.inFlight.set(operationId, dispatch);
    const clear = () => {
      if (this.inFlight.get(operationId) === dispatch) this.inFlight.delete(operationId);
    };
    void dispatch.then(clear, clear);
    return dispatch;
  }

  /** Read the durable CP receipt as a seam for late-result reconciliation. */
  status(agentId: string, operationId: string): AgentProcessOperationResult | undefined {
    const parsedAgentId = uuidSchema.parse(agentId);
    const parsedOperationId = uuidSchema.parse(operationId);
    const row = this.read(parsedOperationId);
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
    const incomingRevision = validRevision(result.revision);
    const changed =
      row.state !== result.state ||
      !isDeepStrictEqual(parseHistory(row.receipt_json).value, result.receipt);
    const stale =
      row.node_receipt_revision !== null &&
      incomingRevision !== undefined &&
      incomingRevision < row.node_receipt_revision;
    const notNewer =
      row.node_receipt_confirmed === 1 &&
      row.node_receipt_revision !== null &&
      (incomingRevision === undefined || incomingRevision <= row.node_receipt_revision);
    const unversionedTerminal =
      ["succeeded", "failed"].includes(row.state) && row.node_receipt_revision === null;
    if (notNewer || unversionedTerminal) {
      if (changed)
        new AgentSession(this.database).queueCorrection(
          row.agent_id,
          {
            operationId: row.operation_id,
            state: "unknown",
            request: parseHistory(row.request_json).value,
            reason: stale ? "node_receipt_stale" : "operation_result_conflict",
            evidence: result.receipt,
            note: "历史收据冲突，不能据此改写已见结果；旧命令仍可能运行。不会自动重放。",
          },
          this.now(),
        );
      return { corrected: false, result: toResult(row) };
    }
    let applied = false;
    this.database
      .transaction(() => {
        const update = this.database
          .prepare(
            `UPDATE owner_agent_process_operations SET state=?,receipt_json=?,node_receipt_confirmed=1,node_receipt_revision=?,updated_at=?
         WHERE operation_id=? AND state IN ('executing','unknown','succeeded','failed')
           AND (node_receipt_confirmed=0 OR
             (node_receipt_revision IS NULL OR ?>node_receipt_revision))`,
          )
          .run(
            result.state,
            result.receipt === null ? null : JSON.stringify(result.receipt),
            incomingRevision ?? null,
            this.now(),
            result.operationId,
            incomingRevision ?? null,
          );
        if (update.changes === 0) return;
        applied = true;
        recordAgentActivity(this.database, {
          agentId: row.agent_id,
          nodeId: row.node_id,
          kind:
            (row.state === "unknown" || row.state === "succeeded" || row.state === "failed") &&
            result.state !== row.state
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
        if (changed && result.state !== "unknown")
          onCorrection?.(row.agent_id, row.operation_id, result.state);
      })
      .immediate();
    const latest = this.read(result.operationId)!;
    return {
      corrected: applied && changed && result.state !== "unknown",
      result: toResult(latest),
    };
  }

  private async dispatch(
    nodeId: string,
    request: { operationId: string; agentId: string; operation: AgentProcessOperation },
  ): Promise<AgentProcessOperationResult> {
    let result: AgentProcessNodeResult;
    let confirmed = true;
    try {
      result = await this.nodes.executeAgentProcessOperation(nodeId, request);
    } catch {
      confirmed = false;
      result = {
        operationId: request.operationId,
        agentId: request.agentId,
        state: "unknown",
        receipt: { reason: "node_response_unavailable" },
      };
    }
    if (result.operationId !== request.operationId || result.agentId !== request.agentId) {
      confirmed = false;
      result = {
        operationId: request.operationId,
        agentId: request.agentId,
        state: "unknown",
        receipt: { reason: "node_receipt_identity_mismatch" },
      };
    }
    const incomingRevision = confirmed ? validRevision(result.revision) : undefined;
    this.database
      .transaction(() => {
        const update = this.database
          .prepare(
            `UPDATE owner_agent_process_operations SET state=?,receipt_json=?,node_receipt_confirmed=?,node_receipt_revision=?,updated_at=?
           WHERE operation_id=? AND state IN ('executing','unknown')
             AND (node_receipt_confirmed=0 OR (?=1 AND
               (node_receipt_revision IS NULL OR ?>node_receipt_revision)))`,
          )
          .run(
            result.state,
            result.receipt === null ? null : JSON.stringify(result.receipt),
            confirmed ? 1 : 0,
            incomingRevision ?? null,
            this.now(),
            request.operationId,
            confirmed ? 1 : 0,
            incomingRevision ?? null,
          );
        if (update.changes === 0) return;
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

  private read(operationId: string): OperationRow | undefined {
    return this.database
      .prepare<unknown[], OperationRow>(
        "SELECT * FROM owner_agent_process_operations WHERE operation_id=?",
      )
      .get(operationId);
  }
}

function toResult(row: OperationRow): AgentProcessOperationResult {
  const receipt = parseHistory(row.receipt_json);
  const request = parseHistory(row.request_json);
  const operation =
    request.value && typeof request.value === "object" && "operation" in request.value
      ? request.value.operation
      : undefined;
  const readable = receipt.ok && agentProcessOperationSchema.safeParse(operation).success;
  return {
    operationId: row.operation_id,
    agentId: row.agent_id,
    state: readable ? row.state : "unknown",
    receipt: readable
      ? receipt.value
      : { reason: "historical_information_unreadable", evidence: receipt.value },
  };
}

function validRevision(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function stableActionScopeId(stableActionId: string): string {
  return stableActionIdSchema.parse(stableActionId).split(":")[1]!;
}

/** Derive an operation UUID from the Agent's bound Durable tool task identity. */
export function deriveAgentProcessOperationId(agentId: string, stableActionId: string): string {
  const parsedAgentId = uuidSchema.parse(agentId);
  const parsedStableActionId = stableActionIdSchema.parse(stableActionId);
  const hash = createHash("sha256")
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
