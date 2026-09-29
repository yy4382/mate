import type Database from "better-sqlite3";
import { AgentSession } from "./agent-session.js";

/** Existing operation records remain the authority; these are private additions to the same session. */
export function queueUncertainOperationFacts(
  db: Database.Database,
  agentId: string,
  now: number,
): void {
  const session = new AgentSession(db);
  const processes = db
    .prepare(
      `SELECT operation_id,request_json,state,receipt_json
    FROM owner_agent_process_operations WHERE agent_id=?`,
    )
    .all(agentId) as Array<{
    operation_id: string;
    request_json: string;
    state: string;
    receipt_json: string | null;
  }>;
  for (const row of processes) {
    const request = parseHistory(row.request_json),
      receipt = parseHistory(row.receipt_json);
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
  const files = db
    .prepare(
      `SELECT action_id,operation,result_json FROM owner_agent_tool_actions
    WHERE agent_id=? AND operation LIKE 'workspace.%'`,
    )
    .all(agentId) as Array<{
    action_id: string;
    operation: string;
    result_json: string;
  }>;
  for (const row of files) {
    const parsed = parseHistory(row.result_json);
    const envelope =
      parsed.ok && typeof parsed.value === "object" && parsed.value !== null
        ? (parsed.value as Record<string, unknown>)
        : {};
    if (["succeeded", "failed"].includes(String(envelope.state))) continue;
    const operationId =
      typeof envelope.operationId === "string" ? envelope.operationId : row.action_id;
    const activity = db
      .prepare(
        `SELECT detail_json FROM owner_agent_activity
      WHERE agent_id=? AND reference_id=? AND kind='operation.started' ORDER BY seq LIMIT 1`,
      )
      .get(agentId, operationId) as { detail_json: string | null } | undefined;
    session.queueCorrection(
      agentId,
      {
        operationId,
        actionId: row.action_id,
        operation: row.operation,
        state: "unknown",
        request: activity ? parseHistory(activity.detail_json).value : { operation: row.operation },
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
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false, value };
  }
}
