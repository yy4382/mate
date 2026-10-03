import type Database from "better-sqlite3";
import type { NodeWorkspaceOperationResult } from "@mate/protocol";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AgentSession } from "../runtime/session/service.js";
import { workspaceOperationSummary } from "../runtime/recovery-context.js";
import { recordAgentActivity } from "../runtime/activity.js";
import { parseEnvelope } from "./results.js";
import { WorkspaceError } from "./errors.js";

interface WorkspaceActionKey {
  sessionId: string;
  actionId: string;
  agentId: string;
  requestHash: string;
}
export interface WorkspaceActionIntent extends WorkspaceActionKey {
  operationId: string;
  runId: string;
  channelId: string;
  operation: string;
  nodeRequestHash: string;
}
type WorkspaceOperationIdentity = Omit<
  WorkspaceActionIntent,
  "requestHash" | "nodeRequestHash" | "operationId"
> & { nodeId: string };

// This is an in-memory lookup accelerator; the persistent action is queried after eviction/restart.
const operationIdentityRetentionMs = 10 * 60_000;

/** Persistent file-effect intent/results and late-receipt reconciliation, never node dispatch. */
export class WorkspaceActionLedger {
  private readonly actionOperations = new Map<
    string,
    WorkspaceOperationIdentity & { timer?: ReturnType<typeof setTimeout> }
  >();
  constructor(
    private readonly db: Database.Database,
    private readonly notifyCorrection: (
      agentId: string,
      operationId: string,
      state: string,
    ) => void,
  ) {}

  close(): void {
    for (const operationId of this.actionOperations.keys()) this.forget(operationId);
  }

  prepare(
    intent: WorkspaceActionIntent,
    toolInput: Record<string, unknown>,
  ):
    | { kind: "new" }
    | { kind: "done"; result: unknown }
    | { kind: "failed"; code: number; stderr: string } {
    const {
      sessionId,
      actionId,
      agentId,
      operation,
      requestHash,
      nodeRequestHash,
      operationId,
      runId,
      channelId,
    } = intent;
    const existing = z
      .looseObject({ request_hash: z.string(), result_json: z.string() })
      .optional()
      .parse(
        this.db
          .prepare(
            "SELECT request_hash,result_json FROM owner_agent_tool_actions WHERE session_id=? AND action_id=?",
          )
          .get(sessionId, actionId),
      );
    if (existing) {
      if (existing.request_hash !== requestHash)
        throw new WorkspaceError("operation_conflict", "操作 ID 已用于不同的文件请求。", 409);
      const envelope = parseEnvelope(existing.result_json);
      if (envelope.state === "succeeded") return { kind: "done", result: envelope.result };
      if (envelope.state === "failed") {
        const result = envelope.result;
        if (
          typeof result !== "object" ||
          result === null ||
          !("code" in result) ||
          typeof result.code !== "number" ||
          !Number.isSafeInteger(result.code) ||
          result.code === 0 ||
          !("stderr" in result) ||
          typeof result.stderr !== "string"
        )
          throw new WorkspaceError("operation_unknown", "文件操作失败收据无法读取。", 409);
        return {
          kind: "failed",
          code: result.code,
          stderr: result.stderr,
        };
      }
      if (envelope.operationId && envelope.operationId !== operationId)
        throw new WorkspaceError("operation_unknown", "文件操作结果尚未确认。", 409);
      if (envelope.state === "executing")
        this.markUnknown(
          {
            sessionId,
            actionId,
            agentId,
            requestHash,
            operationId,
            operation,
            runId: envelope.runId ?? runId,
            channelId: envelope.channelId ?? channelId,
            ...(envelope.nodeRequestHash ? { nodeRequestHash: envelope.nodeRequestHash } : {}),
          },
          "没有已确认的节点文件收据；不会重新执行此操作",
        );
      throw new WorkspaceError("operation_unknown", "文件操作结果尚未确认。", 409);
    }
    return this.db
      .transaction(() => {
        this.db
          .prepare(
            `INSERT INTO owner_agent_tool_actions(
           session_id,action_id,agent_id,operation,request_hash,result_json,created_at
         ) VALUES(?,?,?,?,?,?,?)`,
          )
          .run(
            sessionId,
            actionId,
            agentId,
            operation,
            requestHash,
            JSON.stringify({
              state: "executing",
              operationId,
              runId,
              channelId,
              operation,
              nodeRequestHash,
            }),
            Date.now(),
          );
        recordAgentActivity(this.db, {
          agentId,
          kind: "operation.started",
          referenceId: operationId,
          summary: "文件操作已提交节点执行。",
          detail: { operation, input: toolInput },
          at: Date.now(),
        });
        return { kind: "new" as const };
      })
      .immediate();
  }

