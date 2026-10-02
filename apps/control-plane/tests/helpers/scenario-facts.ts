import Database from "better-sqlite3";
import { join } from "node:path";
import { z } from "zod";
import { agentSummarySchema, ownerMessageSchema } from "@mate/protocol/owner";

const runSchema = z.object({
  id: z.string(),
  agentId: agentSummarySchema.shape.id,
  sessionId: agentSummarySchema.shape.sessionId,
  state: z.enum(["running", "completed", "failed"]),
  errorCode: z.string().nullable(),
  messageIds: z.array(ownerMessageSchema.shape.id),
});

/** Read-only identities not exposed by Owner activity; never writes scenario business facts. */
export function readMessageRuns(directory: string, agentId: string, messageId: string) {
  const db = new Database(join(directory, "control-plane-data", "control-plane.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return runSchema.array().parse(
      db
        .prepare(
          `SELECT r.id, r.agent_id AS agentId, s.id AS sessionId, r.state,
             r.error_code AS errorCode,
             (SELECT json_group_array(d.message_id) FROM owner_message_deliveries d
              WHERE d.recipient_kind='agent' AND d.recipient_id=r.agent_id
                AND d.seq BETWEEN start.seq AND r.input_end_seq) AS messages
           FROM owner_agent_runs r
           JOIN owner_agent_sessions s ON s.agent_id=r.agent_id
           JOIN owner_message_deliveries start ON start.id=r.delivery_id
           WHERE r.agent_id=? AND EXISTS (
             SELECT 1 FROM owner_message_deliveries target
             WHERE target.recipient_kind='agent' AND target.recipient_id=r.agent_id
               AND target.message_id=? AND target.seq BETWEEN start.seq AND r.input_end_seq
           ) ORDER BY r.started_at,r.id`,
        )
        .all(agentId, messageId)
        .map((row) => {
          const parsed = z.looseObject({ messages: z.string() }).parse(row);
          return { ...parsed, messageIds: JSON.parse(parsed.messages) };
        }),
    );
  } finally {
    db.close();
  }
}
