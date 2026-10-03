import {
  agentProcessOperationSchema,
  MAX_NODE_RECEIPTS_PER_PAGE,
  NodeRequestIdSchema,
  type NodeRequest,
} from "@mate/protocol";
import { processOperationRequestHash } from "@mate/protocol/node";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NodeOperations } from "./operations.js";
import { reject, send, type NodeSocket, type SocketSession } from "./transport.js";
export class NodeReconciliation {
  private onReady?: () => void;
  constructor(
    private readonly database: Database.Database,
    private readonly operations: NodeOperations,
    private readonly isCurrent: (nodeId: string, socket: NodeSocket) => boolean,
  ) {}
  setReadyHandler(handler: () => void): void {
    this.onReady = handler;
  }
  startProcess(
    socket: NodeSocket,
    session: SocketSession,
    cursor: string,
    blocking: boolean,
  ): void {
    if (!session.nodeId || !this.isCurrent(session.nodeId, socket)) return;
    const nodeId = session.nodeId;
    const rows = z
      .looseObject({ operation_id: z.string(), agent_id: z.string(), request_json: z.string() })
      .array()
      .parse(
        this.database
          .prepare(
            `SELECT operation_id,agent_id,request_json FROM (
          SELECT operation_id,agent_id,request_json FROM owner_agent_process_operations
          WHERE node_id=? AND (? OR state IN ('executing','unknown'))
          UNION ALL
          SELECT operation_id,agent_id,'{"operation":{"kind":"process.stop_all"}}' AS request_json FROM owner_agent_stop_intents
          WHERE node_id=? AND state IN ('executing','unknown')
        ) WHERE operation_id>? ORDER BY operation_id LIMIT ?`,
          )
          .all(
            session.nodeId,
            blocking ? 1 : 0,
            session.nodeId,
            cursor,
            MAX_NODE_RECEIPTS_PER_PAGE,
          ),
      );
    if (rows.length === 0) {
      this.startWorkspaceReconciliation(socket, session, "", blocking);
      return;
    }
    // The current request owns its normal result until timeout or disconnect. A missing
    // receipt during that wait is not a recovery fact, just as for workspace operations.
    const validRows = rows.filter(
      (row) =>
        NodeRequestIdSchema.safeParse(row.operation_id).success &&
        !this.operations.hasPendingProcess(nodeId, row.agent_id, row.operation_id),
    );
    if (validRows.length === 0) {
      this.startProcess(socket, session, rows.at(-1)!.operation_id, blocking);
      return;
    }
    const requestId = randomUUID();
    session.reconcile = {
      requestId,
      operations: new Map(validRows.map((row) => [row.operation_id, row.agent_id])),
      cursor: rows.at(-1)!.operation_id,
      blocking,
    };
    send(socket, {
      type: "control.process.reconcile",
      requestId,
      operations: validRows.map((row) => {
        let requestHash = "unreadable";
        try {
          const operation = agentProcessOperationSchema.parse(
            JSON.parse(row.request_json).operation,
          );
          requestHash = processOperationRequestHash(row.agent_id, operation);
        } catch {
          /* Keep an unreadable intent unknown, even if a node has some result. */
        }
        return { operationId: row.operation_id, agentId: row.agent_id, requestHash };
      }),
    });
  }

  receiveProcess(
    socket: NodeSocket,
    session: SocketSession,
    request: Extract<NodeRequest, { type: "node.process.reconcile.result" }>,
  ): void {
    const pending = session.reconcile;
    if (
      !session.nodeId ||
      !this.isCurrent(session.nodeId, socket) ||
      !pending ||
      pending.requestId !== request.requestId
    )
      return reject(socket, request.requestId, "invalid_identity", "节点操作对账请求不匹配。");
    const conflicts = new Set<string>();
    const seen = new Set<string>();
    for (const receipt of request.receipts) {
      if (
        pending.operations.get(receipt.operationId) !== receipt.agentId ||
        seen.has(receipt.operationId)
      )
        conflicts.add(receipt.operationId);
      seen.add(receipt.operationId);
    }
    for (const receipt of request.receipts) {
      if (conflicts.has(receipt.operationId)) continue;
      const { revision, ...value } = receipt;
      this.operations.deliverProcessReceipt(session.nodeId, {
        ...value,
        ...(revision !== undefined ? { revision } : {}),
      });
    }
    for (const [operationId, agentId] of pending.operations) {
      if (seen.has(operationId) && !conflicts.has(operationId)) continue;
      this.operations.deliverProcessReceipt(session.nodeId, {
        operationId,
        agentId,
        state: "unknown",
        receipt: {
          reason: conflicts.has(operationId)
            ? "node_receipt_identity_conflict"
            : "no_durable_node_receipt",
        },
      });
    }
    delete session.reconcile;
    this.startProcess(socket, session, pending.cursor, pending.blocking);
  }