  complete(
    key: WorkspaceActionKey,
    envelope: {
      state: "unknown" | "succeeded" | "failed";
      operationId: string;
      runId: string;
      channelId: string;
      operation: string;
      nodeRequestHash?: string;
      revision?: number;
      result?: unknown;
      error?: string;
    },
  ): void {
    const { sessionId, actionId, agentId, requestHash } = key;
    this.db
      .transaction(() => {
        const existing = z
          .looseObject({ result_json: z.string() })
          .optional()
          .parse(
            this.db
              .prepare(
                "SELECT result_json FROM owner_agent_tool_actions WHERE session_id=? AND action_id=? AND agent_id=? AND request_hash=?",
              )
              .get(sessionId, actionId, agentId, requestHash),
          );
        if (!existing) return;
        const prior = parseEnvelope(existing.result_json);
        const changed =
          prior.state !== envelope.state || !isDeepStrictEqual(prior.result, envelope.result);
        const versionBlocked =
          prior.revision !== undefined &&
          (envelope.revision === undefined || envelope.revision <= prior.revision);
        const unversionedConflict =
          (prior.state === "succeeded" || prior.state === "failed") &&
          prior.revision === undefined &&
          changed;
        if (versionBlocked || unversionedConflict) {
          if (changed)
            new AgentSession(this.db).queueCorrection(
              agentId,
              {
                operationId: envelope.operationId,
                operation: envelope.operation,
                request: workspaceOperationSummary(
                  this.db,
                  agentId,
                  envelope.operationId,
                  envelope.operation,
                ),
                state: "unknown",
                reason: "operation_result_conflict",
                evidence: envelope,
                note: "历史文件收据无法核实；不会改写已见历史或自动重放。由你决定检查、补救或继续。",
              },
              Date.now(),
            );
          return;
        }
        this.db
          .prepare(
            `UPDATE owner_agent_tool_actions SET result_json=?
             WHERE session_id=? AND action_id=? AND agent_id=? AND request_hash=?`,
          )
          .run(
            JSON.stringify({
              ...envelope,
              ...((envelope.nodeRequestHash ?? prior.nodeRequestHash)
                ? { nodeRequestHash: envelope.nodeRequestHash ?? prior.nodeRequestHash }
                : {}),
            }).slice(0, 100_000),
            sessionId,
            actionId,
            agentId,
            requestHash,
          );
        if (changed)
          recordAgentActivity(this.db, {
            agentId,
            kind:
              prior.state === "unknown" && envelope.state !== "unknown"
                ? "receipt.corrected"
                : "operation.finished",
            referenceId: envelope.operationId,
            summary:
              envelope.state === "succeeded"
                ? "文件操作收据已确认成功。"
                : envelope.state === "failed"
                  ? "文件操作收据已确认失败。"
                  : "文件操作结果尚未确认。",
            detail: {
              operation: envelope.operation,
              result: envelope.result,
              error: envelope.error,
            },
            at: Date.now(),
          });
        if (changed && prior.state !== "executing" && envelope.state !== "unknown")
          this.notifyCorrection(agentId, envelope.operationId, envelope.state);
      })
      .immediate();
  }

  markUnknown(
    intent: Omit<WorkspaceActionIntent, "nodeRequestHash"> & { nodeRequestHash?: string },
    message: string,
  ): void {
    const { operationId, runId, channelId, operation, nodeRequestHash } = intent;
    this.complete(intent, {
      state: "unknown",
      operationId,
      runId,
      channelId,
      operation,
      ...(nodeRequestHash ? { nodeRequestHash } : {}),
      error: message,
    });
  }

