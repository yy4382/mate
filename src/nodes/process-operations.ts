import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";

const agentIdSchema = z.string().uuid();
const operationIdSchema = z.string().uuid();

/** Only ordinary Agent commands and process controls cross this boundary. */
export const agentProcessOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("exec"),
      command: z.string().min(1).max(16_000),
      cwd: z.string().max(4096),
    })
    .strict(),
  z.object({ kind: z.literal("process.list") }).strict(),
  z
    .object({
      kind: z.literal("process.inspect"),
      targetOperationId: z.string().uuid(),
    })
    .strict(),
  z.object({ kind: z.literal("process.stop"), targetOperationId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("process.stop_all") }).strict(),
]);

export type AgentProcessOperation = z.infer<typeof agentProcessOperationSchema>;
export type AgentProcessOperationState = "started" | "succeeded" | "failed" | "unknown";

export interface AgentProcessOperationReceipt {
  operationId: string;
  agentId: string;
  state: AgentProcessOperationState;
  receipt: unknown | null;
  /** Monotonic version of this operation's durable node-local result. */
  revision: number;
}

export interface AgentProcessExecution {
  state: "succeeded" | "failed";
  receipt: unknown;
}

export interface AgentProcessExecutionRequest {
  operationId: string;
  agentId: string;
  operation: AgentProcessOperation;
}

export type AgentProcessExecutor = (
  request: AgentProcessExecutionRequest,
) => Promise<AgentProcessExecution>;

interface OperationRow {
  operation_id: string;
  agent_id: string;
  request_hash: string;
  request: string;
  state: AgentProcessOperationState;
  receipt: string | null;
  revision: number;
}

const schema = `
CREATE TABLE IF NOT EXISTS agent_process_operations (
  operation_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  request TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('started','succeeded','failed','unknown')),
  receipt TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_process_operations_agent
  ON agent_process_operations(agent_id,created_at);
`;

/**
 * Node-local deduplication and receipts for commands and process controls. A started row is
 * committed before the executor is called. After a node restart its effect is unknown, never
 * silently replayed.
 */
export class AgentProcessOperations {
  private readonly inFlight = new Map<string, Promise<AgentProcessOperationReceipt>>();
  private readonly stoppingAgents = new Set<string>();
  private readonly findOperation;
  private readonly insertOperation;
  private readonly settleOperation;

  constructor(
    private readonly database: Database.Database,
    private readonly executeHostOperation: AgentProcessExecutor,
    private readonly now: () => number = Date.now,
  ) {
    database.pragma("synchronous = FULL");
    database.exec(schema);
    if (
      !database
        .prepare("PRAGMA table_info(agent_process_operations)")
        .all()
        .some((column) => (column as { name: string }).name === "revision")
    )
      database.exec(
        "ALTER TABLE agent_process_operations ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1)",
      );
    database
      .prepare(
        `UPDATE agent_process_operations
         SET state='unknown',receipt=?,revision=revision+1,updated_at=? WHERE state='started'`,
      )
      .run(JSON.stringify({ reason: "node_restarted_during_operation" }), now());
    this.findOperation = database.prepare(
      "SELECT operation_id,agent_id,request_hash,request,state,receipt,revision FROM agent_process_operations WHERE operation_id=?",
    );
    this.insertOperation = database.prepare(
      `INSERT INTO agent_process_operations(
         operation_id,agent_id,request_hash,request,state,created_at,updated_at
       ) VALUES(?,?,?,?, 'started',?,?)`,
    );
    this.settleOperation = database.prepare(
      `UPDATE agent_process_operations SET state=?,receipt=?,revision=revision+1,updated_at=?
       WHERE operation_id=? AND state='started'`,
    );
  }

  status(agentId: string, operationId: string): AgentProcessOperationReceipt | undefined {
    agentIdSchema.parse(agentId);
    operationIdSchema.parse(operationId);
    const row = this.findOperation.get(operationId) as OperationRow | undefined;
    if (!row || row.agent_id !== agentId) return undefined;
    return toReceipt(row);
  }