  private startWorkspaceReconciliation(
    socket: NodeSocket,
    session: SocketSession,
    cursor: string,
    blocking: boolean,
  ): void {
    if (!session.nodeId || !this.isCurrent(session.nodeId, socket)) return;
    if (
      !this.database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='owner_agent_tool_actions'",
        )
        .get()
    ) {
      if (blocking) {
        session.ready = true;
        this.onReady?.();
      }
      return;
    }
    const nodeId = session.nodeId;
    const rows = z
      .looseObject({
        operation_id: z.string(),
        agent_id: z.string(),
        request_hash: z.string().nullable(),
      })
      .array()
      .parse(
        this.database
          .prepare(
            `SELECT json_extract(CASE WHEN json_valid(action.result_json) THEN action.result_json ELSE '{}' END,'$.operationId') AS operation_id,
              action.agent_id, json_extract(CASE WHEN json_valid(action.result_json) THEN action.result_json ELSE '{}' END,'$.nodeRequestHash') AS request_hash
       FROM owner_agent_tool_actions action
       JOIN owner_agents agent ON agent.id=action.agent_id
       WHERE agent.node_id=? AND action.operation LIKE 'workspace.%'
         AND (? OR json_extract(CASE WHEN json_valid(action.result_json) THEN action.result_json ELSE '{}' END,'$.state') IN ('executing','unknown'))
         AND json_extract(CASE WHEN json_valid(action.result_json) THEN action.result_json ELSE '{}' END,'$.operationId')>?
       ORDER BY operation_id LIMIT ?`,
          )
          .all(session.nodeId, blocking ? 1 : 0, cursor, MAX_NODE_RECEIPTS_PER_PAGE),
      );
    if (rows.length === 0) {
      if (blocking) {
        session.ready = true;
        this.onReady?.();
      }
      return;
    }
    // A request still waiting on this connection owns its normal result. Missing terminal
    // evidence during that wait is not a recovery fact; timeout or disconnect releases it.
    const validRows = rows.filter(
      (row) =>
        NodeRequestIdSchema.safeParse(row.operation_id).success &&
        !this.operations.hasPendingWorkspace(nodeId, row.agent_id, row.operation_id),
    );
    if (validRows.length === 0) {
      this.startWorkspaceReconciliation(socket, session, rows.at(-1)!.operation_id, blocking);
      return;
    }
    const requestId = randomUUID();
    session.workspaceReconcile = {
      requestId,
      operations: new Map(validRows.map((row) => [row.operation_id, row.agent_id])),
      cursor: rows.at(-1)!.operation_id,
      blocking,
    };
    send(socket, {
      type: "control.workspace.reconcile",
      requestId,
      operations: validRows.map((row) => ({
        operationId: row.operation_id,
        agentId: row.agent_id,
        requestHash: row.request_hash ?? "unreadable",
      })),
    });
  }

  receiveWorkspace(
    socket: NodeSocket,
    session: SocketSession,
    request: Extract<NodeRequest, { type: "node.workspace.reconcile.result" }>,
  ): void {
    const pending = session.workspaceReconcile;
    if (
      !session.nodeId ||
      !this.isCurrent(session.nodeId, socket) ||
      !pending ||
      pending.requestId !== request.requestId
    )
      return reject(socket, request.requestId, "invalid_identity", "节点文件对账请求不匹配。");
    const conflicts = new Set<string>();
    const seen = new Set<string>();
    for (const receipt of request.receipts) {
      if (
        pending.operations.get(receipt.operationId) !== receipt.agentId ||
        seen.has(receipt.operationId)
      )
        conflicts.add(receipt.operationId);
      seen.add(receipt.operationId);
    }
    for (const receipt of request.receipts) {
      if (conflicts.has(receipt.operationId)) continue;
      this.operations.deliverWorkspaceOperationResult(session.nodeId, {
        type: "node.workspace.operation.result",
        requestId: request.requestId,
        operationId: receipt.operationId,
        agentId: receipt.agentId,
        ok: true,
        result: receipt.result,
      });
    }
    for (const [operationId, agentId] of pending.operations) {
      if (seen.has(operationId) && !conflicts.has(operationId)) continue;
      this.operations.deliverWorkspaceOperationResult(session.nodeId, {
        type: "node.workspace.operation.result",
        requestId: request.requestId,
        operationId,
        agentId,
        ok: false,
        error: conflicts.has(operationId)
          ? "Node receipt identity conflict; file operation result is unknown"
          : "No durable node receipt; file operation result is unknown",
      });
    }
    delete session.workspaceReconcile;
    this.startWorkspaceReconciliation(socket, session, pending.cursor, pending.blocking);
  }
}
