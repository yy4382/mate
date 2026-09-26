import { createHash, verify } from "node:crypto";
import type Database from "better-sqlite3";
import {
  privilegedCommandSchema,
  type PrivilegedCommand,
  type PrivilegedGrant,
} from "../control-plane/privileged-approvals.js";

export interface PrivilegedReceipt {
  requestId: string;
  operationId: string;
  agentId: string;
  state: "started" | "succeeded" | "failed" | "unknown";
  startedAt: number;
  receipt: unknown | null;
  /** Monotonic version of this operation's durable node-local result. */
  revision: number;
}

interface Row {
  request_id: string;
  operation_id: string;
  agent_id: string;
  request_hash: string;
  state: PrivilegedReceipt["state"];
  receipt_json: string | null;
  started_at: number;
  revision: number;
}

/** Node-local root boundary: verify the grant, persist start, then call the sole root executor. */
export class PrivilegedNodeOperations {
  private readonly inFlight = new Map<string, Promise<PrivilegedReceipt>>();

  constructor(
    private readonly database: Database.Database,
    private readonly nodeId: string,
    private publicKey: string,
    private readonly executeRoot: (command: PrivilegedCommand) => Promise<unknown>,
    private readonly now: () => number = Date.now,
  ) {
    database.pragma("synchronous = FULL");
    database.exec(`CREATE TABLE IF NOT EXISTS node_privileged_operations (
      request_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL,
      request_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('started','succeeded','failed','unknown')),
      receipt_json TEXT, started_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );`);
    if (
      !database
        .prepare("PRAGMA table_info(node_privileged_operations)")
        .all()
        .some((column) => (column as { name: string }).name === "revision")
    )
      database.exec(
        "ALTER TABLE node_privileged_operations ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1)",
      );
    database
      .prepare(
        "UPDATE node_privileged_operations SET state='unknown',receipt_json=?,revision=revision+1,updated_at=? WHERE state='started'",
      )
      .run(JSON.stringify({ reason: "node_restarted_during_privileged_command" }), now());
  }

  status(requestId: string): PrivilegedReceipt | undefined {
    const row = this.row(requestId);
    return row && toReceipt(row);
  }

  receipts(after = "", limit = 100): PrivilegedReceipt[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM node_privileged_operations WHERE state IN ('succeeded','failed','unknown') AND request_id>? ORDER BY request_id LIMIT ?",
      )
      .all(after, limit) as Row[];
    return rows.map(toReceipt);
  }

  setPublicKey(publicKey: string): void {
    this.publicKey = publicKey;
  }

  execute(
    grant: PrivilegedGrant,
    onStarted?: (startedAt: number) => void,
  ): Promise<PrivilegedReceipt> {
    const command = privilegedCommandSchema.parse(grant.command);
    const requestJson = JSON.stringify(command);
    const hash = createHash("sha256").update(requestJson).digest("hex");
    if (command.nodeId !== this.nodeId) throw new Error("Privileged grant targets another node");
    if (
      !verify(
        null,
        Buffer.from(requestJson),
        this.publicKey,
        Buffer.from(grant.signature, "base64url"),
      )
    )
      throw new Error("Privileged grant signature is invalid");
    const old = this.row(command.requestId);
    if (old) {
      if (
        old.operation_id !== command.operationId ||
        old.agent_id !== command.agentId ||
        old.request_hash !== hash
      )
        throw new Error("Privileged operation identity conflict");
      const running = this.inFlight.get(command.requestId);
      return running ?? Promise.resolve(toReceipt(old));
    }
    const row = this.database
      .transaction(() => {
        const concurrent = this.row(command.requestId);
        if (concurrent) return concurrent;
        const startedAt = this.now();
        if (startedAt >= command.expiresAt)
          throw new Error("Privileged grant expired before start");
        this.database
          .prepare(
            `INSERT INTO node_privileged_operations(
        request_id,operation_id,agent_id,request_hash,state,started_at,created_at,updated_at
      ) VALUES(?,?,?,?,'started',?,?,?)`,
          )
          .run(
            command.requestId,
            command.operationId,
            command.agentId,
            hash,
            startedAt,
            startedAt,
            startedAt,
          );
        return this.row(command.requestId)!;
      })
      .immediate();
    if (row.state !== "started") return Promise.resolve(toReceipt(row));
    onStarted?.(row.started_at);
    const task = Promise.resolve()
      .then(() => this.executeRoot(command))
      .then(
        (receipt) =>
          this.settle(
            command,
            (receipt as { code?: number }).code === 0 ? "succeeded" : "failed",
            receipt,
          ),
        () => this.settle(command, "unknown", { reason: "privileged_result_unconfirmed" }),
      );
    this.inFlight.set(command.requestId, task);
    void task.finally(() => this.inFlight.delete(command.requestId));
    return task;
  }

  private settle(
    command: PrivilegedCommand,
    state: "succeeded" | "failed" | "unknown",
    receipt: unknown,
  ): PrivilegedReceipt {
    this.database
      .prepare(
        "UPDATE node_privileged_operations SET state=?,receipt_json=?,revision=revision+1,updated_at=? WHERE request_id=? AND state='started'",
      )
      .run(state, JSON.stringify(receipt), this.now(), command.requestId);
    return toReceipt(this.row(command.requestId)!);
  }

  private row(requestId: string): Row | undefined {
    return this.database
      .prepare("SELECT * FROM node_privileged_operations WHERE request_id=?")
      .get(requestId) as Row | undefined;
  }
}

function toReceipt(row: Row): PrivilegedReceipt {
  return {
    requestId: row.request_id,
    operationId: row.operation_id,
    agentId: row.agent_id,
    state: row.state,
    startedAt: row.started_at,
    receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json),
    revision: row.revision,
  };
}
