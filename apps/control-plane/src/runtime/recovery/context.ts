import type Database from "better-sqlite3";
import { z } from "zod";
import { AgentSession } from "../session/service.js";
const receiptEnvelopeSchema = z.record(z.string(), z.unknown());

/** Existing operation records remain the authority; these are private additions to the same session. */
export function queueUncertainOperationFacts(
  db: Database.Database,
  agentId: string,
  now: number,
): void {
  const session = new AgentSession(db);
  const processes = db
    .prepare<
      unknown[],
      {
        operation_id: string;
        request_json: string;
        state: string;
        receipt_json: string | null;
      }
    >(
      `SELECT operation_id,request_json,state,receipt_json
    FROM owner_agent_process_operations WHERE agent_id=?`,
    )
    .all(agentId);
  for (const row of processes) {
    const request = parseHistory(row.request_json);
    const receipt = parseHistory(row.receipt_json);
    if (["succeeded", "failed"].includes(row.state) && request.ok && receipt.ok) continue;
    session.queueCorrection(
      agentId,
      {
        operationId: row.operation_id,
        state: "unknown",
        request: request.value,
        reason:
          !request.ok || !receipt.ok
            ? "historical_information_unreadable"
            : "operation_result_unproven",
        evidence: receipt.value,
        note: "旧命令仍可能运行；不会自动重放。由你决定检查、补救或继续。",
      },
      now,
    );
  }
  const stops = db
    .prepare<unknown[], { operation_id: string; state: string; receipt_json: string | null }>(
      `SELECT operation_id,state,receipt_json FROM owner_agent_stop_intents
    WHERE agent_id=?`,
    )
    .all(agentId);
  for (const row of stops) {
    const receipt = parseHistory(row.receipt_json);
    if (row.state === "succeeded" && receipt.ok) continue;
    session.queueCorrection(
      agentId,
      {
        operationId: row.operation_id,
        state: "unknown",
        request: { kind: "process.stop_all" },
        reason: "command_termination_unproven",
        evidence: receipt.value,
        note: "历史停止请求的效果无法确认；旧命令仍可能运行。由你决定检查、补救或继续。",
      },
      now,
    );
  }
  const files = db
    .prepare<
      unknown[],
      {
        action_id: string;
        operation: string;
        result_json: string;
      }
    >(
      `SELECT action_id,operation,result_json FROM owner_agent_tool_actions
    WHERE agent_id=? AND operation LIKE 'workspace.%'`,
    )
    .all(agentId);
  for (const row of files) {
    const parsed = parseHistory(row.result_json);
    const envelope = (parsed.ok && receiptEnvelopeSchema.safeParse(parsed.value).data) || {};
    if (["succeeded", "failed"].includes(String(envelope.state))) continue;
    const operationId =
      typeof envelope.operationId === "string" ? envelope.operationId : row.action_id;
    session.queueCorrection(
      agentId,
      {
        operationId,
        actionId: row.action_id,
        operation: row.operation,
        state: "unknown",
        request: workspaceOperationSummary(db, agentId, operationId, row.operation),
        reason:
          parsed.ok && ["executing", "unknown"].includes(String(envelope.state))
            ? "operation_result_unproven"
            : "historical_information_unreadable",
        evidence: parsed.value,
        note: "历史文件效果无法确认；不会自动重放。由你决定检查、补救或继续。",
      },
      now,
    );
  }
}

export function parseHistory(value: string | null): { ok: boolean; value: unknown } {
  if (value === null) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false, value };
  }
}

/** Recover the original affected paths/inputs without altering the operation or transcript. */
export function workspaceOperationSummary(
  db: Database.Database,
  agentId: string,
  operationId: string,
  operation: string,
): unknown {
  const activity = db
    .prepare<unknown[], { detail_json: string | null }>(
      `SELECT detail_json FROM owner_agent_activity
    WHERE agent_id=? AND reference_id=? AND kind='operation.started' ORDER BY seq LIMIT 1`,
    )
    .get(agentId, operationId);
  return activity ? parseHistory(activity.detail_json).value : { operation };
}
