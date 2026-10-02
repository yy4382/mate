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

/**
 * A run belongs to its admitted seed even before an input commit. Additional messages belong only
 * when their real delivery IDs were committed under that seed's action scope by this or an earlier
 * run, within this run's admitted input bounds. The existing run ledger's insertion order prevents
 * later recovery commits from being attributed to an old run. Recovery retains the original scope;
 * a sequence range alone would wrongly include ordinary messages in reminder runs.
 * These are read-only correlation facts, never scenario business writes or an action boundary.
 */
export function readMessageRuns(directory: string, agentId: string, messageId: string) {
  const db = new Database(join(directory, "control-plane-data", "control-plane.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return runSchema.array().parse(
      db
        .prepare(
          `WITH messageInputs AS (
             SELECT r.id AS runId, d.message_id AS messageId, d.seq AS sequence
             FROM owner_agent_runs r
             JOIN owner_message_deliveries d ON d.recipient_kind='agent' AND d.recipient_id=r.agent_id
             WHERE r.agent_id=? AND (d.id=r.delivery_id OR (d.seq<=r.input_end_seq AND EXISTS (
               SELECT 1 FROM owner_agent_session_records input
               JOIN owner_agent_runs committedRun ON committedRun.id=input.run_id
               WHERE input.agent_id=r.agent_id AND input.kind='message'
                 AND input.id=d.id AND input.action_scope_id=r.delivery_id
                 AND committedRun.rowid<=r.rowid
             )))
           )
           SELECT r.id, r.agent_id AS agentId, s.id AS sessionId, r.state,
             r.error_code AS errorCode,
             (SELECT json_group_array(messageId) FROM (
               SELECT messageId FROM messageInputs WHERE runId=r.id ORDER BY sequence
             )) AS messages
           FROM owner_agent_runs r
           JOIN owner_agent_sessions s ON s.agent_id=r.agent_id
           WHERE EXISTS (
             SELECT 1 FROM messageInputs WHERE runId=r.id AND messageId=?
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
