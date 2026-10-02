import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
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

/** Narrow diagnostic projections; auth, credentials and full databases are never exported. */
export function readScenarioFacts(directory: string) {
  const db = new Database(join(directory, "control-plane-data", "control-plane.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return {
      sessions: db
        .prepare(
          "SELECT id,agent_id AS agentId,created_at AS createdAt FROM owner_agent_sessions ORDER BY created_at,id",
        )
        .all(),
      runs: db
        .prepare(
          "SELECT id,agent_id AS agentId,node_id AS nodeId,delivery_id AS deliveryId,state,error_code AS errorCode,started_at AS startedAt,completed_at AS completedAt FROM owner_agent_runs ORDER BY rowid",
        )
        .all(),
      transcript: db
        .prepare(
          "SELECT seq,id,agent_id AS agentId,run_id AS runId,action_scope_id AS actionScopeId,kind,payload_json AS payload FROM owner_agent_session_records ORDER BY seq",
        )
        .all(),
      operations: db
        .prepare(
          "SELECT operation_id AS operationId,run_id AS runId,agent_id AS agentId,node_id AS nodeId,state,request_json AS request,receipt_json AS receipt FROM owner_agent_process_operations ORDER BY created_at,operation_id",
        )
        .all(),
    };
  } finally {
    db.close();
  }
}

/** Node evidence is limited to its operation ledger and individual synthetic file receipts. */
export function readNodeScenarioFacts(directory: string) {
  const path = join(directory, "node-data", "agent-process-operations.sqlite");
  function operations() {
    if (!existsSync(path)) return [];
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      return db
        .prepare(
          "SELECT operation_id AS operationId,agent_id AS agentId,state,request,receipt,revision,created_at AS createdAt,updated_at AS updatedAt FROM agent_process_operations ORDER BY created_at,operation_id",
        )
        .all();
    } finally {
      db.close();
    }
  }
  const receiptsDirectory = join(directory, "node-data", "workspace-receipts");
  const receiptSchema = z.object({
    operationId: z.string(),
    agentId: z.string(),
    requestHash: z.string(),
    state: z.string(),
    result: z.unknown().optional(),
    revision: z.number().optional(),
    updatedAt: z.number().optional(),
  });
  const fileReceipts = existsSync(receiptsDirectory)
    ? readdirSync(receiptsDirectory)
        .filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
        .sort()
        .map((name) => {
          const path = join(receiptsDirectory, name);
          const stat = lstatSync(path);
          if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error("Scenario receipt must be a regular file");
          return receiptSchema.parse(JSON.parse(readFileSync(path, "utf8")));
        })
    : [];
  return { operations: operations(), fileReceipts };
}
