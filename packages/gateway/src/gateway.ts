import { systemClock, type Clock } from "@mate/clock";
import {
  GatewayBrowseSchema,
  GatewayPrepareWorkspaceSchema,
  GatewayRunToolSchema,
  type GatewayPrepareWorkspace,
  type GatewayRunTool,
  type JsonValue,
  type ToolName,
  type ToolResult,
} from "@mate/node-protocol";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  acceptNodeSocket,
  closeNodeSocket,
  MAX_MESSAGE_BYTES,
  sendGateway,
  type GatewayContext,
  type NodeSession,
} from "./connection.ts";
import {
  browseOffline,
  offlineResult,
  PendingCalls,
  stoppedResult,
  type BrowseOutcome,
} from "./pending-calls.ts";
import { createPairingToken, listNodes, openGatewayDatabase } from "./storage.ts";

const DEFAULT_PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_UNAUTHENTICATED = 32;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 35_000;

export interface NodeGatewayOptions {
  /** The control plane's data directory. The gateway keeps its node registry in the control store there. */
  dataDirectory: string;
  clock?: Clock;
  pairingTokenTtlMs?: number;
  maxUnauthenticated?: number | undefined;
  heartbeatTimeoutMs?: number;
}

export interface RunToolRequest {
  tool: ToolName;
  arguments: Record<string, JsonValue>;
}

export interface NodeGateway {
  /**
   * Run a workspace tool on the given node for the given agent, streaming its output. Never retries. Aborting `signal`
   * stops the call on the node and ends it at once with a stopped result. A call has no deadline: it ends when the
   * node answers, its connection is lost, or `signal` aborts.
   */
  runTool(
    nodeId: string,
    agentId: string,
    request: RunToolRequest,
    onOutput: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<ToolResult>;

  /** Create the Agent's workspace on the node with an empty MEMORY.md; repeating it changes nothing. */
  prepareWorkspace(nodeId: string, agentId: string): Promise<ToolResult>;

  /**
   * Read `path` in the Agent's workspace on the node without changing anything: a directory's entries or a file's
   * start. The node refuses a path that leaves the workspace. Answers `node-offline` at once when the node is not
   * connected, and when its connection is lost before it answers.
   */
  browse(nodeId: string, agentId: string, path: string): Promise<BrowseOutcome>;

  /** Whether one node is online. */
  status(nodeId: string): NodeStatusResult;

  /** Every paired node and whether it is online. */
  nodes(): NodeStatusResult[];

  /** Create a single-use pairing token for a new node. */
  createPairingToken(): { pairingToken: string; expiresAt: string };

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

  const ctx: GatewayContext = {
    db: openGatewayDatabase(options.dataDirectory),
    clock,
    pending: new PendingCalls<ToolResult>(),
    browsing: new PendingCalls<BrowseOutcome>(),
    sessions: new WeakMap<WebSocket, NodeSession>(),
    connected: new Map<string, WebSocket>(),
    unauthenticated: new Set<WebSocket>(),
    maxUnauthenticated: options.maxUnauthenticated ?? DEFAULT_MAX_UNAUTHENTICATED,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  wss.on("connection", (ws: WebSocket) => acceptNodeSocket(ws, ctx));

  function statusOf(nodeId: string, lastConnectedAt: string | null): NodeStatusResult {
    return { nodeId, online: ctx.connected.has(nodeId), lastConnectedAt };
  }

  /**
   * Send one request to a node and wait for its answer. The gateway picks the request ID, so calls from different
   * callers can never share one.
   */
  function request(
    ws: WebSocket,
    message: GatewayRunTool | GatewayPrepareWorkspace,
    onOutput: (chunk: string) => void,
  ): Promise<ToolResult> {
    const result = ctx.pending.add(message.requestId, ws, onOutput);
    if (!sendGateway(ws, message)) ctx.pending.settle(message.requestId, offlineResult());
    return result;
  }

  return {
    async runTool(nodeId, agentId, { tool, arguments: args }, onOutput, signal) {
      // Checked before anything is registered, so a call that cannot be sent leaves nothing behind.
      const message = GatewayRunToolSchema.parse({
        type: "gateway.run.tool",
        requestId: randomUUID(),
        agentId,
        tool,
        arguments: args,
      });
      const ws = ctx.connected.get(nodeId);
      if (ws === undefined) return offlineResult();
      if (signal.aborted) return stoppedResult();

      const { requestId } = message;
      const stop = () => {
        if (ctx.pending.settle(requestId, stoppedResult())) {
          sendGateway(ws, { type: "gateway.stop.tool", requestId });
        }
      };
      signal.addEventListener("abort", stop, { once: true });
      try {
        return await request(ws, message, onOutput);
      } finally {
        signal.removeEventListener("abort", stop);
      }
    },

    async prepareWorkspace(nodeId, agentId) {
      const message = GatewayPrepareWorkspaceSchema.parse({
        type: "gateway.prepare.workspace",
        requestId: randomUUID(),
        agentId,
      });
      const ws = ctx.connected.get(nodeId);
      if (ws === undefined) return offlineResult();
      return request(ws, message, () => {});
    },

    async browse(nodeId, agentId, path) {
      const message = GatewayBrowseSchema.parse({
        type: "gateway.browse",
        requestId: randomUUID(),
        agentId,
        path,
      });
      const offline = browseOffline("Node offline: the node is not currently connected.");
      const ws = ctx.connected.get(nodeId);
      if (ws === undefined) return offline;
      const answer = ctx.browsing.add(message.requestId, ws);
      if (!sendGateway(ws, message)) ctx.browsing.settle(message.requestId, offline);
      return answer;
    },

    status(nodeId) {
      const node = listNodes(ctx.db).find((n) => n.nodeId === nodeId);
      return statusOf(nodeId, node?.lastConnectedAt ?? null);
    },

    nodes() {
      return listNodes(ctx.db).map((n) => statusOf(n.nodeId, n.lastConnectedAt));
    },

    createPairingToken() {
      return createPairingToken(ctx.db, now, pairingTokenTtlMs);
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
