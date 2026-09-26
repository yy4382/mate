import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";

export const privilegedCommandSchema = z
  .object({
    requestId: z.string().uuid(),
    operationId: z.string().uuid(),
    agentId: z.string().uuid(),
    nodeId: z.string().uuid(),
    program: z.string().regex(/^\//).max(4096),
    args: z.array(z.string().max(16_000)).max(128),
    cwd: z.string().regex(/^\//).max(4096),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type PrivilegedCommand = z.infer<typeof privilegedCommandSchema>;
export interface PrivilegedGrant {
  command: PrivilegedCommand;
  signature: string;
}
export type ApprovalState =
  "pending" | "approved" | "running" | "succeeded" | "failed" | "unknown" | "rejected" | "expired";

export interface ApprovalView extends PrivilegedCommand {
  channelId: string;
  state: ApprovalState;
  receipt: unknown | null;
  createdAt: number;
}

interface ApprovalRow {
  request_id: string;
  operation_id: string;
  agent_id: string;
  node_id: string;
  channel_id: string;
  command_json: string;
  request_hash: string;
  state: ApprovalState;
  receipt_json: string | null;
  node_receipt_revision: number | null;
  created_at: number;
  started_at: number | null;
}

export interface PrivilegedNodePort {
  execute(
    nodeId: string,
    grant: PrivilegedGrant,
    onStarted?: (startedAt: number) => void,
  ): Promise<{
    state: "succeeded" | "failed" | "unknown";
    startedAt: number;
    receipt: unknown | null;
    revision?: number;
  }>;
}

export interface ApprovalEvent {
  agentId: string;
  nodeId: string;
  kind: string;
  referenceId: string;
  summary: string;
  detail?: unknown;
  at: number;
}

export const privilegedApprovalSchemaV20 = `
CREATE TABLE IF NOT EXISTS owner_privileged_approval_keys (
  id INTEGER PRIMARY KEY CHECK(id=1), private_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_privileged_approvals (
  request_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL, node_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  command_json TEXT NOT NULL, request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','approved','running','succeeded','failed','unknown','rejected','expired')),
  receipt_json TEXT, started_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS owner_privileged_approvals_channel
  ON owner_privileged_approvals(channel_id,created_at);
`;

/** The control plane alone decides approval; a node receives a signed, immutable grant. */
export class PrivilegedApprovals {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly privateKey: string;

  constructor(
    private readonly database: Database.Database,
    private readonly nodes: PrivilegedNodePort,
    private readonly now: () => number = Date.now,
    private readonly emit?: (event: ApprovalEvent) => void,
  ) {
    database.pragma("synchronous = FULL");
    database.exec(privilegedApprovalSchemaV20);
    let key = database
      .prepare("SELECT private_key FROM owner_privileged_approval_keys WHERE id=1")
      .get() as { private_key: string } | undefined;
    if (!key) {
      const pair = generateKeyPairSync("ed25519", {
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      database
        .prepare("INSERT OR IGNORE INTO owner_privileged_approval_keys(id,private_key) VALUES(1,?)")
        .run(pair.privateKey);
      key = database
        .prepare("SELECT private_key FROM owner_privileged_approval_keys WHERE id=1")
        .get() as { private_key: string };
    }
    this.privateKey = key.private_key;
  }

  get publicKey(): string {
    return createPublicKey(createPrivateKey(this.privateKey))
      .export({ type: "spki", format: "pem" })
      .toString();
  }

  request(
    input: Omit<PrivilegedCommand, "operationId" | "expiresAt"> & { channelId: string },
  ): ApprovalView {
    const { channelId: rawChannelId, ...details } = input;
    const command = privilegedCommandSchema.parse({
      ...details,
      operationId: input.requestId,
      expiresAt: this.now() + 600_000,
    });
    const channelId = z.string().uuid().parse(rawChannelId);
    const commandJson = JSON.stringify(command);
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          channelId,
          command: {
            ...command,
            expiresAt: 0,
          },
        }),
      )
      .digest("hex");
    return this.database
      .transaction(() => {
        const existing = this.row(command.requestId);
        if (existing) {
          if (existing.request_hash !== hash)
            throw new Error("Privileged request identity conflict");
          return this.view(existing);
        }
        this.database
          .prepare(
            `INSERT INTO owner_privileged_approvals(
        request_id,operation_id,agent_id,node_id,channel_id,command_json,request_hash,state,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,'pending',?,?)`,
          )
          .run(
            command.requestId,
            command.operationId,
            command.agentId,
            command.nodeId,
            channelId,
            commandJson,
            hash,
            this.now(),
            this.now(),
          );
        this.emit?.({
          agentId: command.agentId,
          nodeId: command.nodeId,
          kind: "approval.requested",
          referenceId: command.requestId,
          summary: "Agent 请求系统特权命令审批。",
          detail: { command, channelId },
          at: this.now(),
        });
        return this.view(this.row(command.requestId)!);
      })
      .immediate();
  }

  status(requestId: string): ApprovalView | undefined {
    z.string().uuid().parse(requestId);
    this.expire(requestId);
    const row = this.row(requestId);
    return row && this.view(row);
  }

  list(channelId: string): ApprovalView[] {
    z.string().uuid().parse(channelId);
    const rows = this.database
      .prepare(
        "SELECT request_id FROM owner_privileged_approvals WHERE channel_id=? ORDER BY created_at,request_id",
      )
      .all(channelId) as { request_id: string }[];
    return rows.map(({ request_id }) => this.status(request_id)!);
  }

  decide(requestId: string, decision: "approve" | "reject"): ApprovalView {
    const row = this.row(z.string().uuid().parse(requestId));
    if (!row) throw new Error("Privileged request not found");
    this.expire(requestId);
    const current = this.row(requestId)!;
    if (current.state !== "pending") return this.view(current);
    this.database
      .transaction(() => {
        this.database
          .prepare(
            "UPDATE owner_privileged_approvals SET state=?,updated_at=? WHERE request_id=? AND state='pending'",
          )
          .run(decision === "approve" ? "approved" : "rejected", this.now(), requestId);
        this.emit?.({
          agentId: current.agent_id,
          nodeId: current.node_id,
          kind: decision === "approve" ? "approval.approved" : "approval.rejected",
          referenceId: requestId,
          summary:
            decision === "approve" ? "特权命令已批准，等待节点执行。" : "特权命令已拒绝，未执行。",
          at: this.now(),
        });
      })
      .immediate();
    const updated = this.row(requestId)!;
    if (updated.state === "approved") void this.dispatch(requestId);
    return this.view(updated);
  }

  /** Retry a valid approval after reconnect; expired approval never reaches the node. */
  resume(): void {
    const rows = this.database
      .prepare("SELECT request_id FROM owner_privileged_approvals WHERE state='approved'")
      .all() as { request_id: string }[];
    for (const row of rows) {
      this.expire(row.request_id);
      if (this.row(row.request_id)?.state === "approved") void this.dispatch(row.request_id);
    }
  }

  reconcile(
    nodeId: string,
    requestId: string,
    outcome: {
      state: "succeeded" | "failed" | "unknown";
      startedAt: number;
      receipt: unknown | null;
    },
  ): boolean {
    const row = this.row(z.string().uuid().parse(requestId));
    if (
      !row ||
      row.node_id !== z.string().uuid().parse(nodeId) ||
      !["approved", "running", "unknown", "expired"].includes(row.state)
    )
      return false;
    const command = privilegedCommandSchema.parse(JSON.parse(row.command_json));
    // An expired card may be corrected only by this node's durable, pre-expiry start record.
    if (
      !Number.isSafeInteger(outcome.startedAt) ||
      outcome.startedAt < row.created_at ||
      outcome.startedAt >= command.expiresAt
    )
      return false;
    if (row.state === "unknown" && outcome.state === "unknown") return false;
    this.database
      .transaction(() => {
        this.database
          .prepare(
            `UPDATE owner_privileged_approvals SET state=?,receipt_json=?,updated_at=?
        WHERE request_id=? AND state IN ('approved','running','unknown','expired')`,
          )
          .run(
            outcome.state,
            outcome.receipt === null ? null : JSON.stringify(outcome.receipt),
            this.now(),
            requestId,
          );
        this.emit?.({
          agentId: row.agent_id,
          nodeId: row.node_id,
          kind:
            row.state === "unknown" || row.state === "expired"
              ? "receipt.corrected"
              : "operation.finished",
          referenceId: requestId,
          summary:
            outcome.state === "unknown"
              ? "特权命令执行结果未知。"
              : `特权命令结果已确认：${outcome.state === "succeeded" ? "成功" : "失败"}。`,
          detail: { state: outcome.state, startedAt: outcome.startedAt, receipt: outcome.receipt },
          at: this.now(),
        });
      })
      .immediate();
    return true;
  }

  private async dispatch(requestId: string): Promise<void> {
    if (this.inFlight.has(requestId)) return this.inFlight.get(requestId)!;
    const task = this.dispatchOnce(requestId);
    this.inFlight.set(requestId, task);
    void task.finally(() => this.inFlight.delete(requestId));
    return task;
  }

  private async dispatchOnce(requestId: string): Promise<void> {
    this.expire(requestId);
    const row = this.row(requestId);
    if (!row || row.state !== "approved") return;
    const command = privilegedCommandSchema.parse(JSON.parse(row.command_json));
    const grant = {
      command,
      signature: sign(null, Buffer.from(row.command_json), this.privateKey).toString("base64url"),
    };
    try {
      const outcome = await this.nodes.execute(row.node_id, grant, (startedAt) => {
        if (
          !Number.isSafeInteger(startedAt) ||
          startedAt < row.created_at ||
          startedAt >= command.expiresAt
        )
          return;
        this.database
          .transaction(() => {
            const changed = this.database
              .prepare(
                "UPDATE owner_privileged_approvals SET state='running',started_at=?,updated_at=? WHERE request_id=? AND state='approved'",
              )
              .run(startedAt, this.now(), requestId);
            if (changed.changes)
              this.emit?.({
                agentId: row.agent_id,
                nodeId: row.node_id,
                kind: "operation.started",
                referenceId: requestId,
                summary: "特权命令已进入节点执行边界。",
                at: this.now(),
              });
          })
          .immediate();
      });
      this.reconcile(row.node_id, requestId, outcome);
    } catch {
      const current = this.row(requestId);
      if (current?.state === "running" && current.started_at !== null)
        this.reconcile(row.node_id, requestId, {
          state: "unknown",
          startedAt: current.started_at,
          receipt: { reason: "node_response_unavailable" },
        });
    }
  }

  private expire(requestId: string): void {
    const row = this.row(requestId);
    if (!row || !["pending", "approved"].includes(row.state)) return;
    const command = privilegedCommandSchema.parse(JSON.parse(row.command_json));
    if (this.now() >= command.expiresAt)
      this.database
        .transaction(() => {
          const changed = this.database
            .prepare(
              "UPDATE owner_privileged_approvals SET state='expired',updated_at=? WHERE request_id=? AND state IN ('pending','approved')",
            )
            .run(this.now(), requestId);
          if (changed.changes)
            this.emit?.({
              agentId: row.agent_id,
              nodeId: row.node_id,
              kind: "approval.expired",
              referenceId: requestId,
              summary: "特权请求十分钟内未进入执行边界，未执行。",
              at: this.now(),
            });
        })
        .immediate();
  }

  private row(requestId: string): ApprovalRow | undefined {
    return this.database
      .prepare("SELECT * FROM owner_privileged_approvals WHERE request_id=?")
      .get(requestId) as ApprovalRow | undefined;
  }

  private view(row: ApprovalRow): ApprovalView {
    return {
      ...privilegedCommandSchema.parse(JSON.parse(row.command_json)),
      channelId: row.channel_id,
      state: row.state,
      receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json),
      createdAt: row.created_at,
    };
  }
}