  /** Called only after the control plane has verified the original identity for reactivation. */
  allowAgent(agentId: string): void {
    agentIdSchema.parse(agentId);
    this.stoppingAgents.delete(agentId);
  }

  async execute(
    agentId: string,
    operationId: string,
    operationInput: unknown,
  ): Promise<AgentProcessOperationReceipt> {
    agentIdSchema.parse(agentId);
    operationIdSchema.parse(operationId);
    const operation = agentProcessOperationSchema.parse(operationInput),
      request = JSON.stringify({ agentId, operation }),
      requestHash = createHash("sha256").update(request).digest("hex");
    let row = this.database
      .transaction(() => {
        const old = this.findOperation.get(operationId) as OperationRow | undefined;
        if (old) {
          if (old.agent_id !== agentId || old.request_hash !== requestHash)
            throw new Error("Agent process operation identity conflict");
          return old;
        }
        this.insertOperation.run(
          operationId,
          agentId,
          requestHash,
          request,
          this.now(),
          this.now(),
        );
        return this.findOperation.get(operationId) as OperationRow;
      })
      .immediate();

    if (row.state !== "started") return Promise.resolve(toReceipt(row));
    const active = this.inFlight.get(operationId);
    if (active) return active;

    if (operation.kind !== "process.stop_all" && this.stoppingAgents.has(agentId)) {
      this.settleOperation.run(
        "failed",
        JSON.stringify({ reason: "agent_stopping" }),
        this.now(),
        operationId,
      );
      return toReceipt(this.findOperation.get(operationId) as OperationRow);
    }

    const admitted =
      operation.kind === "process.stop_all"
        ? [...this.inFlight.entries()]
            .filter(([id]) => (this.findOperation.get(id) as OperationRow).agent_id === agentId)
            .map(([, promise]) => promise)
        : [];
    if (operation.kind === "process.stop_all") this.stoppingAgents.add(agentId);

    const executeWithFence = async () => {
      const first = await this.executeHostOperation({ agentId, operationId, operation });
      if (
        operation.kind !== "process.stop_all" ||
        first.state !== "succeeded" ||
        admitted.length === 0
      )
        return first;
      // An already admitted command can start a process after the first stop pass. Its
      // completion is durable before the final pass, which closes that race.
      await Promise.allSettled(admitted);
      return this.executeHostOperation({ agentId, operationId, operation });
    };

    const execution = Promise.resolve()
      .then(executeWithFence)
      .then(
        (result) => {
          const receipt = JSON.stringify(result.receipt);
          if (
            this.settleOperation.run(result.state, receipt, this.now(), operationId).changes !== 1
          )
            throw new Error("Agent process operation lost its start record");
          row = this.findOperation.get(operationId) as OperationRow;
          return toReceipt(row);
        },
        () => {
          const receipt = JSON.stringify({ reason: "node_operation_result_unknown" });
          if (this.settleOperation.run("unknown", receipt, this.now(), operationId).changes !== 1)
            throw new Error("Agent process operation lost its start record");
          row = this.findOperation.get(operationId) as OperationRow;
          return toReceipt(row);
        },
      );
    this.inFlight.set(operationId, execution);
    const clear = () => {
      if (this.inFlight.get(operationId) === execution) this.inFlight.delete(operationId);
    };
    void execution.then(clear, clear);
    return execution;
  }
}

function toReceipt(row: OperationRow): AgentProcessOperationReceipt {
  return {
    operationId: row.operation_id,
    agentId: row.agent_id,
    state: row.state,
    receipt: row.receipt === null ? null : JSON.parse(row.receipt),
    revision: row.revision,
  };
}

/** Build one operation ID for a control-plane intent before it is sent to a node. */
export function newAgentProcessOperationId(): string {
  return randomUUID();
}
