import { systemClock, type Clock } from "@mate/clock";
import type { JsonValue, ToolName, ToolResult } from "@mate/node-protocol";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  acceptNodeSocket,
  closeNodeSocket,
  sendGateway,
  type GatewayContext,
  type NodeSession,
} from "./connection.js";
import {
  offlineResult,
  PendingCalls,
  prepareWorkspaceOfflineResult,
  stoppedResult,
  unknownResult,
} from "./pending-calls.js";
import { createPairingToken, listNodes, openGatewayDatabase } from "./storage.js";

const DEFAULT_PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_UNAUTHENTICATED = 32;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 35_000;
const DEFAULT_TOOL_TIMEOUT_MS = 90_000;

export interface NodeGatewayOptions {
  dataDirectory: string;
  clock?: Clock;
  pairingTokenTtlMs?: number;
  maxUnauthenticated?: number | undefined;
  heartbeatTimeoutMs?: number;
  toolTimeoutMs?: number;
}

export interface RunToolRequest {
  requestId: string;
  tool: ToolName;
  arguments: Record<string, JsonValue>;
}

export interface NodeGateway {
  /** Run a workspace tool on the given node for the given agent. Never retries. */
  runTool(
    nodeId: string,
    agentId: string,
    req: RunToolRequest,
    onOutput: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<ToolResult>;

  /** Stop all in-flight tool calls for an agent on a node. */
  stopAgent(nodeId: string, agentId: string): void;

  /** Prepare a workspace on the node (create dir + MEMORY.md). */
  prepareWorkspace(nodeId: string, agentId: string): Promise<ToolResult>;

  /** Whether one node is online. */
  status(nodeId: string): NodeStatusResult;

  /** Every paired node and whether it is online. */
  nodes(): NodeStatusResult[];

  /** Create a pairing token, optionally scoped to a nodeId. */
  createPairingToken(nodeId?: string): { pairingToken: string; expiresAt: string };

  /** Mount onto an HTTP server's upgrade event. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;

  /** Close all connections and release resources. */
  close(): void;
}

export interface NodeStatusResult {
  nodeId: string;
  online: boolean;
  lastConnectedAt: string | null;
}

export function createNodeGateway(options: NodeGatewayOptions): NodeGateway {
  const clock = options.clock ?? systemClock;
  const now = () => clock.now();
  const pairingTokenTtlMs = options.pairingTokenTtlMs ?? DEFAULT_PAIRING_TOKEN_TTL_MS;
  const toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  const ctx: GatewayContext = {
    db: openGatewayDatabase(options.dataDirectory),
    clock,
    pending: new PendingCalls(clock),
    sessions: new WeakMap<WebSocket, NodeSession>(),
    connected: new Map<string, WebSocket>(),
    unauthenticated: new Set<WebSocket>(),
    maxUnauthenticated: options.maxUnauthenticated ?? DEFAULT_MAX_UNAUTHENTICATED,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
  };

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws: WebSocket) => acceptNodeSocket(ws, ctx));

  function statusOf(nodeId: string, lastConnectedAt: string | null): NodeStatusResult {
    return { nodeId, online: ctx.connected.has(nodeId), lastConnectedAt };
  }

  return {
    async runTool(nodeId, agentId, req, onOutput, signal) {
      const ws = ctx.connected.get(nodeId);
      if (ws === undefined) return offlineResult();
      if (signal.aborted) return unknownResult();

      const result = ctx.pending.add(
        req.requestId,
        ws,
        agentId,
        onOutput,
        toolTimeoutMs,
        unknownResult,
      );
      const abort = () => ctx.pending.settle(req.requestId, unknownResult());
      signal.addEventListener("abort", abort, { once: true });
      const sent = sendGateway(ws, {
        type: "gateway.run.tool",
        requestId: req.requestId,
        agentId,
        tool: req.tool,
        arguments: req.arguments,
      });
      if (!sent) ctx.pending.settle(req.requestId, unknownResult());

      try {
        return await result;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },

    stopAgent(nodeId, agentId) {
      const ws = ctx.connected.get(nodeId);
      if (ws === undefined) return;
      ctx.pending.settleForAgent(ws, agentId, stoppedResult);
      sendGateway(ws, { type: "gateway.stop.agent", requestId: randomUUID(), agentId });
    },

    async prepareWorkspace(nodeId, agentId) {
      const ws = ctx.connected.get(nodeId);
      if (ws === undefined) return prepareWorkspaceOfflineResult();

      const requestId = randomUUID();
      const result = ctx.pending.add(
        requestId,
        ws,
        agentId,
        () => {},
        toolTimeoutMs,
        prepareWorkspaceOfflineResult,
      );
      if (!sendGateway(ws, { type: "gateway.prepare.workspace", requestId, agentId })) {
        ctx.pending.settle(requestId, prepareWorkspaceOfflineResult());
      }
      return result;
    },

    status(nodeId) {
      const node = listNodes(ctx.db).find((n) => n.nodeId === nodeId);
      return statusOf(nodeId, node?.lastConnectedAt ?? null);
    },

    nodes() {
      return listNodes(ctx.db).map((n) => statusOf(n.nodeId, n.lastConnectedAt));
    },

    createPairingToken(nodeId) {
      return createPairingToken(ctx.db, now, pairingTokenTtlMs, nodeId);
    },

    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    },

    close() {
      for (const ws of wss.clients) {
        ws.terminate();
        closeNodeSocket(ws, ctx);
      }
      wss.close();
      ctx.db.close();
    },
  };
}
