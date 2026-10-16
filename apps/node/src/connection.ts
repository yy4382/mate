import {
  GatewayMessageSchema,
  NodeRequestSchema,
  type GatewayMessage,
  type GatewayRunTool,
  type NodeRequest,
} from "@mate/node-protocol";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { signChallenge, type NodeIdentity } from "./identity.js";
import { executeToolCall, prepareWorkspaceDir, ProcessGroupTracker } from "./executor.js";

const INITIAL_RETRY_MS = 250;
const MAX_RETRY_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;

class NodeAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeAuthenticationError";
  }
}

export interface NodeOptions {
  controlPlaneUrl: string;
  dataDirectory: string;
  workspacesRoot: string;
  pairingToken?: string | undefined;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

export async function startNode(options: NodeOptions, signal: AbortSignal): Promise<void> {
  const wsUrl = toWebSocketUrl(options.controlPlaneUrl);
  const { identity, created } = await import("./identity.js").then((m) =>
    m.loadOrCreateNodeIdentity(options.dataDirectory),
  );

  let pairingToken = options.pairingToken;
  if (created && !pairingToken) {
    throw new Error("A new node requires a pairing token");
  }

  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;

  if (heartbeatTimeoutMs <= heartbeatIntervalMs) {
    throw new Error("heartbeatTimeoutMs must be greater than heartbeatIntervalMs");
  }

  const tracker = new ProcessGroupTracker();

  try {
    let retryMs = INITIAL_RETRY_MS;
    while (!signal.aborted) {
      try {
        await connectOnce(
          {
            url: wsUrl,
            identity,
            getPairingToken: () => pairingToken,
            clearPairingToken: () => {
              pairingToken = undefined;
            },
            heartbeatIntervalMs,
            heartbeatTimeoutMs,
            workspacesRoot: options.workspacesRoot,
            tracker,
          },
          signal,
        );
        retryMs = INITIAL_RETRY_MS;
      } catch (error) {
        if (error instanceof NodeAuthenticationError) throw error;
        if (signal.aborted) break;
      }
      if (!signal.aborted) await sleep(retryMs, signal);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    }
  } finally {
    tracker.killAll();
  }
}

interface ConnectionOptions {
  url: string;
  identity: NodeIdentity;
  getPairingToken: () => string | undefined;
  clearPairingToken: () => void;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  workspacesRoot: string;
  tracker: ProcessGroupTracker;
}

function connectOnce(opts: ConnectionOptions, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(opts.url);

    let authenticated = false;
    let pendingPing: string | undefined;
    let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
    let pingTimeout: ReturnType<typeof setTimeout> | undefined;
    let handshakeTimeout: ReturnType<typeof setTimeout> | undefined;
    let authRequestId: string | undefined;
    let pairRequestId: string | undefined;
    let challenge: string | undefined;

    // Per-agent abort controllers for in-flight tool calls
    const agentControllers = new Map<string, AbortController>();

    const cleanup = () => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (pingTimeout) clearTimeout(pingTimeout);
      if (handshakeTimeout) clearTimeout(handshakeTimeout);
      // Abort all running tool calls on disconnect
      for (const controller of agentControllers.values()) {
        controller.abort();
      }
      agentControllers.clear();
      socket.removeEventListener("error", onError);
    };