  track(operationId: string, identity: WorkspaceOperationIdentity): void {
    const previous = this.actionOperations.get(operationId);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(
      () => this.actionOperations.delete(operationId),
      operationIdentityRetentionMs,
    );
    timer.unref?.();
    this.actionOperations.set(operationId, { ...identity, timer });
  }

  forget(operationId: string): void {
    const entry = this.actionOperations.get(operationId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.actionOperations.delete(operationId);
  }

  receive(nodeId: string, result: NodeWorkspaceOperationResult): void {
    let identity = this.actionOperations.get(result.operationId);
    if (!identity) {
      const row = z
        .looseObject({
          session_id: z.string(),
          action_id: z.string(),
          agent_id: z.string(),
          operation: z.string(),
          request_hash: z.string(),
          result_json: z.string(),
          node_id: z.string(),
        })
        .optional()
        .parse(
          this.db
            .prepare(
              `SELECT action.session_id,action.action_id,action.agent_id,action.operation,
                  action.request_hash,action.result_json,agent.node_id
           FROM owner_agent_tool_actions action
           JOIN owner_agents agent ON agent.id=action.agent_id
           WHERE json_extract(CASE WHEN json_valid(action.result_json) THEN action.result_json ELSE '{}' END,'$.operationId')=?
             AND action.agent_id=? AND action.operation LIKE 'workspace.%'`,
            )
            .get(result.operationId, result.agentId),
        );
      if (!row || row.node_id !== nodeId) return;
      let prior;
      try {
        prior = parseEnvelope(row.result_json);
      } catch {
        return;
      }
      if (
        prior.operationId !== result.operationId ||
        typeof prior.runId !== "string" ||
        typeof prior.channelId !== "string"
      )
        return;
      identity = {
        sessionId: row.session_id,
        actionId: row.action_id,
        agentId: row.agent_id,
        nodeId: row.node_id,
        runId: prior.runId,
        channelId: prior.channelId,
        operation: row.operation,
      };
    }
    if (identity.nodeId !== nodeId || identity.agentId !== result.agentId) return;
    let envelope: Parameters<WorkspaceActionLedger["complete"]>[1];
    const revision = result.ok ? (result.revision ?? result.result.revision) : undefined;
    if (!result.ok) {
      envelope = {
        state: "unknown",
        operationId: result.operationId,
        runId: identity.runId,
        channelId: identity.channelId,
        operation: identity.operation,
        error: result.error,
      };
    } else if (result.result.code !== 0) {
      envelope = {
        state: result.result.stderr.startsWith("operation_unknown:") ? "unknown" : "failed",
        operationId: result.operationId,
        runId: identity.runId,
        channelId: identity.channelId,
        operation: identity.operation,
        ...(revision !== undefined ? { revision } : {}),
        result: { code: result.result.code, stderr: result.result.stderr },
        error: result.result.stderr || "File operation failed",
      };
    } else {
      try {
        envelope = {
          state: "succeeded",
          operationId: result.operationId,
          runId: identity.runId,
          channelId: identity.channelId,
          operation: identity.operation,
          ...(revision !== undefined ? { revision } : {}),
          result: JSON.parse(result.result.stdout) as unknown,
        };
      } catch {
        envelope = {
          state: "unknown",
          operationId: result.operationId,
          runId: identity.runId,
          channelId: identity.channelId,
          operation: identity.operation,
          ...(revision !== undefined ? { revision } : {}),
          error: "Invalid node receipt",
        };
      }
    }
    const row = z
      .looseObject({ request_hash: z.string() })
      .optional()
      .parse(
        this.db
          .prepare(
            "SELECT request_hash FROM owner_agent_tool_actions WHERE session_id=? AND action_id=?",
          )
          .get(identity.sessionId, identity.actionId),
      );
    if (row)
      this.complete(
        {
          sessionId: identity.sessionId,
          actionId: identity.actionId,
          agentId: identity.agentId,
          requestHash: row.request_hash,
        },
        envelope,
      );
    this.forget(result.operationId);
  }
}
