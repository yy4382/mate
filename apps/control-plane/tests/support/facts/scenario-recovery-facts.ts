import Database from "better-sqlite3";
import { join } from "node:path";
import { z } from "zod";
import { sessionCommitSchema } from "../../../src/runtime/session/record.js";

/** Only facts unavailable from Owner API; never writes scenario business state. */
export function readRecoveryFacts(directory: string, agentId: string) {
  const db = new Database(join(directory, "control-plane-data", "control-plane.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return {
      sessions: z
        .object({ id: z.string() })
        .array()
        .parse(db.prepare("SELECT id FROM owner_agent_sessions WHERE agent_id=?").all(agentId)),
      runs: z
        .object({ id: z.string(), state: z.string(), errorCode: z.string().nullable() })
        .array()
        .parse(
          db
            .prepare(
              "SELECT id,state,error_code AS errorCode FROM owner_agent_runs WHERE agent_id=? ORDER BY rowid",
            )
            .all(agentId),
        ),
      entries: db
        .prepare(
          "SELECT seq,run_id AS runId,payload_json AS payload FROM owner_agent_session_records WHERE agent_id=? ORDER BY seq",
        )
        .all(agentId)
        .map((row) => {
          const parsed = z
            .object({ seq: z.number(), runId: z.string(), payload: z.string() })
            .parse(row);
          return {
            seq: parsed.seq,
            runId: parsed.runId,
            entry: sessionCommitSchema.parse(JSON.parse(parsed.payload)),
          };
        }),
      operations: z
        .object({
          operationId: z.string(),
          runId: z.string(),
          agentId: z.string(),
          state: z.string(),
          request: z.string(),
          receipt: z.string().nullable(),
        })
        .array()
        .parse(
          db
            .prepare(
              "SELECT operation_id AS operationId,run_id AS runId,agent_id AS agentId,state,request_json AS request,receipt_json AS receipt FROM owner_agent_process_operations WHERE agent_id=? ORDER BY created_at,operation_id",
            )
            .all(agentId),
        ),
      taskReceipts: db
        .prepare(
          "SELECT action_id AS actionId,result_json AS result FROM owner_agent_tool_actions WHERE agent_id=? AND operation='tasks.create' ORDER BY rowid",
        )
        .all(agentId)
        .map((row) => {
          const parsed = z.object({ actionId: z.string(), result: z.string() }).parse(row);
          return {
            actionId: parsed.actionId,
            result: z.unknown().parse(JSON.parse(parsed.result)),
          };
        }),
      deliveries: z
        .object({ messageId: z.string(), state: z.string() })
        .array()
        .parse(
          db
            .prepare(
              "SELECT message_id AS messageId,state FROM owner_message_deliveries WHERE recipient_kind='agent' AND recipient_id=? ORDER BY seq",
            )
            .all(agentId),
        ),
    };
  } finally {
    db.close();
  }
}