    const sendToGateway = (msg: NodeRequest) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(NodeRequestSchema.parse(msg)));
      }
    };

    const sendPing = () => {
      const requestId = randomUUID();
      pendingPing = requestId;
      sendToGateway({ type: "node.ping", requestId });
      pingTimeout = setTimeout(() => {
        if (pendingPing === requestId) {
          socket.terminate();
          cleanup();
          resolve();
        }
      }, opts.heartbeatTimeoutMs);
    };

    const authenticate = (nonce: string) => {
      authRequestId = randomUUID();
      sendToGateway({
        type: "node.authenticate",
        requestId: authRequestId,
        nodeId: opts.identity.id,
        signature: signChallenge(opts.identity, nonce),
      });
    };

    const pair = (nonce: string) => {
      const token = opts.getPairingToken();
      if (!token) {
        reject(new NodeAuthenticationError("Node not paired and no pairing token provided"));
        socket.close(1000, "no pairing token");
        return;
      }
      pairRequestId = randomUUID();
      sendToGateway({
        type: "node.pair",
        requestId: pairRequestId,
        nodeId: opts.identity.id,
        publicKey: opts.identity.publicKey,
        signature: signChallenge(opts.identity, nonce),
        pairingToken: token,
      });
    };

    const onAbort = () => {
      cleanup();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, "node shutting down");
      }
      resolve();
    };

    const onError = () => {
      // WebSocket errors always precede close; close handler drives retry
    };

    const onClose = () => {
      cleanup();
      if (!authenticated) {
        reject(new Error("WebSocket closed before authentication"));
      } else {
        resolve();
      }
    };

    const onMessage = (event: WebSocket.MessageEvent) => {
      void handleMessage(String(event.data)).catch((err: unknown) => {
        cleanup();
        reject(err instanceof Error ? err : new Error("message handling error"));
      });
    };

    const handleMessage = async (text: string): Promise<void> => {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new NodeAuthenticationError("invalid JSON from gateway");
      }
      const parsed = GatewayMessageSchema.safeParse(raw);
      if (!parsed.success) {
        throw new NodeAuthenticationError("invalid gateway message");
      }
      const msg = parsed.data;
      await dispatch(msg);
    };

    const dispatch = async (msg: GatewayMessage): Promise<void> => {
      if (msg.type === "gateway.challenge") {
        challenge = msg.nonce;
        authenticate(msg.nonce);
        handshakeTimeout = setTimeout(() => {
          reject(new Error("handshake timeout"));
          socket.close(1001, "handshake timeout");
        }, HANDSHAKE_TIMEOUT_MS);
        return;
      }

      if (msg.type === "gateway.error") {
        if (msg.code === "unknown_identity" && msg.requestId === authRequestId) {
          pair(challenge!);
          return;
        }
        throw new NodeAuthenticationError(
          `Gateway rejected authentication: ${msg.code} — ${msg.message}`,
        );
      }

      if (msg.type === "gateway.authenticated") {
        if (handshakeTimeout) {
          clearTimeout(handshakeTimeout);
          handshakeTimeout = undefined;
        }
        authenticated = true;
        sendPing();
        heartbeatInterval = setInterval(sendPing, opts.heartbeatIntervalMs);
        return;
      }

      if (msg.type === "gateway.paired") {
        if (handshakeTimeout) {
          clearTimeout(handshakeTimeout);
          handshakeTimeout = undefined;
        }
        opts.clearPairingToken();
        authenticated = true;
        sendPing();
        heartbeatInterval = setInterval(sendPing, opts.heartbeatIntervalMs);
        return;
      }

      if (msg.type === "gateway.pong") {
        if (pendingPing === msg.requestId) {
          pendingPing = undefined;
          if (pingTimeout) {
            clearTimeout(pingTimeout);
            pingTimeout = undefined;
          }
        }
        return;
      }

      if (msg.type === "gateway.run.tool") {
        void handleRunTool(msg);
        return;
      }

      if (msg.type === "gateway.stop.agent") {
        const ctrl = agentControllers.get(msg.agentId);
        if (ctrl) ctrl.abort();
        return;
      }

      if (msg.type === "gateway.prepare.workspace") {
        handlePrepareWorkspace(msg);
        return;
      }
    };

    const handleRunTool = async (msg: GatewayRunTool): Promise<void> => {
      let ctrl = agentControllers.get(msg.agentId);
      if (!ctrl) {
        ctrl = new AbortController();
        agentControllers.set(msg.agentId, ctrl);
      }

      // Also abort on top-level signal
      const combinedSignal = AbortSignal.any([signal, ctrl.signal]);

      const result = await executeToolCall(
        msg,
        opts.workspacesRoot,
        (chunk) => {
          sendToGateway({
            type: "node.tool.output",
            requestId: msg.requestId,
            chunk,
          });
        },
        combinedSignal,
        opts.tracker,
      );

      sendToGateway({
        type: "node.tool.result",
        requestId: msg.requestId,
        content: result.content,
        isError: result.isError,
      });
    };

    const handlePrepareWorkspace = (
      msg: Extract<GatewayMessage, { type: "gateway.prepare.workspace" }>,
    ): void => {
      try {
        prepareWorkspaceDir(opts.workspacesRoot, msg.agentId);
        sendToGateway({
          type: "node.tool.result",
          requestId: msg.requestId,
          content: [{ type: "text", text: "Workspace prepared." }],
          isError: false,
        });
      } catch (error) {
        sendToGateway({
          type: "node.tool.result",
          requestId: msg.requestId,
          content: [
            {
              type: "text",
              text: `Failed to prepare workspace: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        });
      }
    };

    signal.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
    socket.addEventListener("error", onError);
  });
}

function toWebSocketUrl(controlPlaneUrl: string): string {
  let url: URL;
  try {
    url = new URL(controlPlaneUrl);
  } catch {
    throw new Error("controlPlaneUrl must be a valid absolute URL");
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("controlPlaneUrl must use http, https, ws, or wss");
  }
  url.pathname = "/api/nodes/connect";
  return url.toString();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((res) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      res();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      res();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
